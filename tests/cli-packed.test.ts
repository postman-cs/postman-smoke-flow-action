import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distCli = path.join(repoRoot, 'dist', 'cli.cjs');
const packagingSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');

describe('packed CLI executable', () => {
  let installRoot = '';
  let binPath = '';

  beforeAll(() => {
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

  it('does not rebuild dist from packaging tests', () => {
    const executableLines = packagingSource
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:\/\/|expect\(|it\(|describe\()/.test(line))
      .join('\n');
    expect(executableLines).not.toMatch(/\bnpm run (?:build|bundle)\b/);
    expect(executableLines).not.toMatch(/\besbuild\b/);
    expect(executableLines).not.toMatch(/rm -rf dist/);
  });

  it('ships dist/cli.cjs with a node shebang, disk exec bit, and git-index 100755', () => {
    const firstLine = readFileSync(distCli, 'utf8').split('\n')[0] ?? '';
    expect(firstLine).toBe('#!/usr/bin/env node');
    expect(statSync(distCli).mode & 0o111).toBeGreaterThan(0);

    const staged = execFileSync('git', ['ls-files', '--stage', '--', 'dist/cli.cjs'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    expect(staged).toMatch(/^100755 /);
  });

  it('runs ./dist/cli.cjs --help/--version directly without credentials or writes', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const sandbox = mkdtempSync(path.join(tmpdir(), 'smoke-flow-cli-direct-'));
    try {
      const env = {
        PATH: process.env.PATH ?? '',
        INPUT_POSTMAN_API_KEY: 'should-not-be-used',
        POSTMAN_API_KEY: 'should-not-be-used',
        POSTMAN_ACCESS_TOKEN: 'should-not-be-used',
        INPUT_POSTMAN_ACCESS_TOKEN: 'should-not-be-used',
        HOME: sandbox,
        TMPDIR: sandbox
      };

      const help = spawnSync(distCli, ['--help'], { encoding: 'utf8', cwd: sandbox, env });
      expect(help.status).toBe(0);
      expect(help.stdout).toMatch(/Usage: postman-smoke-flow/);
      expect(help.stderr).not.toMatch(/permission denied|exec format|syntax error|unexpected token|"use strict"/i);

      const version = spawnSync(distCli, ['--version'], { encoding: 'utf8', cwd: sandbox, env });
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe(packageJson.version);
      expect(version.stderr).toBe('');

      const written = execFileSync('find', [sandbox, '-type', 'f'], { encoding: 'utf8' }).trim();
      expect(written).toBe('');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
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
