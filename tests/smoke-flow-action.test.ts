import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runSmokeFlow } from '../src/index.js';
import type { ActionInputs, CoreLike, SmokeAuthConfig } from '../src/types.js';

const oauthConfig: SmokeAuthConfig = {
  enabled: true,
  type: 'oauth2',
  grantType: 'client_credentials',
  tokenUrl: '{{auth_token_url}}',
  clientAuthentication: 'body',
  variables: {
    tokenUrl: 'auth_token_url',
    scope: 'auth_scope',
    clientId: 'auth_client_id',
    clientSecret: 'auth_client_secret',
    accessToken: 'access_token',
    expiresAt: 'access_token_expires_at'
  }
};

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
    generateFlowDraft: false,
    postmanApiKey: 'PMAK-123',
    postmanApiBaseUrl: 'https://api.getpostman.com',
    secretsResolverEnabled: true,
    specPath: 'openapi.yaml',
    collectionSyncMode: 'refresh',
    failOnFlowWarning: false,
    keepTempCollectionOnFailure: false,
    tempCollectionPrefix: '[Smoke][Temp]'
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createFlowPostmanMock(generatedCollection: Record<string, unknown>, options: { overwriteFirstUpdate?: boolean } = {}) {
  let canonicalCollection = clone(generatedCollection);
  let shouldOverwriteFirstUpdate = Boolean(options.overwriteFirstUpdate);

  return {
    generateCollection: vi.fn().mockResolvedValue('temp-123'),
    getCollection: vi.fn(async (collectionId: string) =>
      collectionId === 'temp-123' ? clone(generatedCollection) : clone(canonicalCollection)
    ),
    updateCollection: vi.fn(async (_collectionId: string, collection: Record<string, unknown>) => {
      if (shouldOverwriteFirstUpdate) {
        shouldOverwriteFirstUpdate = false;
        canonicalCollection = clone(generatedCollection);
        return;
      }
      canonicalCollection = clone(collection);
    }),
    deleteCollection: vi.fn().mockResolvedValue(undefined)
  };
}

function createCanonicalPostmanMock(existingCollection: Record<string, unknown>, options: { overwriteFirstUpdate?: boolean } = {}) {
  let canonicalCollection = clone(existingCollection);
  let shouldOverwriteFirstUpdate = Boolean(options.overwriteFirstUpdate);

  return {
    generateCollection: vi.fn(),
    getCollection: vi.fn(async () => clone(canonicalCollection)),
    updateCollection: vi.fn(async (_collectionId: string, collection: Record<string, unknown>) => {
      if (shouldOverwriteFirstUpdate) {
        shouldOverwriteFirstUpdate = false;
        canonicalCollection = clone(existingCollection);
        return;
      }
      canonicalCollection = clone(collection);
    }),
    deleteCollection: vi.fn()
  };
}

function createDependencies(core: CoreLike, postman: ReturnType<typeof createFlowPostmanMock> | ReturnType<typeof createCanonicalPostmanMock>) {
  return {
    core,
    postman,
    sleep: vi.fn().mockResolvedValue(undefined)
  };
}

function createFlowDraftClientMock() {
  return {
    createOrUpdateDraft: vi.fn().mockResolvedValue({
      status: 'created',
      flowId: 'flow-123',
      flowUrl: 'https://www.postman.com/workspace/ws-123/flow/flow-123',
      nodeCount: 3,
      connectionCount: 2,
      warnings: []
    })
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

    const postman = createFlowPostmanMock({
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
    });

    try {
      const outputs = await runSmokeFlow(createInputs(tempDir), createDependencies(core, postman));
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

  it('masks accepted Postman credentials and warns when access-token compatibility input is supplied', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-action-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);

    const core: CoreLike = {
      setOutput: vi.fn(),
      setSecret: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn()
    };

    const postman = createFlowPostmanMock({
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
    });

    try {
      await runSmokeFlow({
        ...createInputs(tempDir),
        postmanAccessToken: 'pma_at_user_session'
      }, createDependencies(core, postman));

      expect(core.setSecret).toHaveBeenCalledWith('PMAK-123');
      expect(core.setSecret).toHaveBeenCalledWith('pma_at_user_session');
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('postman-access-token is accepted only for compatibility'));
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('postman-cs/postman-resolve-service-token-action'));
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

  it('applies OAuth to the existing Smoke collection when flow-path is omitted', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-action-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);

    const core: CoreLike = {
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn()
    };

    const postman = createCanonicalPostmanMock({
      info: { name: '[Smoke] payments' },
      item: [
        {
          name: 'Payments',
          item: [
            {
              name: 'createPayment',
              request: {
                method: 'POST',
                header: [{ key: 'Authorization', value: 'Bearer old-token' }],
                url: 'https://api.example.com/payments'
              }
            },
            {
              name: '00 - Resolve Secrets',
              request: {
                method: 'POST',
                url: 'https://secretsmanager.us-west-2.amazonaws.com'
              }
            }
          ]
        }
      ]
    });

    try {
      const outputs = await runSmokeFlow({
        ...createInputs(tempDir),
        flowPath: undefined,
        secretsResolverEnabled: false,
        authConfig: oauthConfig
      }, createDependencies(core, postman));
      const summary = JSON.parse(outputs['flow-apply-summary-json']) as Record<string, unknown>;
      const updatedCollection = postman.updateCollection.mock.calls[0]?.[1] as Record<string, unknown>;
      const items = updatedCollection.item as Array<Record<string, unknown>>;
      const nestedItems = items[0]?.item as Array<Record<string, unknown>>;
      const request = nestedItems[0]?.request as Record<string, unknown>;

      expect(outputs['smoke-collection-id']).toBe('col-smoke');
      expect(outputs['flow-apply-status']).toBe('skipped');
      expect(outputs['temporary-smoke-collection-id']).toBe('');
      expect(summary.authApplied).toBe(true);
      expect(summary.authRequestCount).toBe(1);
      expect(postman.generateCollection).not.toHaveBeenCalled();
      expect(postman.getCollection).toHaveBeenCalledWith('col-smoke');
      expect(postman.updateCollection).toHaveBeenCalledOnce();
      expect(postman.deleteCollection).not.toHaveBeenCalled();
      expect(request.auth).toEqual({
        type: 'bearer',
        bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }]
      });
      expect(request.header).toEqual([]);
      expect(JSON.stringify(updatedCollection)).toContain('Auto-generated OAuth2 client-credentials token cache');
      expect(JSON.stringify(updatedCollection)).not.toContain('00 - Resolve Secrets');
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reapplies OAuth when a pending linked sync overwrites the first auth-only update', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-action-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);

    const core: CoreLike = {
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn()
    };

    const postman = createCanonicalPostmanMock({
      info: { name: '[Smoke] payments' },
      item: [
        {
          name: 'createPayment',
          request: {
            method: 'POST',
            header: [{ key: 'Authorization', value: 'Bearer old-token' }],
            url: 'https://api.example.com/payments'
          }
        }
      ]
    }, { overwriteFirstUpdate: true });

    try {
      const outputs = await runSmokeFlow({
        ...createInputs(tempDir),
        flowPath: undefined,
        authConfig: oauthConfig
      }, createDependencies(core, postman));
      const finalCollection = postman.updateCollection.mock.calls[1]?.[1] as Record<string, unknown>;

      expect(outputs['flow-apply-status']).toBe('skipped');
      expect(postman.updateCollection).toHaveBeenCalledTimes(2);
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Canonical Smoke collection update was not stable'));
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining('persisted after 2 attempt'));
      expect(JSON.stringify(finalCollection)).toContain('Auto-generated OAuth2 client-credentials token cache');
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips without Postman mutation when flow-path is omitted and OAuth is disabled', async () => {
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
      const outputs = await runSmokeFlow({
        ...createInputs(tempDir),
        flowPath: undefined,
        authConfig: undefined
      }, { core, postman });
      const summary = JSON.parse(outputs['flow-apply-summary-json']) as Record<string, unknown>;

      expect(outputs['flow-apply-status']).toBe('skipped');
      expect(summary.authApplied).toBe(false);
      expect(postman.generateCollection).not.toHaveBeenCalled();
      expect(postman.getCollection).not.toHaveBeenCalled();
      expect(postman.updateCollection).not.toHaveBeenCalled();
      expect(postman.deleteCollection).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reapplies curated flow updates when a pending linked sync overwrites the first flow update', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-action-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);

    const core: CoreLike = {
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn()
    };

    const postman = createFlowPostmanMock({
      info: { name: '[Smoke][Temp] payments' },
      item: [
        {
          name: 'createPayment',
          request: {
            method: 'POST',
            header: [{ key: 'Authorization', value: 'Bearer old-token' }],
            url: 'https://api.example.com/payments'
          }
        }
      ]
    }, { overwriteFirstUpdate: true });

    try {
      const outputs = await runSmokeFlow({
        ...createInputs(tempDir),
        authConfig: oauthConfig
      }, createDependencies(core, postman));
      const finalCollection = postman.updateCollection.mock.calls[1]?.[1] as Record<string, unknown>;

      expect(outputs['flow-apply-status']).toBe('success');
      expect(postman.updateCollection).toHaveBeenCalledTimes(2);
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Canonical Smoke collection update was not stable'));
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining('persisted after 2 attempt'));
      expect(JSON.stringify(finalCollection)).toContain('Auto-generated OAuth2 client-credentials token cache');
      expect(JSON.stringify(finalCollection)).toContain('Extract createPayment.paymentId');
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

    const postman = createFlowPostmanMock({
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
    });

    try {
      const outputs = await runSmokeFlow(createInputs(tempDir), createDependencies(core, postman));
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

    const postman = createFlowPostmanMock({
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
    });

    try {
      const outputs = await runSmokeFlow(createInputs(tempDir), createDependencies(core, postman));
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

    const postman = createFlowPostmanMock({
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
    });

    try {
      const inputs = {
        ...createInputs(tempDir),
        debugDumpPath: '.debug/curated-smoke-collection.json'
      };
      await runSmokeFlow(inputs, createDependencies(core, postman));
      const dumpPath = path.join(tempDir, '.debug/curated-smoke-collection.json');
      expect(existsSync(dumpPath)).toBe(true);
      const dumpContent = JSON.parse(readFileSync(dumpPath, 'utf8')) as Record<string, unknown>;
      expect((dumpContent.info as Record<string, unknown>).name).toBe('[Smoke] Payments API happy path');
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('generates a native Flow draft and compiles the inferred happy path into the Smoke collection', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-action-'));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const inputs = createInputs(tempDir);
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
        "        '201':",
        '          description: created',
        '          content:',
        '            application/json:',
        '              schema:',
        '                type: object',
        '                properties:',
        '                  id:',
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
        '          description: ok',
        '    patch:',
        '      operationId: updatePayment',
        '      parameters:',
        '        - name: paymentId',
        '          in: path',
        '          required: true',
        '          schema:',
        '            type: string',
        '      responses:',
        "        '200':",
        '          description: ok'
      ].join('\n')
    );

    const core: CoreLike = {
      setSecret: vi.fn(),
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn()
    };
    const postman = createFlowPostmanMock({
      info: { name: '[Smoke][Temp] payments' },
      item: [
        {
          id: 'req-create',
          name: 'createPayment',
          request: { method: 'POST', url: 'https://api.example.com/payments' }
        },
        {
          id: 'req-get',
          name: 'getPayment',
          request: { method: 'GET', url: 'https://api.example.com/payments/{paymentId}' }
        },
        {
          id: 'req-update',
          name: 'updatePayment',
          request: { method: 'PATCH', url: 'https://api.example.com/payments/{paymentId}' }
        }
      ]
    });
    const flowClient = createFlowDraftClientMock();

    try {
      const outputs = await runSmokeFlow({
        ...inputs,
        flowPath: undefined,
        generateFlowDraft: true,
        postmanAccessToken: 'pma_at_service_token',
        flowName: '[Smoke] Payments API happy path'
      }, {
        ...createDependencies(core, postman),
        flowClient
      });
      const summary = JSON.parse(outputs['flow-apply-summary-json']) as Record<string, unknown>;
      const updatedCollection = postman.updateCollection.mock.calls[0]?.[1] as Record<string, unknown>;

      expect(outputs['flow-apply-status']).toBe('success');
      expect(outputs['flow-id']).toBe('flow-123');
      expect(outputs['flow-draft-status']).toBe('created');
      expect(summary.generatedFlowDraft).toBe(true);
      expect(JSON.stringify(updatedCollection)).toContain('Extract createPayment.paymentId');
      expect(flowClient.createOrUpdateDraft).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'ws-123',
        flowId: undefined,
        flowName: '[Smoke] Payments API happy path',
        smokeCollectionId: 'col-smoke'
      }));
      expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('postman-access-token is accepted only for compatibility'));
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects generate-flow-draft without spec-path before calling Postman', async () => {
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
        flowPath: undefined,
        generateFlowDraft: true,
        specPath: undefined,
        postmanAccessToken: 'pma_at_service_token'
      }, { core, postman, flowClient: createFlowDraftClientMock() })).rejects.toThrow('generate-flow-draft requires spec-path');
      expect(postman.generateCollection).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects flow-path and generate-flow-draft together', async () => {
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
        generateFlowDraft: true,
        postmanAccessToken: 'pma_at_service_token'
      }, { core, postman, flowClient: createFlowDraftClientMock() })).rejects.toThrow('mutually exclusive');
      expect(postman.generateCollection).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
