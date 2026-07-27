import { describe, expect, it } from 'vitest';

import { deriveFlowFromSpec } from '../src/flow/derive.js';
import type { FlowStep } from '../src/types.js';

type Spec = Record<string, unknown>;

function spec(title: string, paths: Record<string, unknown>, components?: Record<string, unknown>): Spec {
  return {
    openapi: '3.0.3',
    info: { title, version: '1.0.0' },
    paths,
    ...(components ? { components } : {})
  };
}

function jsonResponse(schema: unknown, code = '200'): Record<string, unknown> {
  return {
    [code]: {
      description: 'ok',
      content: { 'application/json': { schema } }
    }
  };
}

function opIds(steps: FlowStep[]): string[] {
  return steps.map((step) => step.operationId);
}

describe('deriveFlowFromSpec', () => {
  // 1. Classic single-resource CRUD API
  it('derives create -> list -> read -> update for a classic CRUD resource and excludes DELETE by default', () => {
    const result = deriveFlowFromSpec(
      spec('Pets API', {
        '/pets': {
          post: {
            operationId: 'createPet',
            responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } }, '201')
          },
          get: { operationId: 'listPets', responses: jsonResponse({ type: 'array', items: { type: 'object' } }) }
        },
        '/pets/{petId}': {
          get: { operationId: 'getPet', responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }) },
          put: { operationId: 'updatePet', responses: jsonResponse({ type: 'object' }) },
          delete: { operationId: 'deletePet', responses: { '204': { description: 'gone' } } }
        }
      })
    );
    expect(result.flow).not.toBeNull();
    expect(opIds(result.flow!.steps)).toEqual(['createPet', 'listPets', 'getPet', 'updatePet']);
    expect(result.excludedOperationIds).toEqual(['deletePet']);
    expect(result.warnings.some((warning) => warning.message.includes('flow-allow-delete'))).toBe(true);
  });

  // 2. DELETE included when allowed AND provenance proven
  it('includes DELETE last when allowDelete=true and the id comes from this run\'s create', () => {
    const result = deriveFlowFromSpec(
      spec('Pets API', {
        '/pets': {
          post: {
            operationId: 'createPet',
            responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }, '201')
          }
        },
        '/pets/{petId}': {
          delete: { operationId: 'deletePet', responses: { '204': { description: 'gone' } } }
        }
      }),
      { allowDelete: true }
    );
    expect(opIds(result.flow!.steps)).toEqual(['createPet', 'deletePet']);
    const del = result.flow!.steps[1]!;
    expect(del.bindings[0]).toMatchObject({ fieldKey: 'petId', source: 'prior_output', variable: 'createPet.id' });
  });

  // 3. DELETE still excluded under allowDelete when provenance is missing
  it('excludes DELETE under allowDelete=true when no create step produces the id', () => {
    const result = deriveFlowFromSpec(
      spec('Orphans API', {
        '/orphans/{orphanId}': {
          delete: { operationId: 'deleteOrphan', responses: { '204': { description: 'gone' } } }
        }
      }),
      { allowDelete: true }
    );
    expect(result.flow).toBeNull();
    expect(result.excludedOperationIds).toEqual(['deleteOrphan']);
    expect(result.warnings.some((warning) => warning.message.includes('a smoke flow cannot be derived'))).toBe(true);
  });

  // 4. Output->input ID chaining via extract + prior_output binding
  it('wires createPayment.paymentId into getPayment via prior_output', () => {
    const result = deriveFlowFromSpec(
      spec('Payments API', {
        '/payments': {
          post: {
            operationId: 'createPayment',
            responses: jsonResponse({ type: 'object', properties: { paymentId: { type: 'string' }, amount: { type: 'number' } } }, '201')
          }
        },
        '/payments/{paymentId}': {
          get: { operationId: 'getPayment', responses: jsonResponse({ type: 'object' }) }
        }
      })
    );
    const [create, read] = result.flow!.steps;
    expect(create!.extract).toEqual([{ variable: 'createPayment.paymentId', jsonPath: '$.paymentId' }]);
    expect(read!.bindings).toEqual([
      { fieldKey: 'paymentId', source: 'prior_output', sourceStepKey: create!.stepKey, variable: 'createPayment.paymentId' }
    ]);
  });

  // 5. Multi-resource API: deterministic resource ordering by (depth, lexical)
  it('orders resources deterministically by depth then lexically', () => {
    const result = deriveFlowFromSpec(
      spec('Store API', {
        '/zoos': { get: { operationId: 'listZoos', responses: jsonResponse({ type: 'array' }) } },
        '/accounts': { get: { operationId: 'listAccounts', responses: jsonResponse({ type: 'array' }) } },
        '/accounts/{accountId}/orders': { get: { operationId: 'listAccountOrders', responses: jsonResponse({ type: 'array' }) } }
      })
    );
    expect(opIds(result.flow!.steps)).toEqual(['listAccounts', 'listZoos', 'listAccountOrders']);
  });

  // 6. Nested sub-resource chaining across resources
  it('chains parent create id into nested sub-resource paths', () => {
    const result = deriveFlowFromSpec(
      spec('Projects API', {
        '/projects': {
          post: {
            operationId: 'createProject',
            responses: jsonResponse({ type: 'object', properties: { projectId: { type: 'string' } } }, '201')
          }
        },
        '/projects/{projectId}/tasks': {
          post: {
            operationId: 'createTask',
            responses: jsonResponse({ type: 'object', properties: { taskId: { type: 'string' } } }, '201')
          },
          get: { operationId: 'listTasks', responses: jsonResponse({ type: 'array' }) }
        },
        '/projects/{projectId}/tasks/{taskId}': {
          get: { operationId: 'getTask', responses: jsonResponse({ type: 'object' }) }
        }
      })
    );
    const steps = result.flow!.steps;
    expect(opIds(steps)).toEqual(['createProject', 'createTask', 'listTasks', 'getTask']);
    const getTask = steps[3]!;
    expect(getTask.bindings).toEqual([
      { fieldKey: 'projectId', source: 'prior_output', sourceStepKey: steps[0]!.stepKey, variable: 'createProject.projectId' },
      { fieldKey: 'taskId', source: 'prior_output', sourceStepKey: steps[1]!.stepKey, variable: 'createTask.taskId' }
    ]);
  });

  // 7. $ref schema resolution
  it('resolves $ref response schemas from components', () => {
    const result = deriveFlowFromSpec(
      spec(
        'Refs API',
        {
          '/widgets': {
            post: { operationId: 'createWidget', responses: jsonResponse({ $ref: '#/components/schemas/Widget' }, '201') }
          },
          '/widgets/{widgetId}': {
            get: { operationId: 'getWidget', responses: jsonResponse({ $ref: '#/components/schemas/Widget' }) }
          }
        },
        { schemas: { Widget: { type: 'object', properties: { widgetId: { type: 'string' }, label: { type: 'string' } } } } }
      )
    );
    const [create, read] = result.flow!.steps;
    expect(create!.extract).toEqual([{ variable: 'createWidget.widgetId', jsonPath: '$.widgetId' }]);
    expect(read!.bindings[0]!.source).toBe('prior_output');
  });

  // 8. allOf composition
  it('collects ids from allOf-composed response schemas', () => {
    const result = deriveFlowFromSpec(
      spec(
        'AllOf API',
        {
          '/things': {
            post: { operationId: 'createThing', responses: jsonResponse({ $ref: '#/components/schemas/Thing' }, '201') }
          },
          '/things/{thingId}': {
            get: { operationId: 'getThing', responses: jsonResponse({ $ref: '#/components/schemas/Thing' }) }
          }
        },
        {
          schemas: {
            Base: { type: 'object', properties: { thingId: { type: 'string' } } },
            Thing: { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { name: { type: 'string' } } }] }
          }
        }
      )
    );
    expect(result.flow!.steps[0]!.extract).toEqual([{ variable: 'createThing.thingId', jsonPath: '$.thingId' }]);
  });

  // 9. Nested envelope: { data: { id } }
  it('extracts ids from one level of response nesting', () => {
    const result = deriveFlowFromSpec(
      spec('Envelope API', {
        '/users': {
          post: {
            operationId: 'createUser',
            responses: jsonResponse(
              { type: 'object', properties: { data: { type: 'object', properties: { userId: { type: 'string' } } } } },
              '201'
            )
          }
        },
        '/users/{userId}': { get: { operationId: 'getUser', responses: jsonResponse({ type: 'object' }) } }
      })
    );
    expect(result.flow!.steps[0]!.extract).toEqual([{ variable: 'createUser.userId', jsonPath: '$.data.userId' }]);
  });

  // 10. Missing operationIds -> deterministic fallback ids
  it('synthesizes deterministic operationIds when the spec omits them', () => {
    const result = deriveFlowFromSpec(
      spec('Anon API', {
        '/items': {
          post: { responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }, '201') },
          get: { responses: jsonResponse({ type: 'array' }) }
        }
      })
    );
    expect(opIds(result.flow!.steps)).toEqual(['post-items', 'get-items']);
  });

  // 11. Empty / pathless spec -> null flow + fallback warning
  it('returns null flow for a spec with no operations', () => {
    const result = deriveFlowFromSpec(spec('Empty API', {}));
    expect(result.flow).toBeNull();
    expect(result.warnings.some((warning) => warning.message.includes('no operations'))).toBe(true);
  });

  // 12. Read-only API (no creates): GETs run in deterministic order with example bindings
  it('handles read-only APIs with unresolved params degrading to example bindings', () => {
    const result = deriveFlowFromSpec(
      spec('Reports API', {
        '/reports': { get: { operationId: 'listReports', responses: jsonResponse({ type: 'array' }) } },
        '/reports/{reportId}': { get: { operationId: 'getReport', responses: jsonResponse({ type: 'object' }) } }
      })
    );
    expect(opIds(result.flow!.steps)).toEqual(['listReports', 'getReport']);
    expect(result.flow!.steps[1]!.bindings).toEqual([{ fieldKey: 'reportId', source: 'example' }]);
    expect(result.trace.unresolvedParameterCount).toBe(1);
  });

  // 13. RPC-style API (POST actions, no CRUD shape)
  it('keeps RPC-style POST actions in deterministic path order after lifecycle ops', () => {
    const result = deriveFlowFromSpec(
      spec('RPC API', {
        '/search': { post: { operationId: 'runSearch', responses: jsonResponse({ type: 'object' }) } },
        '/export': { post: { operationId: 'runExport', responses: jsonResponse({ type: 'object' }) } },
        '/jobs/{jobId}/cancel': { post: { operationId: 'cancelJob', responses: jsonResponse({ type: 'object' }) } }
      })
    );
    expect(opIds(result.flow!.steps)).toEqual(['runExport', 'runSearch', 'cancelJob']);
  });

  // 14. Conventional {petId} ~ id matching
  it('matches {petId} path param to a producer property named id', () => {
    const result = deriveFlowFromSpec(
      spec('Convention API', {
        '/pets': {
          post: { operationId: 'createPet', responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }, '201') }
        },
        '/pets/{petId}': { get: { operationId: 'getPet', responses: jsonResponse({ type: 'object' }) } }
      })
    );
    expect(result.flow!.steps[1]!.bindings[0]).toMatchObject({
      fieldKey: 'petId',
      source: 'prior_output',
      variable: 'createPet.id'
    });
  });

  // 15. Determinism: identical input -> byte-identical output, key order shuffled -> same step order
  it('is deterministic across runs and across path key insertion order', () => {
    const pathsA: Record<string, unknown> = {
      '/b': { get: { operationId: 'listB', responses: jsonResponse({ type: 'array' }) } },
      '/a': { get: { operationId: 'listA', responses: jsonResponse({ type: 'array' }) } }
    };
    const pathsB: Record<string, unknown> = {
      '/a': { get: { operationId: 'listA', responses: jsonResponse({ type: 'array' }) } },
      '/b': { get: { operationId: 'listB', responses: jsonResponse({ type: 'array' }) } }
    };
    const one = deriveFlowFromSpec(spec('Det API', pathsA));
    const two = deriveFlowFromSpec(spec('Det API', pathsB));
    expect(JSON.stringify(one.flow)).toBe(JSON.stringify(two.flow));
    const again = deriveFlowFromSpec(spec('Det API', pathsA));
    expect(JSON.stringify(again.flow)).toBe(JSON.stringify(one.flow));
  });

  // 16. Multiple 2xx responses: prefers 200/201 deterministically
  it('prefers 200 then 201 then lexical 2xx when picking the success schema', () => {
    const result = deriveFlowFromSpec(
      spec('Codes API', {
        '/docs': {
          post: {
            operationId: 'createDoc',
            responses: {
              '202': { description: 'accepted', content: { 'application/json': { schema: { type: 'object', properties: { queueId: { type: 'string' } } } } } },
              '201': { description: 'created', content: { 'application/json': { schema: { type: 'object', properties: { docId: { type: 'string' } } } } } }
            }
          }
        },
        '/docs/{docId}': { get: { operationId: 'getDoc', responses: jsonResponse({ type: 'object' }) } }
      })
    );
    expect(result.flow!.steps[0]!.extract).toEqual([{ variable: 'createDoc.docId', jsonPath: '$.docId' }]);
  });

  // 17. Circular $ref schemas do not hang
  it('terminates on circular $ref schemas', () => {
    const result = deriveFlowFromSpec(
      spec(
        'Cyclic API',
        {
          '/nodes': {
            post: { operationId: 'createNode', responses: jsonResponse({ $ref: '#/components/schemas/Node' }, '201') }
          },
          '/nodes/{nodeId}': { get: { operationId: 'getNode', responses: jsonResponse({ $ref: '#/components/schemas/Node' }) } }
        },
        {
          schemas: {
            Node: {
              type: 'object',
              properties: { nodeId: { type: 'string' }, parent: { $ref: '#/components/schemas/Node' } }
            }
          }
        }
      )
    );
    expect(result.flow!.steps[0]!.extract).toEqual([{ variable: 'createNode.nodeId', jsonPath: '$.nodeId' }]);
  });

  // 18. Non-JSON content (XML / binary) yields no extracts but still orders steps
  it('derives ordering for non-JSON APIs without emitting extracts', () => {
    const result = deriveFlowFromSpec(
      spec('Files API', {
        '/files': {
          post: {
            operationId: 'uploadFile',
            responses: { '201': { description: 'created', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } }
          },
          get: { operationId: 'listFiles', responses: jsonResponse({ type: 'array' }) }
        }
      })
    );
    expect(opIds(result.flow!.steps)).toEqual(['uploadFile', 'listFiles']);
    expect(result.flow!.steps[0]!.extract).toEqual([]);
  });

  // 19. Same property name across resources: resource-scoped producer wins
  it('binds each resource to its own create id when property names collide', () => {
    const result = deriveFlowFromSpec(
      spec('Collision API', {
        '/cats': {
          post: { operationId: 'createCat', responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }, '201') }
        },
        '/cats/{catId}': { get: { operationId: 'getCat', responses: jsonResponse({ type: 'object' }) } },
        '/dogs': {
          post: { operationId: 'createDog', responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }, '201') }
        },
        '/dogs/{dogId}': { get: { operationId: 'getDog', responses: jsonResponse({ type: 'object' }) } }
      })
    );
    const byOp = new Map(result.flow!.steps.map((step) => [step.operationId, step]));
    expect(byOp.get('getCat')!.bindings[0]!.variable).toBe('createCat.id');
    expect(byOp.get('getDog')!.bindings[0]!.variable).toBe('createDog.id');
  });

  // 20. PATCH-only update + HEAD/OPTIONS ignored ordering
  it('ranks PATCH as update and keeps HEAD with non-CRUD operations', () => {
    const result = deriveFlowFromSpec(
      spec('Patchy API', {
        '/notes': {
          post: { operationId: 'createNote', responses: jsonResponse({ type: 'object', properties: { noteId: { type: 'string' } } }, '201') },
          head: { operationId: 'checkNotes', responses: { '200': { description: 'ok' } } }
        },
        '/notes/{noteId}': {
          patch: { operationId: 'patchNote', responses: jsonResponse({ type: 'object' }) }
        }
      })
    );
    expect(opIds(result.flow!.steps)).toEqual(['createNote', 'patchNote', 'checkNotes']);
  });
});
