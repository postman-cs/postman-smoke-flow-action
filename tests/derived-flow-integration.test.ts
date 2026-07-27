import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { runSmokeFlow } from '../src/index.js';
import type { ActionInputs, CoreLike } from '../src/types.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createPostmanMock(generatedCollection: Record<string, unknown>) {
  let canonicalCollection: Record<string, unknown> = { info: { name: '[Smoke] payments' }, item: [] };
  return {
    generateCollection: vi.fn().mockResolvedValue('temp-123'),
    getCollection: vi.fn(async (collectionId: string) =>
      collectionId === 'temp-123' ? clone(generatedCollection) : clone(canonicalCollection)
    ),
    updateCollection: vi.fn(async (_collectionId: string, collection: Record<string, unknown>) => {
      canonicalCollection = clone(collection);
    }),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    readCanonical: () => clone(canonicalCollection)
  };
}

function createCore(): CoreLike {
  return {
    setOutput: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    setFailed: vi.fn()
  };
}

const PAYMENTS_SPEC = [
  'openapi: 3.0.3',
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
  '      responses:',
  "        '200':",
  '          description: ok',
  '    delete:',
  '      operationId: deletePayment',
  '      responses:',
  "        '204':",
  '          description: gone'
].join('\n');

const PRIVACY_SPEC = PAYMENTS_SPEC.replace(
  '    post:\n      operationId: createPayment',
  [
    '    post:',
    '      operationId: createPayment',
    '      parameters:',
    '        - in: query',
    '          name: auditToken',
    '          required: true',
    '          example: SECRET_LITERAL_42',
    '          schema:',
    '            type: string'
  ].join('\n')
);

const GENERATED_COLLECTION = {
  info: { name: '[Smoke][Temp] payments' },
  item: [
    { name: 'createPayment', request: { method: 'POST', url: 'https://api.example.com/payments' } },
    { name: 'getPayment', request: { method: 'GET', url: 'https://api.example.com/payments/{paymentId}' } },
    { name: 'deletePayment', request: { method: 'DELETE', url: 'https://api.example.com/payments/{paymentId}' } }
  ]
};

function derivedInputs(tempDir: string, overrides: Partial<ActionInputs> = {}): ActionInputs {
  writeFileSync(path.join(tempDir, 'openapi.yaml'), PAYMENTS_SPEC);
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

describe('derived flow end-to-end through runSmokeFlow', () => {
  it('derives, curates, and persists a flow without any flow.yaml', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    const postman = createPostmanMock(GENERATED_COLLECTION);

    try {
      const inputs = derivedInputs(tempDir);
      writeFileSync(path.join(tempDir, 'openapi.yaml'), PRIVACY_SPEC);
      const outputs = await runSmokeFlow(inputs, { core, postman, sleep: vi.fn().mockResolvedValue(undefined) });

      expect(outputs['flow-apply-status']).toBe('success');
      expect(outputs['flow-step-count']).toBe('2'); // DELETE excluded by default
      expect(outputs['applied-binding-count']).toBe('2');
      expect(outputs['applied-extract-count']).toBe('1');

      const canonical = postman.readCanonical();
      const items = (canonical.item as Array<Record<string, unknown>>).filter(
        (item) => (item.name as string) !== '00 - Resolve Secrets'
      );
      expect(items.map((item) => item.name)).toEqual(['createPayment', 'getPayment']);

      // getPayment carries the prior_output binding prerequest script.
      const getPayment = items[1]!;
      const events = getPayment.event as Array<Record<string, unknown>>;
      const prerequest = events.find((event) => event.listen === 'prerequest');
      const scriptText = JSON.stringify(prerequest);
      expect(scriptText).toContain('createPayment.paymentId');

      // DELETE exclusion produced a warning mentioning the opt-in input.
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('flow-allow-delete'));
      expect(postman.deleteCollection).toHaveBeenCalledWith('temp-123');

      // Derivation decision record travels in the summary contract.
      const summary = JSON.parse(outputs['flow-apply-summary-json']) as {
        flowSource: string;
        derivation: { derivedStepCount: number; excludedDeleteCount: number; excludedOperationIds: string[] };
      };
      expect(summary.flowSource).toBe('derived');
      expect(summary.derivation.derivedStepCount).toBe(2);
      expect(summary.derivation.excludedDeleteCount).toBe(1);
      expect(summary.derivation.excludedOperationIds).toEqual(['deletePayment']);

      // The derived flow persists as the curated manifest at the effective
      // default path, and the output points at it.
      expect(outputs['derived-flow-path']).toBe('postman/flow.yaml');
      const persisted = readFileSync(path.join(tempDir, 'postman/flow.yaml'), 'utf8');
      const manifest = parseYaml(persisted) as { flows: Array<Record<string, unknown>> };
      expect(Array.isArray(manifest.flows)).toBe(true);
      expect(manifest.flows).toHaveLength(1);
      const derivedFlow = manifest.flows[0]! as unknown as {
        type: string;
        steps: Array<Record<string, unknown>>;
      };
      expect(derivedFlow.type).toBe('smoke');
      expect(derivedFlow.steps.map((step) => step.operationId)).toEqual(['createPayment', 'getPayment']);

      // Structural privacy: the seed is FlowDefinition-shaped only. Top-level,
      // step, binding, and extract key sets are closed, and example values
      // remain in the generated request rather than entering this output.
      expect(Object.keys(derivedFlow).sort()).toEqual(['name', 'steps', 'type']);
      for (const step of derivedFlow.steps) {
        expect(Object.keys(step).sort()).toEqual(['bindings', 'extract', 'operationId', 'stepKey']);
        for (const binding of step.bindings as Array<Record<string, unknown>>) {
          expect(Object.keys(binding).sort()).toEqual(
            expect.arrayContaining(['fieldKey', 'source'])
          );
          expect(Object.keys(binding).every((key) =>
            ['fieldKey', 'source', 'sourceStepKey', 'variable'].includes(key)
          )).toBe(true);
          expect(binding).not.toHaveProperty('value');
          expect(binding.source).not.toBe('literal');
        }
        for (const extract of step.extract as Array<Record<string, unknown>>) {
          expect(Object.keys(extract).sort()).toEqual(['jsonPath', 'variable']);
        }
      }
      const serialized = persisted;
      expect(serialized).not.toContain('SECRET_LITERAL_42');
      expect(serialized).not.toContain('https://api.example.com');
      expect(serialized).not.toContain('PMAK-');
      expect(serialized).not.toContain('Authorization');
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('includes DELETE when flow-allow-delete=true and id is same-run created', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    const postman = createPostmanMock(GENERATED_COLLECTION);

    try {
      const outputs = await runSmokeFlow(derivedInputs(tempDir, { flowAllowDelete: true }), {
        core,
        postman,
        sleep: vi.fn().mockResolvedValue(undefined)
      });
      expect(outputs['flow-apply-status']).toBe('success');
      expect(outputs['flow-step-count']).toBe('3');
      const canonical = postman.readCanonical();
      const names = (canonical.item as Array<Record<string, unknown>>)
        .map((item) => item.name)
        .filter((name) => name !== '00 - Resolve Secrets');
      expect(names).toEqual(['createPayment', 'getPayment', 'deletePayment']);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to uncurated refresh when spec-path is missing under auto mode', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    const postman = createPostmanMock(GENERATED_COLLECTION);

    try {
      const outputs = await runSmokeFlow(derivedInputs(tempDir, { specPath: undefined }), {
        core,
        postman,
        sleep: vi.fn().mockResolvedValue(undefined)
      });
      expect(outputs['flow-apply-status']).toBe('success');
      expect(outputs['flow-step-count']).toBe('0');
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('requires spec-path'));
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fail-on-flow-warning gates weak description-tier resolution before any canonical mutation', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    // Generated collection where the flow's operationId matches ONLY inside a
    // request description (weak tier).
    const postman = createPostmanMock({
      info: { name: '[Smoke][Temp] payments' },
      item: [
        {
          name: 'Legacy request',
          request: { method: 'GET', url: 'https://api.example.com/legacy', description: 'Implements listArchived.' }
        }
      ]
    });
    writeFileSync(
      path.join(tempDir, 'flow.yaml'),
      [
        'flows:',
        '  - name: Weak match journey',
        '    type: smoke',
        '    steps:',
        '      - stepKey: list-archived-1',
        '        operationId: listArchived',
        '        bindings: []',
        '        extract: []'
      ].join('\n')
    );

    try {
      await expect(
        runSmokeFlow(derivedInputs(tempDir, { flowPath: 'flow.yaml', specPath: undefined, failOnFlowWarning: true }), {
          core,
          postman,
          sleep: vi.fn().mockResolvedValue(undefined)
        })
      ).rejects.toThrow(/resolution produced 1 warning/);
      // The canonical collection was never mutated.
      expect(postman.updateCollection).not.toHaveBeenCalled();
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('description substring'));
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('weak description-tier warning lands in summary.warnings when not gated', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    const postman = createPostmanMock({
      info: { name: '[Smoke][Temp] payments' },
      item: [
        {
          name: 'Legacy request',
          request: { method: 'GET', url: 'https://api.example.com/legacy', description: 'Implements listArchived.' }
        }
      ]
    });
    writeFileSync(
      path.join(tempDir, 'flow.yaml'),
      [
        'flows:',
        '  - name: Weak match journey',
        '    type: smoke',
        '    steps:',
        '      - stepKey: list-archived-1',
        '        operationId: listArchived',
        '        bindings: []',
        '        extract: []'
      ].join('\n')
    );

    try {
      const outputs = await runSmokeFlow(
        derivedInputs(tempDir, { flowPath: 'flow.yaml', specPath: undefined }),
        { core, postman, sleep: vi.fn().mockResolvedValue(undefined) }
      );
      expect(outputs['flow-apply-status']).toBe('success');
      const summary = JSON.parse(outputs['flow-apply-summary-json']) as { warnings: string[] };
      expect(summary.warnings.some((w) => w.includes('description substring'))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers curated flow.yaml over derivation when flow-path is set', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    const postman = createPostmanMock(GENERATED_COLLECTION);
    writeFileSync(
      path.join(tempDir, 'flow.yaml'),
      [
        'flows:',
        '  - name: Curated payments journey',
        '    type: smoke',
        '    steps:',
        '      - stepKey: create-payment-1',
        '        operationId: createPayment',
        '        bindings: []',
        '        extract: []'
      ].join('\n')
    );

    try {
      const outputs = await runSmokeFlow(derivedInputs(tempDir, { flowPath: 'flow.yaml' }), {
        core,
        postman,
        sleep: vi.fn().mockResolvedValue(undefined)
      });
      expect(outputs['flow-apply-status']).toBe('success');
      expect(outputs['flow-step-count']).toBe('1');
      const summary = JSON.parse(outputs['flow-apply-summary-json']) as { flowName: string; flowSource: string };
      expect(summary.flowName).toBe('Curated payments journey');
      expect(summary.flowSource).toBe('curated');
      expect(outputs['derived-flow-path']).toBe('');
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('flow-mode=off with flow-path set is rejected', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    const postman = createPostmanMock(GENERATED_COLLECTION);
    writeFileSync(path.join(tempDir, 'flow.yaml'), 'flows: []');

    try {
      await expect(
        runSmokeFlow(derivedInputs(tempDir, { flowMode: 'off', flowPath: 'flow.yaml' }), {
          core,
          postman,
          sleep: vi.fn().mockResolvedValue(undefined)
        })
      ).rejects.toThrow(/flow-mode=off cannot be combined with flow-path/);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('flow-mode=curated without flow-path is rejected', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    const postman = createPostmanMock(GENERATED_COLLECTION);

    try {
      await expect(
        runSmokeFlow(derivedInputs(tempDir, { flowMode: 'curated', flowPath: undefined }), {
          core,
          postman,
          sleep: vi.fn().mockResolvedValue(undefined)
        })
      ).rejects.toThrow(/flow-mode=curated requires flow-path/);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fail-on-flow-warning=true fails the run when derivation warns', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    const postman = createPostmanMock(GENERATED_COLLECTION);

    try {
      await expect(
        runSmokeFlow(derivedInputs(tempDir, { failOnFlowWarning: true }), {
          core,
          postman,
          sleep: vi.fn().mockResolvedValue(undefined)
        })
      ).rejects.toThrow(/warning\(s\) and fail-on-flow-warning=true/);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('round-2 integration pins', () => {
  const NO_OPID_SPEC = [
    'openapi: 3.0.3',
    'info:',
    '  title: Anonymous API',
    '  version: 1.0.0',
    'paths:',
    '  /items:',
    '    post:',
    '      responses:',
    "        '201':",
    '          description: created',
    '          content:',
    '            application/json:',
    '              schema:',
    '                type: object',
    '                properties:',
    '                  itemId:',
    '                    type: string',
    '  /items/{itemId}:',
    '    get:',
    '      responses:',
    "        '200':",
    '          description: ok'
  ].join('\n');

  const NO_OPID_COLLECTION = {
    info: { name: '[Smoke][Temp] payments' },
    item: [
      { name: 'Create item', request: { method: 'POST', url: 'https://api.example.com/items' } },
      { name: 'Get item', request: { method: 'GET', url: 'https://api.example.com/items/{itemId}' } }
    ]
  };

  it('resolves synthetic fallback operationIds end-to-end when the spec has no operationIds', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    const postman = createPostmanMock(NO_OPID_COLLECTION);

    try {
      const inputs = derivedInputs(tempDir);
      // derivedInputs writes the payments spec; replace it with the no-opId spec.
      writeFileSync(path.join(tempDir, 'openapi.yaml'), NO_OPID_SPEC);
      const outputs = await runSmokeFlow(
        inputs,
        { core, postman, sleep: vi.fn().mockResolvedValue(undefined) }
      );
      expect(outputs['flow-apply-status']).toBe('success');
      expect(outputs['flow-step-count']).toBe('2');
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fail-on-flow-warning blocks the uncurated fallback refresh BEFORE any Postman mutation', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    const postman = createPostmanMock(GENERATED_COLLECTION);

    try {
      // No spec-path: auto-mode derivation falls back with a warning.
      const inputs = derivedInputs(tempDir, { specPath: undefined, failOnFlowWarning: true });
      await expect(
        runSmokeFlow(inputs, { core, postman, sleep: vi.fn().mockResolvedValue(undefined) })
      ).rejects.toThrow(/fail-on-flow-warning=true; refusing the uncurated canonical Smoke refresh/);
      expect(postman.generateCollection).not.toHaveBeenCalled();
      expect(postman.updateCollection).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'the spec contains zero operations',
      spec: [
        'openapi: 3.0.3',
        'info:',
        '  title: Empty API',
        '  version: 1.0.0',
        'paths: {}'
      ].join('\n'),
      causes: ['found no operations in the OpenAPI document']
    },
    {
      name: 'every operation is excluded by the default DELETE policy',
      spec: [
        'openapi: 3.0.3',
        'info:',
        '  title: Delete-only API',
        '  version: 1.0.0',
        'paths:',
        '  /records/{recordId}:',
        '    delete:',
        '      operationId: deleteRecord',
        '      responses:',
        "        '204':",
        '          description: gone'
      ].join('\n'),
      causes: [
        'excluded DELETE /records/{recordId} (deleteRecord)',
        'excluded every operation'
      ]
    }
  ])('hard-errors before Postman mutation when $name', async ({ spec, causes }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    const postman = createPostmanMock(GENERATED_COLLECTION);

    try {
      const inputs = derivedInputs(tempDir);
      writeFileSync(path.join(tempDir, 'openapi.yaml'), spec);
      const rejection = runSmokeFlow(inputs, {
        core,
        postman,
        sleep: vi.fn().mockResolvedValue(undefined)
      });
      for (const cause of causes) {
        await expect(rejection).rejects.toThrow(cause);
      }
      await expect(rejection).rejects.toThrow(/Fix the spec\/exclusions, pass flow-path, or explicitly choose flow-mode=off/);
      expect(postman.generateCollection).not.toHaveBeenCalled();
      expect(postman.updateCollection).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('surfaces and gates a weak resolution discovered only on a stabilization retry', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'derived-flow-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const core = createCore();
    const strongGenerated = {
      info: { name: '[Smoke][Temp] retry' },
      item: [{ name: 'listArchived', request: { method: 'GET', url: 'https://api.example.com/archived' } }]
    };
    const driftedCanonical = {
      info: { name: '[Smoke] drifted' },
      item: [{
        name: 'Legacy request',
        request: {
          method: 'POST',
          url: 'https://api.example.com/legacy',
          description: 'Compatibility wrapper for listArchived.'
        }
      }]
    };
    let canonical: Record<string, unknown> = clone(driftedCanonical);
    let canonicalWrites = 0;
    const postman = {
      generateCollection: vi.fn().mockResolvedValue('temp-123'),
      getCollection: vi.fn(async (collectionId: string) =>
        collectionId === 'temp-123' ? clone(strongGenerated) : clone(canonical)
      ),
      // First write does not stick: the canonical collection stays drifted, so
      // stabilization must reapply against the refreshed (drifted) source and
      // discover the weak resolution on the retry.
      updateCollection: vi.fn(async (_collectionId: string, collection: Record<string, unknown>) => {
        canonicalWrites += 1;
        if (canonicalWrites === 1) {
          canonical = clone(driftedCanonical);
          return;
        }
        canonical = clone(collection);
      }),
      deleteCollection: vi.fn().mockResolvedValue(undefined)
    };
    writeFileSync(
      path.join(tempDir, 'flow.yaml'),
      [
        'flows:',
        '  - name: Retry warning journey',
        '    type: smoke',
        '    steps:',
        '      - stepKey: list-archived-1',
        '        operationId: listArchived',
        '        bindings: []',
        '        extract: []'
      ].join('\n')
    );

    try {
      let caught: unknown;
      try {
        await runSmokeFlow(
          derivedInputs(tempDir, {
            flowPath: 'flow.yaml',
            specPath: undefined,
            failOnFlowWarning: true
          }),
          { core, postman, sleep: vi.fn().mockResolvedValue(undefined) }
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/resolution produced 1 warning/);
      const summary = (caught as Error & { summary: { warnings: string[] } }).summary;
      const weakWarnings = summary.warnings.filter((warning) => warning.includes('description substring'));
      expect(weakWarnings).toHaveLength(1);
      expect(core.warning).toHaveBeenCalledTimes(2);
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('not stable after attempt 1'));
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('description substring'));
      expect(postman.updateCollection.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
