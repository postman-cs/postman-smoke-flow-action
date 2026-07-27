import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { DEFAULT_FLOW_PATH, runSmokeFlow, validateInputsBeforeSideEffects } from '../src/index.js';
import { loadFlowManifest } from '../src/flow/parser.js';
import { validateFlowManifest } from '../src/flow/validator.js';
import { stringifyFlowManifest } from '../src/flow/serializer.js';
import { workspaceFileExists, writeWorkspaceFileExclusive } from '../src/lib/paths.js';
import type { ActionInputs, CoreLike, FlowDefinition } from '../src/types.js';

const SPEC = [
  'openapi: 3.0.0',
  'info:',
  '  title: Payments API',
  '  version: 1.0.0',
  'paths:',
  '  /payments:',
  '    post:',
  '      operationId: createPayment',
  '      responses:',
  "        '201':",
  '          description: created',
  '          content:',
  '            application/json:',
  '              schema:',
  '                type: object',
  '                properties:',
  '                  paymentId:',
  '                    type: string',
  '  /payments/{paymentId}:',
  '    get:',
  '      operationId: getPayment',
  '      parameters:',
  '        - name: paymentId',
  '          in: path',
  '          required: true',
  '          schema:',
  '            type: string',
  '      responses:',
  "        '200':",
  '          description: ok'
].join('\n');

const GENERATED_COLLECTION = {
  info: { name: '[Smoke][Temp] payments' },
  item: [
    { name: 'createPayment', request: { method: 'POST', url: 'https://api.example.com/payments' } },
    { name: 'getPayment', request: { method: 'GET', url: 'https://api.example.com/payments/{paymentId}' } }
  ]
};

const CURATED_MANIFEST = [
  'flows:',
  '  - name: Curated payments journey',
  '    type: smoke',
  '    steps:',
  '      - stepKey: create',
  '        operationId: createPayment',
  '        bindings: []',
  '        extract: []'
].join('\n');

function createCore(): CoreLike {
  return {
    setOutput: vi.fn(),
    setSecret: vi.fn(),
    setFailed: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn()
  };
}

function createPostmanMock() {
  let canonicalCollection: Record<string, unknown> = { info: { name: '[Smoke] payments' }, item: [] };
  return {
    generateCollection: vi.fn().mockResolvedValue('temp-123'),
    getCollection: vi.fn(async (collectionId: string) =>
      collectionId === 'temp-123'
        ? structuredClone(GENERATED_COLLECTION)
        : structuredClone(canonicalCollection)
    ),
    updateCollection: vi.fn(async (_collectionId: string, collection: Record<string, unknown>) => {
      canonicalCollection = structuredClone(collection);
    }),
    deleteCollection: vi.fn().mockResolvedValue(undefined)
  };
}

function baseInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    projectName: 'payments',
    workspaceId: 'ws-123',
    specId: 'spec-123',
    smokeCollectionId: 'col-smoke',
    flowPath: undefined,
    flowMode: 'auto',
    flowAllowDelete: false,
    postmanApiKey: 'PMAK-123',
    postmanApiBaseUrl: 'https://api.getpostman.com',
    postmanIapubBaseUrl: 'https://iapub.postman.co',
    secretsResolverEnabled: true,
    specPath: 'openapi.yaml',
    collectionSyncMode: 'refresh',
    failOnFlowWarning: false,
    keepTempCollectionOnFailure: false,
    tempCollectionPrefix: '[Smoke][Temp]',
    persistDerivedFlow: true,
    ...overrides
  };
}

function inTempWorkspace<T>(fn: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'flow-persist-'));
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  return fn(tempDir).finally(() => {
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });
}

describe('flow.yaml persistence and convergence', () => {
  it('run 1 derives and persists postman/flow.yaml; run 2 takes the curated path from it', async () => {
    await inTempWorkspace(async (tempDir) => {
      writeFileSync(path.join(tempDir, 'openapi.yaml'), SPEC);
      const core = createCore();
      const postman = createPostmanMock();
      const deps = { core, postman, sleep: vi.fn().mockResolvedValue(undefined) };

      const run1 = await runSmokeFlow(baseInputs(), deps);
      expect(run1['flow-apply-status']).toBe('success');
      expect(run1['derived-flow-path']).toBe(DEFAULT_FLOW_PATH);
      expect(existsSync(path.join(tempDir, DEFAULT_FLOW_PATH))).toBe(true);
      const summary1 = JSON.parse(run1['flow-apply-summary-json']) as { flowSource: string };
      expect(summary1.flowSource).toBe('derived');

      // Round-trip: the persisted manifest parses, validates, and deep-equals
      // the applied flow through the CURATED loader.
      const manifest = loadFlowManifest(DEFAULT_FLOW_PATH);
      const { flow, warnings } = validateFlowManifest(manifest);
      expect(warnings).toEqual([]);
      expect(flow.steps.map((step) => step.operationId)).toEqual(['createPayment', 'getPayment']);

      // Run 2 in the same workspace: file exists -> curated, nothing rewritten.
      const run2 = await runSmokeFlow(baseInputs(), deps);
      expect(run2['flow-apply-status']).toBe('success');
      expect(run2['derived-flow-path']).toBe('');
      const summary2 = JSON.parse(run2['flow-apply-summary-json']) as { flowSource: string };
      expect(summary2.flowSource).toBe('curated');
    });
  });

  it('an existing manifest at the default path wins over derivation under auto without flow-path', async () => {
    await inTempWorkspace(async (tempDir) => {
      writeFileSync(path.join(tempDir, 'openapi.yaml'), SPEC);
      mkdirSync(path.join(tempDir, 'postman'), { recursive: true });
      writeFileSync(path.join(tempDir, DEFAULT_FLOW_PATH), CURATED_MANIFEST);
      const deps = { core: createCore(), postman: createPostmanMock(), sleep: vi.fn().mockResolvedValue(undefined) };

      const outputs = await runSmokeFlow(baseInputs(), deps);
      const summary = JSON.parse(outputs['flow-apply-summary-json']) as { flowName: string; flowSource: string };
      expect(summary.flowSource).toBe('curated');
      expect(summary.flowName).toBe('Curated payments journey');
      expect(outputs['derived-flow-path']).toBe('');
      // The pre-existing manifest is untouched.
      expect(readFileSync(path.join(tempDir, DEFAULT_FLOW_PATH), 'utf8')).toBe(CURATED_MANIFEST);
    });
  });

  it('an INVALID manifest at the default path hard-errors instead of being derived over', async () => {
    await inTempWorkspace(async (tempDir) => {
      writeFileSync(path.join(tempDir, 'openapi.yaml'), SPEC);
      mkdirSync(path.join(tempDir, 'postman'), { recursive: true });
      writeFileSync(path.join(tempDir, DEFAULT_FLOW_PATH), 'flows: []\n');
      const deps = { core: createCore(), postman: createPostmanMock(), sleep: vi.fn().mockResolvedValue(undefined) };

      await expect(runSmokeFlow(baseInputs(), deps)).rejects.toThrow(/at least one flow/);
      expect(deps.postman.generateCollection).not.toHaveBeenCalled();
      expect(deps.postman.updateCollection).not.toHaveBeenCalled();
    });
  });

  it('persist-derived-flow=false derives without writing anything', async () => {
    await inTempWorkspace(async (tempDir) => {
      writeFileSync(path.join(tempDir, 'openapi.yaml'), SPEC);
      const deps = { core: createCore(), postman: createPostmanMock(), sleep: vi.fn().mockResolvedValue(undefined) };

      const outputs = await runSmokeFlow(baseInputs({ persistDerivedFlow: false }), deps);
      expect(outputs['flow-apply-status']).toBe('success');
      expect(outputs['derived-flow-path']).toBe('');
      expect(existsSync(path.join(tempDir, DEFAULT_FLOW_PATH))).toBe(false);
      const summary = JSON.parse(outputs['flow-apply-summary-json']) as { flowSource: string };
      expect(summary.flowSource).toBe('derived');
    });
  });

  it('a failed apply persists nothing', async () => {
    await inTempWorkspace(async (tempDir) => {
      writeFileSync(path.join(tempDir, 'openapi.yaml'), SPEC);
      const postman = createPostmanMock();
      postman.updateCollection.mockRejectedValue(new Error('gateway exploded'));
      const deps = { core: createCore(), postman, sleep: vi.fn().mockResolvedValue(undefined) };

      await expect(runSmokeFlow(baseInputs(), deps)).rejects.toThrow('gateway exploded');
      expect(existsSync(path.join(tempDir, DEFAULT_FLOW_PATH))).toBe(false);
    });
  });

  it('flow-path is honored as the write target for the derived manifest', async () => {
    await inTempWorkspace(async (tempDir) => {
      writeFileSync(path.join(tempDir, 'openapi.yaml'), SPEC);
      const deps = { core: createCore(), postman: createPostmanMock(), sleep: vi.fn().mockResolvedValue(undefined) };

      const outputs = await runSmokeFlow(baseInputs({ flowPath: 'ci/smoke-flow.yaml' }), deps);
      expect(outputs['derived-flow-path']).toBe('ci/smoke-flow.yaml');
      expect(existsSync(path.join(tempDir, 'ci/smoke-flow.yaml'))).toBe(true);
      const manifest = parseYaml(readFileSync(path.join(tempDir, 'ci/smoke-flow.yaml'), 'utf8')) as {
        flows: Array<{ steps: Array<{ operationId: string }> }>;
      };
      expect(manifest.flows[0]!.steps.map((step) => step.operationId)).toEqual(['createPayment', 'getPayment']);
    });
  });
});

describe('writeWorkspaceFileExclusive', () => {
  it('never overwrites an existing file', async () => {
    await inTempWorkspace(async (tempDir) => {
      writeFileSync(path.join(tempDir, 'existing.yaml'), 'original');
      expect(() => writeWorkspaceFileExclusive('existing.yaml', 'clobber', 'flow-path')).toThrow(/EEXIST/);
      expect(readFileSync(path.join(tempDir, 'existing.yaml'), 'utf8')).toBe('original');
    });
  });

  it('rejects paths escaping the workspace root', async () => {
    await inTempWorkspace(async () => {
      expect(() => writeWorkspaceFileExclusive('../outside.yaml', 'x', 'flow-path')).toThrow(/repository root/);
      expect(() => writeWorkspaceFileExclusive('/tmp/absolute.yaml', 'x', 'flow-path')).toThrow(/repository root/);
    });
  });

  it('rejects symlinked parents and symlinked targets', async () => {
    await inTempWorkspace(async (tempDir) => {
      const outside = mkdtempSync(path.join(os.tmpdir(), 'outside-'));
      try {
        symlinkSync(outside, path.join(tempDir, 'linkdir'));
        expect(() => writeWorkspaceFileExclusive('linkdir/flow.yaml', 'x', 'flow-path')).toThrow(/symbolic link|symlink/i);

        writeFileSync(path.join(outside, 'target.yaml'), 'outside');
        symlinkSync(path.join(outside, 'target.yaml'), path.join(tempDir, 'linkfile.yaml'));
        expect(() => writeWorkspaceFileExclusive('linkfile.yaml', 'x', 'flow-path')).toThrow(/symbolic link|symlink/i);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it('creates missing parent directories inside the workspace', async () => {
    await inTempWorkspace(async (tempDir) => {
      const resolved = writeWorkspaceFileExclusive('deep/nested/flow.yaml', 'content', 'flow-path');
      expect(existsSync(path.join(tempDir, 'deep/nested/flow.yaml'))).toBe(true);
      expect(readFileSync(resolved, 'utf8')).toBe('content');
    });
  });
});

describe('workspace manifest read boundary', () => {
  it('rejects target and parent symlinks that point outside the workspace', async () => {
    await inTempWorkspace(async (tempDir) => {
      const outside = mkdtempSync(path.join(os.tmpdir(), 'outside-'));
      try {
        const outsideManifest = path.join(outside, 'flow.yaml');
        writeFileSync(outsideManifest, CURATED_MANIFEST);
        symlinkSync(outsideManifest, path.join(tempDir, 'target-link.yaml'));
        symlinkSync(outside, path.join(tempDir, 'parent-link'));

        expect(() => loadFlowManifest('target-link.yaml')).toThrow(/symbolic link|symlink/i);
        expect(() => loadFlowManifest('parent-link/flow.yaml')).toThrow(/symbolic link|symlink/i);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it('rejects invalid paths but returns false for a safe missing path', async () => {
    await inTempWorkspace(async (tempDir) => {
      const outside = mkdtempSync(path.join(os.tmpdir(), 'outside-'));
      try {
        symlinkSync(outside, path.join(tempDir, 'outside-link'));
        expect(workspaceFileExists('missing/flow.yaml', 'flow-path')).toBe(false);
        expect(() => workspaceFileExists('../outside.yaml', 'flow-path')).toThrow(/repository root/);
        expect(() => workspaceFileExists('missing/../flow.yaml', 'flow-path')).toThrow(/lexical traversal/);
        expect(() => workspaceFileExists('/tmp/absolute.yaml', 'flow-path')).toThrow(/relative|repository root/);
        expect(() => workspaceFileExists('outside-link/flow.yaml', 'flow-path')).toThrow(/symbolic link|symlink/i);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it('rejects an absolute in-workspace manifest path', async () => {
    await inTempWorkspace(async (tempDir) => {
      const manifestPath = path.join(tempDir, 'flow.yaml');
      writeFileSync(manifestPath, CURATED_MANIFEST);
      expect(() => loadFlowManifest(manifestPath)).toThrow(/relative/);
    });
  });
});

describe('stringifyFlowManifest round-trip', () => {
  it('derive -> stringify -> parse -> validate deep-equals', () => {
    const flow: FlowDefinition = {
      name: 'Payments derived smoke flow',
      type: 'smoke',
      steps: [
        { stepKey: 'createPayment', operationId: 'createPayment', bindings: [], extract: [{ jsonPath: '$.paymentId', variable: 'createPayment.paymentId' }] },
        {
          stepKey: 'getPayment',
          operationId: 'getPayment',
          bindings: [
            { fieldKey: 'paymentId', source: 'prior_output', sourceStepKey: 'createPayment', variable: 'createPayment.paymentId' }
          ],
          extract: []
        }
      ]
    };
    const serialized = stringifyFlowManifest(flow);
    const parsed = parseYaml(serialized) as { flows: FlowDefinition[] };
    expect(parsed).toEqual({ flows: [flow] });
    const { flow: validated, warnings } = validateFlowManifest(parsed);
    expect(warnings).toEqual([]);
    expect(validated).toEqual(flow);
  });
});

describe('read-side workspace containment', () => {
  it.each([true, false])('runSmokeFlow rejects an escaping flow-path before any Postman call when persist-derived-flow is %s', async (persistDerivedFlow) => {
    await inTempWorkspace(async (tempDir) => {
      writeFileSync(path.join(tempDir, 'openapi.yaml'), SPEC);
      const deps = { core: createCore(), postman: createPostmanMock(), sleep: vi.fn().mockResolvedValue(undefined) };
      await expect(runSmokeFlow(baseInputs({ flowPath: '../outside.yaml', persistDerivedFlow }), deps)).rejects.toThrow(/repository root/);
      expect(deps.postman.generateCollection).not.toHaveBeenCalled();
      expect(deps.postman.updateCollection).not.toHaveBeenCalled();
    });
  });

  it('runSmokeFlow rejects a symlinked manifest escaping the workspace BEFORE any Postman call', async () => {
    await inTempWorkspace(async (tempDir) => {
      writeFileSync(path.join(tempDir, 'openapi.yaml'), SPEC);
      const outside = mkdtempSync(path.join(os.tmpdir(), 'outside-'));
      try {
        writeFileSync(path.join(outside, 'flow.yaml'), CURATED_MANIFEST);
        mkdirSync(path.join(tempDir, 'postman'), { recursive: true });
        symlinkSync(path.join(outside, 'flow.yaml'), path.join(tempDir, DEFAULT_FLOW_PATH));
        const deps = { core: createCore(), postman: createPostmanMock(), sleep: vi.fn().mockResolvedValue(undefined) };
        await expect(runSmokeFlow(baseInputs(), deps)).rejects.toThrow(/symbolic link|symlink/i);
        expect(deps.postman.generateCollection).not.toHaveBeenCalled();
        expect(deps.postman.updateCollection).not.toHaveBeenCalled();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});

describe('validateInputsBeforeSideEffects convergence', () => {
  it('does not reject a missing manifest at a custom flow-path under flow-mode auto', () => {
    expect(() =>
      validateInputsBeforeSideEffects(baseInputs({ flowPath: 'ci/smoke-flow.yaml' }))
    ).not.toThrow();
  });

  it('still validates an existing manifest at flow-path before side effects', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'flow-validate-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      mkdirSync(path.join(tempDir, 'ci'), { recursive: true });
      writeFileSync(path.join(tempDir, 'ci/smoke-flow.yaml'), 'flows: []\n');
      expect(() =>
        validateInputsBeforeSideEffects(baseInputs({ flowPath: 'ci/smoke-flow.yaml' }))
      ).toThrow(/at least one flow/);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('still rejects an escaping flow-path before side effects', () => {
    expect(() =>
      validateInputsBeforeSideEffects(baseInputs({ flowPath: '../outside.yaml' }))
    ).toThrow(/repository root/);
  });
});
