import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli.js';
import { runAction } from '../src/index.js';
import { activateWorkingDirectory } from '../src/lib/working-directory.js';
import type { CoreLike } from '../src/types.js';

let originalCwd: string;
let originalWorkspace: string | undefined;
const tempDirs: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'smoke-flow-working-directory-'));
  tempDirs.push(root);
  mkdirSync(path.join(root, 'services', 'payments'), { recursive: true });
  return root;
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalWorkspace = process.env.GITHUB_WORKSPACE;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalWorkspace === undefined) {
    delete process.env.GITHUB_WORKSPACE;
  } else {
    process.env.GITHUB_WORKSPACE = originalWorkspace;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('activateWorkingDirectory', () => {
  it('is a no-op for an empty input', () => {
    const root = makeRoot();
    process.chdir(root);
    process.env.GITHUB_WORKSPACE = root;
    const cwdBefore = process.cwd();

    expect(activateWorkingDirectory('', root)).toEqual({
      changed: false,
      originalRoot: root,
      effectiveRoot: root
    });
    expect(process.cwd()).toBe(cwdBefore);
    expect(process.env.GITHUB_WORKSPACE).toBe(root);
  });

  it('activates an inward symlink and aligns process roots', () => {
    const root = makeRoot();
    const service = path.join(root, 'services', 'payments');
    const realRoot = realpathSync(root);
    const realService = realpathSync(service);
    symlinkSync(service, path.join(root, 'payments-link'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(activateWorkingDirectory('payments-link', root)).toEqual({
      changed: true,
      originalRoot: realRoot,
      effectiveRoot: realService
    });
    expect(process.cwd()).toBe(realService);
    expect(process.env.GITHUB_WORKSPACE).toBe(realService);
  });

  it('rejects absolute, traversing, missing, file, and outbound-symlink paths', () => {
    const root = makeRoot();
    const outside = mkdtempSync(path.join(tmpdir(), 'smoke-flow-working-directory-outside-'));
    tempDirs.push(outside);
    writeFileSync(path.join(root, 'service.txt'), 'not a directory');
    symlinkSync(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');

    for (const input of [
      path.join(root, 'services', 'payments'),
      '../outside',
      'services/../services/payments',
      'missing',
      'service.txt',
      'outside-link'
    ]) {
      expect(() => activateWorkingDirectory(input, root), input).toThrow(/working-directory/i);
      expect(process.cwd()).toBe(originalCwd);
    }
  });

  it('runs before action input validation', async () => {
    const root = makeRoot();
    const service = realpathSync(path.join(root, 'services', 'payments'));
    const actionCore: CoreLike = {
      info: () => undefined,
      setFailed: () => undefined,
      setOutput: () => undefined,
      setSecret: () => undefined,
      warning: () => undefined
    };

    await expect(
      runAction(actionCore, {
        GITHUB_WORKSPACE: root,
        INPUT_WORKING_DIRECTORY: 'services/payments'
      })
    ).rejects.toThrow(/project-name/i);
    expect(process.cwd()).toBe(service);
    expect(process.env.GITHUB_WORKSPACE).toBe(service);
  });

  it('runs before CLI safety validation', async () => {
    const root = makeRoot();
    const service = realpathSync(path.join(root, 'services', 'payments'));
    process.chdir(root);

    await expect(
      runCli([
        'node',
        'postman-smoke-flow',
        '--working-directory',
        'services/payments'
      ], undefined, {})
    ).rejects.toThrow(/destructive full canonical Smoke refresh/i);
    expect(process.cwd()).toBe(service);
    expect(process.env.GITHUB_WORKSPACE).toBe(service);
  });

  it('activates exactly once when the CLI reaches action execution', async () => {
    const root = makeRoot();
    const service = realpathSync(path.join(root, 'services', 'payments'));
    writeFileSync(path.join(service, 'openapi.yaml'), 'openapi: 3.1.0\ninfo:\n  title: Payments\n  version: 1.0.0\npaths: {}\n');
    process.chdir(root);
    const originalRef = process.env.GITHUB_REF;
    const originalRefName = process.env.GITHUB_REF_NAME;
    process.env.GITHUB_WORKSPACE = root;
    process.env.GITHUB_REF = 'refs/heads/feature/monorepo';
    process.env.GITHUB_REF_NAME = 'feature/monorepo';

    try {
      const outputs = await runCli([
        'node',
        'postman-smoke-flow',
        '--working-directory',
        'services/payments',
        '--project-name',
        'payments',
        '--workspace-id',
        'workspace-1',
        '--spec-id',
        'spec-1',
        '--smoke-collection-id',
        'collection-1',
        '--spec-path',
        'openapi.yaml',
        '--branch-strategy',
        'publish-gate',
        '--canonical-branch',
        'main'
      ]);

      expect(outputs).toMatchObject({
        'sync-status': 'skipped-branch-gate',
        'flow-apply-status': 'skipped'
      });
      expect(process.cwd()).toBe(service);
      expect(process.env.GITHUB_WORKSPACE).toBe(service);
    } finally {
      if (originalRef === undefined) delete process.env.GITHUB_REF;
      else process.env.GITHUB_REF = originalRef;
      if (originalRefName === undefined) delete process.env.GITHUB_REF_NAME;
      else process.env.GITHUB_REF_NAME = originalRefName;
    }
  });
});
