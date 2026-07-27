import { describe, expect, it } from 'vitest';

import { deriveFlowFromSpec } from '../src/flow/derive.js';

type Spec = Record<string, unknown>;

function spec(title: string, paths: Record<string, unknown>): Spec {
  return { openapi: '3.0.3', info: { title, version: '1.0.0' }, paths };
}

function jsonResponse(schema: unknown, code = '200'): Record<string, unknown> {
  return { [code]: { description: 'ok', content: { 'application/json': { schema } } } };
}

describe('derivation defect regressions', () => {
  it('DELETE provenance never crosses resources: a foreign create id must not satisfy provenance', () => {
    const result = deriveFlowFromSpec(
      spec('Cross API', {
        '/customers': {
          post: {
            operationId: 'createCustomer',
            responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }, '201')
          }
        },
        '/orders/{orderId}': {
          delete: { operationId: 'deleteOrder', responses: { '204': { description: 'gone' } } }
        }
      }),
      { allowDelete: true }
    );
    // deleteOrder has no same-resource create producer; it must be excluded even
    // though createCustomer published a global `id`.
    expect(result.excludedOperationIds).toContain('deleteOrder');
    const steps = result.flow ? result.flow.steps.map((s) => s.operationId) : [];
    expect(steps).not.toContain('deleteOrder');
  });

  it('top-level id extract is not shadowed by a nested object id visited earlier in sort order', () => {
    const result = deriveFlowFromSpec(
      spec('Nested API', {
        '/things': {
          post: {
            operationId: 'createThing',
            responses: jsonResponse(
              {
                type: 'object',
                properties: {
                  account: { type: 'object', properties: { id: { type: 'string' } } },
                  id: { type: 'string' }
                }
              },
              '201'
            )
          }
        },
        '/things/{thingId}': {
          get: { operationId: 'getThing', responses: jsonResponse({ type: 'object' }) }
        }
      })
    );
    const create = result.flow!.steps.find((s) => s.operationId === 'createThing')!;
    const idExtract = create.extract.find((e) => e.variable === 'createThing.id');
    expect(idExtract).toBeDefined();
    expect(idExtract!.jsonPath).toBe('$.id');
  });

  it('parent path parameter binds to the PARENT resource create, never the child id (nested plain-id)', () => {
    const result = deriveFlowFromSpec(
      spec('Projects API', {
        '/projects': {
          post: {
            operationId: 'createProject',
            responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }, '201')
          }
        },
        '/projects/{projectId}/tasks': {
          post: {
            operationId: 'createTask',
            responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }, '201')
          }
        },
        '/projects/{projectId}/tasks/{taskId}': {
          delete: { operationId: 'deleteTask', responses: { '204': { description: 'gone' } } }
        }
      }),
      { allowDelete: true }
    );
    const del = result.flow!.steps.find((s) => s.operationId === 'deleteTask')!;
    const byField = Object.fromEntries(del.bindings.map((b) => [b.fieldKey, b]));
    expect(byField.projectId).toMatchObject({ source: 'prior_output', variable: 'createProject.id' });
    expect(byField.taskId).toMatchObject({ source: 'prior_output', variable: 'createTask.id' });
    expect(result.excludedOperationIds).not.toContain('deleteTask');
  });

  it('excludes a nested DELETE whose parent id has no owner-scoped producer, even when the child does', () => {
    const result = deriveFlowFromSpec(
      spec('Orphan Parent API', {
        '/projects/{projectId}/tasks': {
          post: {
            operationId: 'createTask',
            responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }, '201')
          }
        },
        '/projects/{projectId}/tasks/{taskId}': {
          delete: { operationId: 'deleteTask', responses: { '204': { description: 'gone' } } }
        }
      }),
      { allowDelete: true }
    );
    expect(result.excludedOperationIds).toContain('deleteTask');
  });

  it('terminates on recursive allOf/$ref schema graphs', () => {
    const document = {
      openapi: '3.0.3',
      info: { title: 'Recursive API', version: '1.0.0' },
      paths: {
        '/nodes': {
          post: {
            operationId: 'createNode',
            responses: jsonResponse({ $ref: '#/components/schemas/Node' }, '201')
          }
        },
        '/nodes/{nodeId}': {
          get: { operationId: 'getNode', responses: jsonResponse({ $ref: '#/components/schemas/Node' }) }
        }
      },
      components: {
        schemas: {
          Node: {
            type: 'object',
            allOf: [{ $ref: '#/components/schemas/Node' }],
            properties: { id: { type: 'string' } }
          }
        }
      }
    };
    const result = deriveFlowFromSpec(document);
    const create = result.flow!.steps.find((s) => s.operationId === 'createNode')!;
    expect(create.extract.some((e) => e.variable === 'createNode.id')).toBe(true);
  });

  it('never emits extracts from non-JSON response media', () => {
    const result = deriveFlowFromSpec(
      spec('XML API', {
        '/reports': {
          post: {
            operationId: 'createReport',
            responses: {
              '201': {
                description: 'created',
                content: {
                  'application/xml': {
                    schema: { type: 'object', properties: { id: { type: 'string' } } }
                  }
                }
              }
            }
          }
        }
      })
    );
    const create = result.flow!.steps.find((s) => s.operationId === 'createReport')!;
    expect(create.extract).toEqual([]);
  });

  it('dereferences Path Item $ref entries', () => {
    const document = {
      openapi: '3.0.3',
      info: { title: 'Ref API', version: '1.0.0' },
      paths: {
        '/widgets': { $ref: '#/components/pathItems/Widgets' }
      },
      components: {
        pathItems: {
          Widgets: {
            post: {
              operationId: 'createWidget',
              responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }, '201')
            }
          }
        }
      }
    };
    const result = deriveFlowFromSpec(document);
    expect(result.flow!.steps.map((s) => s.operationId)).toContain('createWidget');
  });

  it('keeps synthetic fallback operationIds unique when distinct paths slug identically', () => {
    const result = deriveFlowFromSpec(
      spec('Sluggy API', {
        '/foo/bar': { get: { responses: jsonResponse({ type: 'object' }) } },
        '/foo-bar': { get: { responses: jsonResponse({ type: 'object' }) } }
      })
    );
    const ids = result.flow!.steps.map((s) => s.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('get-foo-bar');
    expect(ids).toContain('get-foo-bar-2');
  });

  it('hoists a producer resource ahead of a lexically earlier consumer', () => {
    const result = deriveFlowFromSpec(
      spec('Hoist API', {
        // /accounts sorts before /users, but getAccount consumes {userId}
        // produced only by createUser.
        '/accounts/{userId}': {
          get: { operationId: 'getAccount', responses: jsonResponse({ type: 'object' }) }
        },
        '/users': {
          post: {
            operationId: 'createUser',
            responses: jsonResponse({ type: 'object', properties: { userId: { type: 'string' } } }, '201')
          }
        }
      })
    );
    const ids = result.flow!.steps.map((s) => s.operationId);
    expect(ids.indexOf('createUser')).toBeLessThan(ids.indexOf('getAccount'));
    const read = result.flow!.steps.find((s) => s.operationId === 'getAccount')!;
    expect(read.bindings[0]).toMatchObject({ source: 'prior_output', variable: 'createUser.userId' });
  });

  it('non-DELETE consumers may still use the global fallback across resources', () => {
    const result = deriveFlowFromSpec(
      spec('Fallback API', {
        '/accounts': {
          post: {
            operationId: 'createAccount',
            responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }, '201')
          }
        },
        '/reports/{reportId}': {
          get: { operationId: 'getReport', responses: jsonResponse({ type: 'object' }) }
        }
      })
    );
    const read = result.flow!.steps.find((s) => s.operationId === 'getReport')!;
    expect(read.bindings[0]).toMatchObject({ source: 'prior_output', variable: 'createAccount.id' });
  });
});
