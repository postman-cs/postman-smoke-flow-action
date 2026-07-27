import { describe, expect, it } from 'vitest';

import { deriveFlowFromSpec } from '../src/flow/derive.js';

type Spec = Record<string, unknown>;

function spec(title: string, paths: Record<string, unknown>, components?: Record<string, unknown>): Spec {
  return { openapi: '3.0.0', info: { title, version: '1.0.0' }, paths, ...(components ? { components } : {}) };
}

describe('schema traversal pins', () => {
  it('Q2-deep: property that $refs an allOf-only schema still surfaces the nested id', () => {
    const doc = spec(
      'AllOf Deep',
      {
        '/items': {
          post: {
            operationId: 'createItem',
            responses: {
              '201': {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/ItemEnvelope' } } }
                  }
                }
              }
            }
          }
        },
        '/items/{itemId}': {
          get: { operationId: 'getItem', responses: { '200': { description: 'ok' } } }
        }
      },
      {
        schemas: {
          ItemEnvelope: { allOf: [{ $ref: '#/components/schemas/ItemBase' }] },
          ItemBase: { type: 'object', properties: { id: { type: 'string' } } }
        }
      }
    );
    const result = deriveFlowFromSpec(doc as never);
    const create = result.flow?.steps.find((s) => s.operationId === 'createItem');
    const get = result.flow?.steps.find((s) => s.operationId === 'getItem');
    console.log('Q2-deep actual:', JSON.stringify({ extract: create?.extract, bindings: get?.bindings }));
    expect(create?.extract.some((e) => e.jsonPath === '$.data.id')).toBe(true);
    expect(get?.bindings.find((b) => b.fieldKey === 'itemId')?.source).toBe('prior_output');
  });

  it('Q3-conv: producer publishing plain `id` is hoisted for a conventional {reportId} consumer', () => {
    const doc = spec('Hoist Conv', {
      '/reports/{reportId}': {
        get: { operationId: 'getReport', responses: { '200': { description: 'ok' } } }
      },
      '/zwidgets': {
        post: {
          operationId: 'createWidget',
          responses: {
            '201': {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { id: { type: 'string' } } }
                }
              }
            }
          }
        }
      }
    });
    const result = deriveFlowFromSpec(doc as never);
    const order = result.flow?.steps.map((s) => s.operationId) ?? [];
    const get = result.flow?.steps.find((s) => s.operationId === 'getReport');
    const binding = get?.bindings.find((b) => b.fieldKey === 'reportId');
    console.log('Q3-conv actual:', JSON.stringify({ order, binding }));
    expect(binding?.source).toBe('prior_output');
    expect(order.indexOf('createWidget')).toBeLessThan(order.indexOf('getReport'));
  });

  it('Q5: a shared allOf-only schema referenced twice is not skipped as a false cycle', () => {
    // First reference exits via the no-properties path; the second must still
    // be traversed, and the shallower $.data.id must win over $.a.nested.id.
    const doc = spec(
      'Shared AllOf',
      {
        '/items': {
          post: {
            operationId: 'createItem',
            responses: {
              '201': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        a: {
                          type: 'object',
                          properties: { nested: { $ref: '#/components/schemas/Shared' } }
                        },
                        data: { $ref: '#/components/schemas/Shared' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        '/items/{itemId}': {
          get: { operationId: 'getItem', responses: { '200': { description: 'ok' } } }
        }
      },
      {
        schemas: {
          Shared: { allOf: [{ $ref: '#/components/schemas/SharedBase' }] },
          SharedBase: { type: 'object', properties: { id: { type: 'string' } } }
        }
      }
    );
    const result = deriveFlowFromSpec(doc as never);
    const create = result.flow?.steps.find((s) => s.operationId === 'createItem');
    const idExtract = create?.extract.find((e) => e.variable === 'createItem.id');
    expect(idExtract?.jsonPath).toBe('$.data.id');
  });
});
