import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertWorkspaceContainment, writeWorkspaceFileExclusive } from '../src/lib/paths.js';
import { loadFlowManifest } from '../src/flow/parser.js';
import { loadSpecDocument } from '../src/flow/derive.js';
import { resolveFlowRequests } from '../src/flow/resolver.js';

const MANIFEST = ['flows:', '  - name: f', '    type: smoke', '    steps: []'].join('\n');

describe('assertWorkspaceContainment', () => {
  let tempDir: string;
  let previousCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'paths-contain-'));
    previousCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the resolved path for an in-workspace target that does not exist yet', () => {
    const resolved = assertWorkspaceContainment('postman/flow.yaml', 'flow-path');
    expect(resolved).toBe(path.join(realpathSync(tempDir), 'postman/flow.yaml'));
  });

  it('rejects lexical escapes even when the target does not exist', () => {
    expect(() => assertWorkspaceContainment('../outside.yaml', 'flow-path')).toThrow(/repository root/);
    expect(() => assertWorkspaceContainment('/tmp/absolute.yaml', 'flow-path')).toThrow(/repository root/);
  });

  it('rejects symlinked parent directories pointing outside the workspace', () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      symlinkSync(outside, path.join(tempDir, 'linkdir'));
      expect(() => assertWorkspaceContainment('linkdir/flow.yaml', 'flow-path')).toThrow(/symbolic link|symlink/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked target pointing outside the workspace', () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      writeFileSync(path.join(outside, 'target.yaml'), 'outside');
      symlinkSync(path.join(outside, 'target.yaml'), path.join(tempDir, 'linkfile.yaml'));
      expect(() => assertWorkspaceContainment('linkfile.yaml', 'flow-path')).toThrow(/symbolic link|symlink/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('accepts symlink-free existing files inside the workspace', () => {
    mkdirSync(path.join(tempDir, 'postman'), { recursive: true });
    writeFileSync(path.join(tempDir, 'postman/flow.yaml'), MANIFEST);
    const resolved = assertWorkspaceContainment('postman/flow.yaml', 'flow-path');
    expect(resolved).toBe(path.join(realpathSync(tempDir), 'postman/flow.yaml'));
  });
});

describe('loadFlowManifest read-side containment', () => {
  let tempDir: string;
  let previousCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'paths-read-'));
    previousCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads a real in-workspace manifest', () => {
    writeFileSync(path.join(tempDir, 'flow.yaml'), MANIFEST);
    const manifest = loadFlowManifest('flow.yaml');
    expect(manifest.flows).toHaveLength(1);
  });

  it('refuses to read a manifest through a symlink that escapes the workspace', () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      writeFileSync(path.join(outside, 'flow.yaml'), MANIFEST);
      symlinkSync(path.join(outside, 'flow.yaml'), path.join(tempDir, 'flow.yaml'));
      expect(() => loadFlowManifest('flow.yaml')).toThrow(/symbolic link|symlink/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses to read through a symlinked parent directory', () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      writeFileSync(path.join(outside, 'flow.yaml'), MANIFEST);
      symlinkSync(outside, path.join(tempDir, 'linked'));
      expect(() => loadFlowManifest('linked/flow.yaml')).toThrow(/symbolic link|symlink/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('spec-path read-side containment', () => {
  let tempDir: string;
  let previousCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'paths-spec-read-'));
    previousCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects direct traversal and absolute paths in curated resolution', () => {
    const flow = {
      name: 'f',
      type: 'smoke' as const,
      steps: [{ stepKey: 's', operationId: 'op', bindings: [], extract: [] }]
    };
    const collection = { item: [{ name: 'op', request: { method: 'GET', url: '/op' } }] };

    expect(() => resolveFlowRequests(flow, collection, '../outside.yaml')).toThrow(/repository root/);
    expect(() => resolveFlowRequests(flow, collection, path.join(tempDir, 'absolute.yaml'))).toThrow(/repository root/);
  });

  it('rejects a symlinked spec target in both derivation and curated resolution', () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'outside-spec-'));
    try {
      const spec = 'openapi: 3.0.3\ninfo: { title: Outside, version: 1.0.0 }\npaths: {}\n';
      writeFileSync(path.join(outside, 'openapi.yaml'), spec);
      symlinkSync(path.join(outside, 'openapi.yaml'), path.join(tempDir, 'openapi.yaml'));

      expect(() => loadSpecDocument('openapi.yaml')).toThrow(/symbolic link|symlink/i);
      expect(() =>
        resolveFlowRequests(
          { name: 'f', type: 'smoke', steps: [{ stepKey: 's', operationId: 'op', bindings: [], extract: [] }] },
          { item: [] },
          'openapi.yaml'
        )
      ).toThrow(/symbolic link|symlink/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('writeWorkspaceFileExclusive hardened write', () => {
  let tempDir: string;
  let previousCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'paths-write-'));
    previousCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('still writes inside the workspace after hardening', () => {
    const resolved = writeWorkspaceFileExclusive('deep/nested/flow.yaml', 'content', 'flow-path');
    expect(readFileSync(resolved, 'utf8')).toBe('content');
  });

  it('rejects when the parent directory is swapped for a symlink after validation', () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      mkdirSync(path.join(tempDir, 'postman'));
      rmSync(path.join(tempDir, 'postman'), { recursive: true });
      symlinkSync(outside, path.join(tempDir, 'postman'));
      expect(() => writeWorkspaceFileExclusive('postman/flow.yaml', 'x', 'flow-path')).toThrow(/symbolic link|symlink|repository root/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
