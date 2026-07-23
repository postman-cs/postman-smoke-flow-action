import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  access,
  constants,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmCliArgs = process.platform === 'win32' ? [process.env.npm_execpath || ''] : [];
const distCli = path.join(repoRoot, 'dist', 'cli.cjs');
const packagingSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
const tempDirs: string[] = [];

const EXPECTED_PACKAGE_NAME = '@postman-cse/onboarding-smoke-flow';
const EXPECTED_BIN_NAME = 'postman-smoke-flow';
const EXPECTED_PACK_CENSUS = [
  'action.yml',
  'dist/cli.cjs',
  'dist/main.cjs',
  'README.md',
  'scripts/verify-release-artifacts.mjs'
] as const;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type PackStrategy = 'posix-install' | 'win32-native-shim';

function resolvePackStrategy(platform: NodeJS.Platform = process.platform): PackStrategy {
  return platform === 'win32' ? 'win32-native-shim' : 'posix-install';
}

type PlannedCommand = Readonly<{ file: string; args: readonly string[] }>;

type PackedPackageMeta = {
  name: string;
  version: string;
  binName: string;
  binTarget: string;
};

type Win32NativeShimPlan = {
  strategy: 'win32-native-shim';
  plannedCommands: PlannedCommand[];
  extractRoot: string;
  proxyRoot: string;
  tarballPath: string;
  packageRoot: string;
  installedPackageDir: string;
  cmdShimPath: string;
  cliPath: string;
  meta: PackedPackageMeta;
};

const CMD_UNSAFE_CHARS = /[\r\n"%!^&|<>]/;
const SAFE_PACKAGE_NAME = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/;
const SAFE_BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FIXED_NATIVE_CMD_ARGS = new Set(['--help', '--version']);

function assertPathInsideRoot(candidate: string, root: string, label: string): string {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes root: ${resolvedCandidate} not under ${resolvedRoot}`);
  }
  return resolvedCandidate;
}

function assertNoCmdMetacharacters(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
  if (CMD_UNSAFE_CHARS.test(value)) {
    throw new Error(`${label} contains unsafe cmd metacharacters`);
  }
  return value;
}

function assertSafePackageName(name: string): string {
  assertNoCmdMetacharacters(name, 'package name');
  if (!SAFE_PACKAGE_NAME.test(name)) {
    throw new Error(`unsafe package-name syntax: ${name}`);
  }
  return name;
}

function assertSafeBinName(binName: string): string {
  assertNoCmdMetacharacters(binName, 'bin name');
  if (!SAFE_BIN_NAME.test(binName)) {
    throw new Error(`unsafe bin-name syntax: ${binName}`);
  }
  return binName;
}

function assertSafeBinTarget(binTarget: string): string {
  assertNoCmdMetacharacters(binTarget, 'bin target');
  const normalized = binTarget.replace(/\\/g, '/');
  if (
    path.isAbsolute(binTarget) ||
    path.win32.isAbsolute(binTarget) ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').includes('..') ||
    normalized.startsWith('~')
  ) {
    throw new Error(`bin target must be a relative path without ..: ${binTarget}`);
  }
  return binTarget;
}

function quoteCmdArg(value: string): string {
  // Reject rather than silently strip quotes or other cmd metacharacters.
  assertNoCmdMetacharacters(value, 'cmd arg');
  return `"${value}"`;
}

function resolveComSpec(): string {
  return process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
}

function planNativeCmdInvocation(cmdShimPath: string, args: readonly string[]): PlannedCommand {
  assertNoCmdMetacharacters(cmdShimPath, 'cmdShimPath');
  for (const arg of args) {
    if (!FIXED_NATIVE_CMD_ARGS.has(arg)) {
      throw new Error(`native cmd arg not allowed: ${arg}`);
    }
    assertNoCmdMetacharacters(arg, 'cmd arg');
  }
  const commandPayload = [quoteCmdArg(cmdShimPath), ...args.map((arg) => quoteCmdArg(arg))].join(' ');
  // Node's Windows shell contract: ComSpec /d /s /c "<command>", with the payload quoted.
  return {
    file: resolveComSpec(),
    args: ['/d', '/s', '/c', `"${commandPayload}"`]
  };
}

function packageDirSegments(packageName: string): string[] {
  assertSafePackageName(packageName);
  return packageName.startsWith('@') ? packageName.split('/') : [packageName];
}

function resolveBinEntry(
  bin: string | Record<string, string> | undefined,
  packageName: string
): { binName: string; binTarget: string } {
  assertSafePackageName(packageName);
  if (typeof bin === 'string') {
    const binName = packageName.includes('/') ? packageName.split('/')[1]! : packageName;
    return {
      binName: assertSafeBinName(binName),
      binTarget: assertSafeBinTarget(bin)
    };
  }
  if (!bin || typeof bin !== 'object') {
    throw new Error('packed package.json is missing a bin entry');
  }
  const entries = Object.entries(bin);
  expect(entries.length).toBeGreaterThan(0);
  const [binName, binTarget] = entries[0]!;
  return {
    binName: assertSafeBinName(binName),
    binTarget: assertSafeBinTarget(binTarget)
  };
}

async function npmPackJson(packDir: string): Promise<{ filename: string; name: string; files: Array<{ path: string }> }> {
  const packResult = await execFileAsync(
    npmCommand,
    [...npmCliArgs, 'pack', '--json', '--pack-destination', packDir],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        NPM_CONFIG_CACHE: path.join(packDir, '.npm-cache'),
        PATH: process.env.PATH ?? ''
      },
      maxBuffer: 20 * 1024 * 1024
    }
  );
  const [packed] = JSON.parse(packResult.stdout) as Array<{
    filename: string;
    name: string;
    files: Array<{ path: string }>;
  }>;
  expect(packed.name).toBe(EXPECTED_PACKAGE_NAME);
  const tarballPath = path.join(packDir, packed.filename);
  await access(tarballPath, constants.F_OK);
  return packed;
}

function assertPackedCensus(files: Array<{ path: string }>): void {
  const filePaths = new Set(files.map((file) => file.path));
  for (const required of EXPECTED_PACK_CENSUS) {
    expect(filePaths.has(required), `npm pack must include ${required}`).toBe(true);
  }
}

async function extractPackedTarball(tarballPath: string, extractRoot: string): Promise<string> {
  await mkdir(extractRoot, { recursive: true });
  await execFileAsync('tar', ['-xzf', tarballPath, '-C', extractRoot], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  return path.join(extractRoot, 'package');
}

async function readPackedMeta(packageRoot: string): Promise<PackedPackageMeta> {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    bin?: string | Record<string, string>;
  };
  const { binName, binTarget } = resolveBinEntry(packageJson.bin, packageJson.name);
  return {
    name: packageJson.name,
    version: packageJson.version,
    binName,
    binTarget
  };
}

function planWin32NativeShim(args: {
  extractRoot: string;
  proxyRoot: string;
  tarballPath: string;
  meta: PackedPackageMeta;
}): Win32NativeShimPlan {
  assertSafePackageName(args.meta.name);
  assertSafeBinName(args.meta.binName);
  assertSafeBinTarget(args.meta.binTarget);
  assertNoCmdMetacharacters(args.extractRoot, 'extractRoot');
  assertNoCmdMetacharacters(args.proxyRoot, 'proxyRoot');
  assertNoCmdMetacharacters(args.tarballPath, 'tarballPath');

  const packageRoot = path.join(args.extractRoot, 'package');
  const installedPackageDir = path.join(args.proxyRoot, 'node_modules', ...packageDirSegments(args.meta.name));
  const binDir = path.join(args.proxyRoot, 'node_modules', '.bin');
  const cmdShimPath = path.join(binDir, `${args.meta.binName}.cmd`);
  const cliPath = path.join(installedPackageDir, args.meta.binTarget);

  assertPathInsideRoot(packageRoot, args.extractRoot, 'packageRoot');
  assertPathInsideRoot(installedPackageDir, args.proxyRoot, 'installedPackageDir');
  assertPathInsideRoot(cmdShimPath, args.proxyRoot, 'cmdShimPath');
  assertPathInsideRoot(cliPath, args.proxyRoot, 'cliPath');
  assertNoCmdMetacharacters(cmdShimPath, 'cmdShimPath');
  assertNoCmdMetacharacters(cliPath, 'cliPath');

  const plannedCommands: PlannedCommand[] = [
    { file: npmCommand, args: [...npmCliArgs, 'pack', '--json', '--pack-destination', path.dirname(args.tarballPath)] },
    { file: 'tar', args: ['-xzf', args.tarballPath, '-C', args.extractRoot] },
    planNativeCmdInvocation(cmdShimPath, ['--help']),
    planNativeCmdInvocation(cmdShimPath, ['--version'])
  ];

  for (const command of plannedCommands) {
    expect(command.file).not.toMatch(/install/i);
    expect(command.args.join(' ')).not.toMatch(/(?:^|\s)install(?:\s|$)/i);
  }

  return {
    strategy: 'win32-native-shim',
    plannedCommands,
    extractRoot: args.extractRoot,
    proxyRoot: args.proxyRoot,
    tarballPath: args.tarballPath,
    packageRoot,
    installedPackageDir,
    cmdShimPath,
    cliPath,
    meta: args.meta
  };
}

async function materializeWin32NativeShim(plan: Win32NativeShimPlan): Promise<void> {
  await mkdir(path.dirname(plan.installedPackageDir), { recursive: true });
  await cp(plan.packageRoot, plan.installedPackageDir, { recursive: true });
  await mkdir(path.dirname(plan.cmdShimPath), { recursive: true });

  const cliPath = assertPathInsideRoot(plan.cliPath, plan.proxyRoot, 'cliPath');
  const body = ['@ECHO off', `${quoteCmdArg(process.execPath)} ${quoteCmdArg(cliPath)} %*`, ''].join('\r\n');
  await writeFile(plan.cmdShimPath, body, 'utf8');
}

async function executeNativeCmd(
  cmdShimPath: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const planned = planNativeCmdInvocation(cmdShimPath, args);
  const result = spawnSync(planned.file, [...planned.args], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    env: {
      PATH: process.env.PATH ?? '',
      INPUT_POSTMAN_API_KEY: '',
      POSTMAN_API_KEY: '',
      POSTMAN_ACCESS_TOKEN: '',
      INPUT_POSTMAN_ACCESS_TOKEN: ''
    },
    timeout: 20_000,
    maxBuffer: 1024 * 1024
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status
  };
}

async function runPosixInstallPackaging(): Promise<{ binPath: string; version: string }> {
  const packDir = await makeTempDir('smoke-flow-cli-tgz-');
  const installRoot = await makeTempDir('smoke-flow-cli-pack-');

  const packed = await npmPackJson(packDir);
  assertPackedCensus(packed.files);
  const tarballPath = path.join(packDir, packed.filename);

  await execFileAsync(npmCommand, [...npmCliArgs, 'install', '--ignore-scripts', tarballPath], {
    cwd: installRoot,
    encoding: 'utf8',
    env: {
      NPM_CONFIG_CACHE: path.join(packDir, '.npm-cache'),
      PATH: process.env.PATH ?? ''
    },
    maxBuffer: 20 * 1024 * 1024
  });

  const binPath = path.join(
    installRoot,
    'node_modules',
    '@postman-cse',
    'onboarding-smoke-flow',
    'dist',
    'cli.cjs'
  );
  await access(binPath, constants.F_OK);
  const meta = await readPackedMeta(path.dirname(path.dirname(binPath)));
  return { binPath, version: meta.version };
}

async function runWin32NativeShimPackaging(options: { executeCmd: boolean }): Promise<Win32NativeShimPlan> {
  const packDir = await makeTempDir('smoke-flow-cli-tgz-');
  const extractRoot = await makeTempDir('smoke-flow-cli-extract-');
  const proxyRoot = await makeTempDir('smoke-flow-cli-proxy-');

  const packed = await npmPackJson(packDir);
  assertPackedCensus(packed.files);
  const tarballPath = path.join(packDir, packed.filename);

  const packageRoot = await extractPackedTarball(tarballPath, extractRoot);
  const meta = await readPackedMeta(packageRoot);
  expect(meta.name).toBe(EXPECTED_PACKAGE_NAME);
  expect(meta.binName).toBe(EXPECTED_BIN_NAME);
  expect(meta.binTarget.replace(/\\/g, '/')).toBe('dist/cli.cjs');

  const plan = planWin32NativeShim({ extractRoot, proxyRoot, tarballPath, meta });
  expect(plan.strategy).toBe('win32-native-shim');
  expect(plan.plannedCommands.some((command) => command.args.includes('install'))).toBe(false);

  await materializeWin32NativeShim(plan);
  await access(plan.cliPath, constants.F_OK);

  if (options.executeCmd) {
    const help = await executeNativeCmd(plan.cmdShimPath, ['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/Usage: postman-smoke-flow/);
    expect(help.stderr).not.toMatch(/permission denied|exec format|syntax error|unexpected token|"use strict"/i);

    const version = await executeNativeCmd(plan.cmdShimPath, ['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(meta.version);
    expect(version.stderr).toBe('');
  }

  return plan;
}

describe('packed CLI executable', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('does not rebuild dist from packaging tests', () => {
    const executableLines = packagingSource
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:\/\/|expect\(|it\(|describe\()/.test(line))
      .join('\n');
    expect(executableLines).not.toMatch(/\bnpm run (?:build|bundle)\b/);
    expect(executableLines).not.toMatch(/\besbuild\b/);
    expect(executableLines).not.toMatch(/rm -rf dist/);
  });

  it('ships dist/cli.cjs with a node shebang, disk exec bit, and git-index 100755', async () => {
    const firstLine = (await readFile(distCli, 'utf8')).split('\n')[0] ?? '';
    expect(firstLine).toBe('#!/usr/bin/env node');
    if (process.platform !== 'win32') {
      expect((await stat(distCli)).mode & 0o111).toBeGreaterThan(0);
    }

    const staged = await execFileAsync('git', ['ls-files', '--stage', '--', 'dist/cli.cjs'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    expect(staged.stdout).toMatch(/^100755 /);
  });

  it('runs ./dist/cli.cjs --help/--version directly without credentials or writes', async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const sandbox = await makeTempDir('smoke-flow-cli-direct-');
    const env = {
      PATH: process.env.PATH ?? '',
      INPUT_POSTMAN_API_KEY: 'should-not-be-used',
      POSTMAN_API_KEY: 'should-not-be-used',
      POSTMAN_ACCESS_TOKEN: 'should-not-be-used',
      INPUT_POSTMAN_ACCESS_TOKEN: 'should-not-be-used',
      HOME: sandbox,
      TMPDIR: sandbox
    };

    const help = spawnSync(process.execPath, [distCli, '--help'], { encoding: 'utf8', cwd: sandbox, env });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/Usage: postman-smoke-flow/);
    expect(help.stderr).not.toMatch(/permission denied|exec format|syntax error|unexpected token|"use strict"/i);

    const version = spawnSync(process.execPath, [distCli, '--version'], { encoding: 'utf8', cwd: sandbox, env });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(packageJson.version);
    expect(version.stderr).toBe('');

    await expect(readdir(sandbox, { recursive: true })).resolves.toEqual([]);
  });

  it(
    'runs --help and --version from a packed install without side effects',
    async () => {
      const strategy = resolvePackStrategy();
      if (strategy === 'posix-install') {
        const { binPath, version: packedVersion } = await runPosixInstallPackaging();
        await access(binPath, constants.F_OK);

        const cleanEnv = { ...process.env };
        delete cleanEnv.VITEST;
        delete cleanEnv.VITEST_WORKER_ID;
        delete cleanEnv.VITEST_POOL_ID;

        const help = spawnSync(process.execPath, [binPath, '--help'], {
          encoding: 'utf8',
          env: {
            ...cleanEnv,
            INPUT_POSTMAN_API_KEY: 'should-not-be-used',
            POSTMAN_ACCESS_TOKEN: 'should-not-be-used'
          }
        });
        expect(help.status).toBe(0);
        expect(help.stdout).toMatch(/Usage: postman-smoke-flow/);
        expect(help.stderr).toBe('');

        const version = spawnSync(process.execPath, [binPath, '--version'], {
          encoding: 'utf8',
          env: {
            ...cleanEnv,
            INPUT_POSTMAN_API_KEY: 'should-not-be-used'
          }
        });
        expect(version.status).toBe(0);
        expect(version.stdout.trim()).toBe(packedVersion);
        expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
        expect(version.stderr).toBe('');
      } else {
        await runWin32NativeShimPackaging({ executeCmd: true });
      }
    },
    120_000
  );

  it('selects posix install off Windows and win32 native shim on Windows', () => {
    expect(resolvePackStrategy('linux')).toBe('posix-install');
    expect(resolvePackStrategy('darwin')).toBe('posix-install');
    expect(resolvePackStrategy('win32')).toBe('win32-native-shim');
    expect(resolvePackStrategy()).toBe(process.platform === 'win32' ? 'win32-native-shim' : 'posix-install');
  });

  it(
    'Linux-local win32 strategy plans a native .cmd seam with no npm install',
    async () => {
      // Explicitly target win32 even on Linux/macOS so the command plan is proven here.
      expect(resolvePackStrategy('win32')).toBe('win32-native-shim');
      const plan = await runWin32NativeShimPackaging({ executeCmd: process.platform === 'win32' });
      expect(plan.strategy).toBe('win32-native-shim');
      expect(plan.plannedCommands.map((command) => [command.file, ...command.args].join(' ')).join('\n')).not.toMatch(
        /(?:^|\s)(?:npm(?:\.cmd)?\s+)?install(?:\s|$)/i
      );
      for (const command of plan.plannedCommands) {
        expect(command.args).not.toContain('install');
        expect(command.file.toLowerCase()).not.toContain('install');
      }
      expect(plan.cmdShimPath.endsWith(`${path.sep}${EXPECTED_BIN_NAME}.cmd`)).toBe(true);
      await access(plan.cmdShimPath, constants.F_OK);
      const shimBody = await readFile(plan.cmdShimPath, 'utf8');
      expect(shimBody).toContain(quoteCmdArg(plan.cliPath));
      expect(shimBody).toMatch(/\.cmd|\.cjs|node/i);

      // Temp pack destination must receive the tarball (not the repo root).
      expect(plan.tarballPath.startsWith(path.resolve(tmpdir()))).toBe(true);
      await access(plan.tarballPath, constants.F_OK);
      expect(path.dirname(plan.tarballPath)).not.toBe(repoRoot);
    },
    60_000
  );

  it('rejects malicious bin metadata and path tokens before spawn', () => {
    expect(() => assertSafeBinName('evil&whoami')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('evil|calc')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('x%PATH%')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('x!var!')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('x^y')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('x<y')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('x>y')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('quoted"name')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('line\rname')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('line\nname')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinTarget('dist/cli.cjs&calc')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinTarget('../escape.cjs')).toThrow(/relative path/);
    expect(() => assertSafeBinTarget('/abs/cli.cjs')).toThrow(/relative path/);
    expect(() => assertSafePackageName('@scope/evil&name')).toThrow(/unsafe cmd metacharacters/);
    expect(() => quoteCmdArg('has"quote')).toThrow(/unsafe cmd metacharacters/);
    expect(() => planNativeCmdInvocation('C:\\safe\\bin.cmd', ['--help&whoami'])).toThrow(/not allowed/);
    expect(() => planNativeCmdInvocation('C:\\safe\\bin&evil.cmd', ['--help'])).toThrow(/unsafe cmd metacharacters/);

    const extractRoot = path.join(tmpdir(), 'safe-extract');
    const proxyRoot = path.join(tmpdir(), 'safe-proxy');
    expect(() =>
      planWin32NativeShim({
        extractRoot,
        proxyRoot,
        tarballPath: path.join(extractRoot, 'pkg.tgz'),
        meta: {
          name: EXPECTED_PACKAGE_NAME,
          version: '0.0.0',
          binName: 'postman&smoke',
          binTarget: 'dist/cli.cjs'
        }
      })
    ).toThrow(/unsafe cmd metacharacters/);
  });

  it('plans a quoted cmd.exe invocation for safe metadata without shell true', () => {
    const safeShim = path.join(tmpdir(), 'proxy', 'node_modules', '.bin', `${EXPECTED_BIN_NAME}.cmd`);
    const planned = planNativeCmdInvocation(safeShim, ['--help']);
    const commandPayload = [quoteCmdArg(safeShim), quoteCmdArg('--help')].join(' ');
    expect(planned.file).toBe(process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe');
    expect(planned.args).toEqual(['/d', '/s', '/c', `"${commandPayload}"`]);
    expect(planned.args[3]).toContain(quoteCmdArg(safeShim));
    expect(planned.args[3]).toContain(quoteCmdArg('--help'));
    expect(planned.args.join(' ')).not.toMatch(/\beval\b/);
  });

  it('keeps native shim execution source free of shell true', () => {
    // Build the forbidden token at runtime so this assertion text cannot self-match.
    const shellTrue = ['shell', 'true'].join(': ');
    expect(packagingSource.includes(shellTrue)).toBe(false);
    expect(packagingSource).not.toMatch(/shell\s*:\s*true/);
    expect(packagingSource).toMatch(/windowsVerbatimArguments:\s*true/);
    expect(packagingSource).toMatch(/timeout:\s*20_000/);
  });
});
