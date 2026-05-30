import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runSmokeFlow } from '../src/index.js';
import type { ActionInputs, CoreLike } from '../src/types.js';

function createInputs(tempDir: string): ActionInputs {
  writeFileSync(
    path.join(tempDir, 'flow.yaml'),
    [
      'flows:',
      '  - name: Payments API happy path',
      '    type: smoke',
      '    steps:',
      '      - stepKey: create-payment-1',
      '        operationId: createPayment',
      '        bindings: []',
      '        extract:',
      '          - variable: createPayment.paymentId',
      '            jsonPath: $.paymentId'
    ].join('\n')
  );
  writeFileSync(
    path.join(tempDir, 'openapi.yaml'),
    [
      'openapi: 3.0.3',
      'info:',
      '  title: Payments API',
      '  version: 1.0.0',
      'paths:',
      '  /payments:',
      '    post:',
      '      operationId: createPayment',
      '      responses:',
      "        '200':",
      '          description: ok'
    ].join('\n')
  );

  return {
    projectName: 'payments',
    workspaceId: 'ws-123',
    specId: 'spec-123',
    smokeCollectionId: 'col-smoke',
    flowPath: 'flow.yaml',
    postmanApiKey: 'PMAK-123',
    secretsResolverEnabled: true,
    specPath: 'openapi.yaml',
    collectionSyncMode: 'refresh',
    failOnFlowWarning: false,
    keepTempCollectionOnFailure: false,
    tempCollectionPrefix: '[Smoke][Temp]'
  };
}

describe('runSmokeFlow', () => {
  it('generates a temp collection, refreshes the canonical smoke collection, and cleans up', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-action-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);

    const core: CoreLike = {
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn()
    };

    const postman = {
      generateCollection: vi.fn().mockResolvedValue('temp-123'),
      getCollection: vi.fn().mockResolvedValue({
        info: { name: '[Smoke][Temp] payments' },
        item: [
          {
            name: 'createPayment',
            request: {
              method: 'POST',
              url: 'https://api.example.com/payments'
            }
          }
        ]
      }),
      updateCollection: vi.fn().mockResolvedValue(undefined),
      deleteCollection: vi.fn().mockResolvedValue(undefined)
    };

    try {
      const outputs = await runSmokeFlow(createInputs(tempDir), { core, postman });
      expect(outputs['smoke-collection-id']).toBe('col-smoke');
      expect(outputs['flow-apply-status']).toBe('success');
      expect(postman.generateCollection).toHaveBeenCalledOnce();
      expect(postman.updateCollection).toHaveBeenCalledOnce();
      expect(postman.deleteCollection).toHaveBeenCalledWith('temp-123');
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported non-refresh collection sync modes before calling Postman', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-action-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);

    const core: CoreLike = {
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn()
    };

    const postman = {
      generateCollection: vi.fn(),
      getCollection: vi.fn(),
      updateCollection: vi.fn(),
      deleteCollection: vi.fn()
    };

    try {
      await expect(runSmokeFlow({
        ...createInputs(tempDir),
        collectionSyncMode: 'version'
      }, { core, postman })).rejects.toThrow('collection-sync-mode=refresh is the only supported mode');
      expect(postman.generateCollection).not.toHaveBeenCalled();
      expect(postman.updateCollection).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to spec-path method and path matching when request names do not equal operationIds', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-action-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);

    const core: CoreLike = {
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn()
    };

    const postman = {
      generateCollection: vi.fn().mockResolvedValue('temp-123'),
      getCollection: vi.fn().mockResolvedValue({
        info: { name: '[Smoke][Temp] payments' },
        item: [
          {
            name: 'Create a payment',
            request: {
              method: 'POST',
              url: 'https://api.example.com/payments'
            }
          }
        ]
      }),
      updateCollection: vi.fn().mockResolvedValue(undefined),
      deleteCollection: vi.fn().mockResolvedValue(undefined)
    };

    try {
      const outputs = await runSmokeFlow(createInputs(tempDir), { core, postman });
      expect(outputs['smoke-collection-id']).toBe('col-smoke');
      expect(outputs['flow-apply-status']).toBe('success');
      expect(postman.updateCollection).toHaveBeenCalledOnce();
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('ignores generated request query strings when matching operation paths', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-action-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);

    const core: CoreLike = {
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn()
    };

    const postman = {
      generateCollection: vi.fn().mockResolvedValue('temp-123'),
      getCollection: vi.fn().mockResolvedValue({
        info: { name: '[Smoke][Temp] payments' },
        item: [
          {
            name: 'Create a payment',
            request: {
              method: 'POST',
              url: 'https://api.example.com/payments?scenario={{scenario}}#example'
            }
          }
        ]
      }),
      updateCollection: vi.fn().mockResolvedValue(undefined),
      deleteCollection: vi.fn().mockResolvedValue(undefined)
    };

    try {
      const outputs = await runSmokeFlow(createInputs(tempDir), { core, postman });
      expect(outputs['smoke-collection-id']).toBe('col-smoke');
      expect(outputs['flow-apply-status']).toBe('success');
      expect(postman.updateCollection).toHaveBeenCalledOnce();
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('writes a transformed collection debug dump when debug-dump-path is provided', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-action-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);

    const core: CoreLike = {
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn()
    };

    const postman = {
      generateCollection: vi.fn().mockResolvedValue('temp-123'),
      getCollection: vi.fn().mockResolvedValue({
        info: { name: '[Smoke][Temp] payments' },
        item: [
          {
            name: 'createPayment',
            request: {
              method: 'POST',
              url: 'https://api.example.com/payments'
            }
          }
        ]
      }),
      updateCollection: vi.fn().mockResolvedValue(undefined),
      deleteCollection: vi.fn().mockResolvedValue(undefined)
    };

    try {
      const inputs = {
        ...createInputs(tempDir),
        debugDumpPath: '.debug/curated-smoke-collection.json'
      };
      await runSmokeFlow(inputs, { core, postman });
      const dumpPath = path.join(tempDir, '.debug/curated-smoke-collection.json');
      expect(existsSync(dumpPath)).toBe(true);
      const dumpContent = JSON.parse(readFileSync(dumpPath, 'utf8')) as Record<string, unknown>;
      expect((dumpContent.info as Record<string, unknown>).name).toBe('[Smoke] Payments API happy path');
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
