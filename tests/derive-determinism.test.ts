import { describe, expect, it } from 'vitest';

import { deriveFlowFromSpec } from '../src/flow/derive.js';

type Spec = Record<string, unknown>;

function spec(title: string, paths: Record<string, unknown>, components?: Record<string, unknown>): Spec {
  return {
    openapi: '3.0.0',
    info: { title, version: '1.0.0' },
    paths,
    ...(components ? { components } : {})
  };
}

describe('derivation determinism and hoisting pins', () => {
  it('Q2: nested $ref to an allOf-only schema yields an id extract and a bound read', () => {
    const doc = spec(
      'AllOf Nested',
      {
        '/items': {
          post: {
            operationId: 'createItem',
            responses: {
              '201': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/ItemEnvelope' }
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
    console.log('Q2 actual:', JSON.stringify({ createExtract: create?.extract, getBindings: get?.bindings }));
    expect(create?.extract.some((e) => e.jsonPath === '$.id')).toBe(true);
    const binding = get?.bindings.find((b) => b.fieldKey === 'itemId');
    expect(binding?.source).toBe('prior_output');
  });

  it('Q1: colliding fallback operationIds are assigned deterministically regardless of path insertion order', () => {
    // /foo/bar and /foo-bar slug to the same fallback operationId.
    const post = { post: { responses: { '201': { description: 'ok' } } } };
    const pathsA: Record<string, unknown> = { '/foo/bar': post, '/foo-bar': post };
    const pathsB: Record<string, unknown> = { '/foo-bar': post, '/foo/bar': post };
    const r1 = deriveFlowFromSpec(spec('Order', pathsA) as never);
    const r2 = deriveFlowFromSpec(spec('Order', pathsB) as never);
    const byPathIds = (r: typeof r1) => JSON.stringify(r.flow?.steps.map((s) => s.operationId).sort());
    // Semantic requirement: for each PATH, the same operationId in both derivations.
    // Steps carry only operationId, so compare full step arrays: equivalent specs
    // must derive identical flows (docs/derived-flow.md determinism clause).
    console.log('Q1 actual:', JSON.stringify({ a: r1.flow?.steps, b: r2.flow?.steps }));
    expect(r1.flow?.steps).toEqual(r2.flow?.steps);
    expect(byPathIds(r1)).toBe(byPathIds(r2));
  });

  it('Q3: conventional global id producer is hoisted before its consumer', () => {
    // Consumer resource /reports sorts lexically before producer? No: force it.
    // Producer /zaccounts publishes conventional `reportId`; consumer /reports/{reportId}.
    const doc = spec('Hoist', {
      '/reports/{reportId}': {
        get: { operationId: 'getReport', responses: { '200': { description: 'ok' } } }
      },
      '/zaccounts': {
        post: {
          operationId: 'createAccount',
          responses: {
            '201': {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { reportId: { type: 'string' } } }
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
    console.log('Q3 actual:', JSON.stringify({ order, binding }));
    expect(binding?.source).toBe('prior_output');
    expect(order.indexOf('createAccount')).toBeLessThan(order.indexOf('getReport'));
  });
});
