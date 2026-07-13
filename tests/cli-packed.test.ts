import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distCli = path.join(repoRoot, 'dist', 'cli.cjs');

describe('packed CLI executable', () => {
  let installRoot = '';
  let binPath = '';

  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe' });
    expect(existsSync(distCli)).toBe(true);

    installRoot = mkdtempSync(path.join(tmpdir(), 'smoke-flow-cli-pack-'));
    const packDir = mkdtempSync(path.join(tmpdir(), 'smoke-flow-cli-tgz-'));
    const packOutput = execFileSync('npm', ['pack', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const packed = JSON.parse(packOutput) as Array<{ filename: string }>;
    const tarball = path.join(repoRoot, packed[0]!.filename);
    try {
      execFileSync('npm', ['install', '--ignore-scripts', tarball], {
        cwd: installRoot,
        stdio: 'pipe'
      });
    } finally {
      rmSync(tarball, { force: true });
      rmSync(packDir, { recursive: true, force: true });
    }

    binPath = path.join(installRoot, 'node_modules', '.bin', 'postman-smoke-flow');
  }, 120_000);

  afterAll(() => {
    if (installRoot) {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  it('ships dist/cli.cjs with a node shebang and executable mode', () => {
    const firstLine = readFileSync(distCli, 'utf8').split('\n')[0] ?? '';
    expect(firstLine).toBe('#!/usr/bin/env node');
    expect(statSync(distCli).mode & 0o111).toBeGreaterThan(0);
  });

  it('runs --help and --version from a packed install without side effects', () => {
    expect(existsSync(binPath)).toBe(true);

    const cleanEnv = { ...process.env };
    delete cleanEnv.VITEST;
    delete cleanEnv.VITEST_WORKER_ID;
    delete cleanEnv.VITEST_POOL_ID;

    const help = spawnSync(binPath, ['--help'], {
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

    const version = spawnSync(binPath, ['--version'], {
      encoding: 'utf8',
      env: {
        ...cleanEnv,
        INPUT_POSTMAN_API_KEY: 'should-not-be-used'
      }
    });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(version.stderr).toBe('');
  });
});
