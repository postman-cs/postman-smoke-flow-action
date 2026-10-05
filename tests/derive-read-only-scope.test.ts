import { describe, expect, it } from 'vitest';

import { deriveFlowFromSpec } from '../src/flow/derive.js';
import { parseFlowDeriveScope } from '../src/index.js';
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

function envelope(key: string, itemProps: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      [key]: { type: 'array', items: { type: 'object', properties: itemProps } },
      count: { type: 'integer' }
    }
  };
}

function opIds(steps: FlowStep[]): string[] {
  return steps.map((step) => step.operationId);
}

function step(steps: FlowStep[], operationId: string): FlowStep {
  const found = steps.find((entry) => entry.operationId === operationId);
  if (!found) throw new Error(`missing step ${operationId}`);
  return found;
}

function petsSpec(): Spec {
  return spec('Pets API', {
    '/pets': {
      post: {
        operationId: 'createPet',
        responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }, '201')
      },
      get: {
        operationId: 'listPets',
        responses: jsonResponse(envelope('data', { id: { type: 'string' }, name: { type: 'string' } }))
      }
    },
    '/pets/{petId}': {
      get: { operationId: 'getPet', responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }) },
      patch: { operationId: 'updatePet', responses: jsonResponse({ type: 'object' }) },
      delete: { operationId: 'deletePet', responses: { '204': { description: 'gone' } } }
    }
  });
}

describe('deriveFlowFromSpec scope=read-only', () => {
  it('derives GETs only and chains list -> read from the first list item', () => {
    const result = deriveFlowFromSpec(petsSpec(), { scope: 'read-only' });

    expect(result.flow).not.toBeNull();
    expect(opIds(result.flow!.steps)).toEqual(['listPets', 'getPet']);
    expect(step(result.flow!.steps, 'listPets').extract).toEqual([
      { variable: 'listPets.id', jsonPath: '$.data[0].id' }
    ]);
    expect(step(result.flow!.steps, 'getPet').bindings).toEqual([
      {
        fieldKey: 'petId',
        source: 'prior_output',
        sourceStepKey: step(result.flow!.steps, 'listPets').stepKey,
        variable: 'listPets.id'
      }
    ]);
    expect(result.excludedOperationIds).toEqual(['createPet', 'deletePet', 'updatePet']);
    expect(result.trace.scope).toBe('read-only');
    expect(result.trace.excludedNonReadCount).toBe(3);
    expect(result.trace.excludedDeleteCount).toBe(0);
  });

  it('never includes a non-GET operation even when flow-allow-delete is set', () => {
    const result = deriveFlowFromSpec(petsSpec(), { scope: 'read-only', allowDelete: true });
    expect(opIds(result.flow!.steps)).toEqual(['listPets', 'getPet']);
    expect(result.excludedOperationIds).toContain('deletePet');
  });

  it('binds identifier-shaped parameters to a guid surrogate key and reads the items envelope', () => {
    const result = deriveFlowFromSpec(
      spec('Heatmap-like API', {
        '/tract-fips': {
          get: {
            operationId: 'TractFip_GetList',
            responses: jsonResponse(envelope('items', { guid: { type: 'string' }, tractName: { type: 'string' } }))
          }
        },
        '/tract-fips/{tractFipsId}': {
          get: { operationId: 'TractFip_Get', responses: jsonResponse({ type: 'object' }) }
        },
        '/fips-eligibility': {
          get: {
            operationId: 'FipsEligibility_GetList',
            responses: jsonResponse(envelope('data', { guid: { type: 'string' } }))
          }
        },
        '/fips-eligibility/{guid}': {
          get: { operationId: 'FipsEligibility_Get', responses: jsonResponse({ type: 'object' }) }
        }
      })
    );
    // Default scope cannot chain these: no create step publishes an id.
    expect(result.excludedOperationIds).toEqual(['FipsEligibility_Get', 'TractFip_Get']);

    const readOnly = deriveFlowFromSpec(
      spec('Heatmap-like API', {
        '/tract-fips': {
          get: {
            operationId: 'TractFip_GetList',
            responses: jsonResponse(envelope('items', { guid: { type: 'string' }, tractName: { type: 'string' } }))
          }
        },
        '/tract-fips/{tractFipsId}': {
          get: { operationId: 'TractFip_Get', responses: jsonResponse({ type: 'object' }) }
        },
        '/fips-eligibility': {
          get: {
            operationId: 'FipsEligibility_GetList',
            responses: jsonResponse(envelope('data', { guid: { type: 'string' } }))
          }
        },
        '/fips-eligibility/{guid}': {
          get: { operationId: 'FipsEligibility_Get', responses: jsonResponse({ type: 'object' }) }
        }
      }),
      { scope: 'read-only' }
    );
    const steps = readOnly.flow!.steps;
    expect(opIds(steps)).toEqual(['FipsEligibility_GetList', 'FipsEligibility_Get', 'TractFip_GetList', 'TractFip_Get']);
    expect(step(steps, 'TractFip_GetList').extract).toEqual([
      { variable: 'TractFip_GetList.guid', jsonPath: '$.items[0].guid' }
    ]);
    expect(step(steps, 'TractFip_Get').bindings[0]).toMatchObject({
      fieldKey: 'tractFipsId',
      source: 'prior_output',
      variable: 'TractFip_GetList.guid'
    });
    expect(step(steps, 'FipsEligibility_Get').bindings[0]).toMatchObject({
      fieldKey: 'guid',
      source: 'prior_output',
      variable: 'FipsEligibility_GetList.guid'
    });
    expect(readOnly.excludedOperationIds).toEqual([]);
  });

  it('resolves list envelopes and item schemas through $ref and allOf', () => {
    const result = deriveFlowFromSpec(
      spec(
        'Ref API',
        {
          '/batch-process': {
            get: { operationId: 'listBatches', responses: jsonResponse({ $ref: '#/components/schemas/BatchPage' }) }
          },
          '/batch-process/{batchProcessId}': {
            get: { operationId: 'getBatch', responses: jsonResponse({ $ref: '#/components/schemas/Batch' }) }
          }
        },
        {
          schemas: {
            BatchPage: {
              allOf: [
                { $ref: '#/components/schemas/PageMeta' },
                { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/BatchModel' } } } }
              ]
            },
            PageMeta: { type: 'object', properties: { totalCount: { type: 'integer' } } },
            BatchModel: { allOf: [{ $ref: '#/components/schemas/Batch' }, { type: 'object' }] },
            Batch: { type: 'object', properties: { guid: { type: 'string' }, status: { type: 'string' } } }
          }
        }
      ),
      { scope: 'read-only' }
    );
    expect(opIds(result.flow!.steps)).toEqual(['listBatches', 'getBatch']);
    expect(step(result.flow!.steps, 'listBatches').extract).toEqual([
      { variable: 'listBatches.guid', jsonPath: '$.items[0].guid' }
    ]);
  });

  it('chains nested resources through owner-scoped list producers', () => {
    const result = deriveFlowFromSpec(
      spec('Accounts API', {
        '/accounts': {
          get: { operationId: 'listAccounts', responses: jsonResponse(envelope('data', { id: { type: 'string' } })) }
        },
        '/accounts/{accountId}/orders': {
          get: { operationId: 'listOrders', responses: jsonResponse(envelope('data', { orderId: { type: 'string' } })) }
        },
        '/accounts/{accountId}/orders/{orderId}': {
          get: { operationId: 'getOrder', responses: jsonResponse({ type: 'object' }) }
        }
      }),
      { scope: 'read-only' }
    );
    const steps = result.flow!.steps;
    expect(opIds(steps)).toEqual(['listAccounts', 'listOrders', 'getOrder']);
    expect(step(steps, 'listOrders').bindings).toEqual([
      expect.objectContaining({ fieldKey: 'accountId', source: 'prior_output', variable: 'listAccounts.id' })
    ]);
    expect(step(steps, 'listOrders').extract).toEqual([
      { variable: 'listOrders.orderId', jsonPath: '$.data[0].orderId' }
    ]);
    expect(step(steps, 'getOrder').bindings).toEqual([
      expect.objectContaining({ fieldKey: 'accountId', variable: 'listAccounts.id' }),
      expect.objectContaining({ fieldKey: 'orderId', variable: 'listOrders.orderId' })
    ]);
  });

  it('never feeds one resource list into another resource parameter', () => {
    const result = deriveFlowFromSpec(
      spec('Scoped API', {
        '/owners': {
          get: { operationId: 'listOwners', responses: jsonResponse(envelope('data', { id: { type: 'string' } })) }
        },
        '/pets/{petId}': {
          get: { operationId: 'getPet', responses: jsonResponse({ type: 'object' }) }
        }
      }),
      { scope: 'read-only' }
    );
    expect(opIds(result.flow!.steps)).toEqual(['listOwners']);
    expect(result.excludedOperationIds).toEqual(['getPet']);
    expect(result.trace.excludedUnresolvedPathParamCount).toBe(1);
  });

  it('does not bind a non-identifier parameter to a surrogate id', () => {
    const result = deriveFlowFromSpec(
      spec('Slug API', {
        '/articles': {
          get: { operationId: 'listArticles', responses: jsonResponse(envelope('data', { id: { type: 'string' } })) }
        },
        '/articles/{slug}': {
          get: { operationId: 'getArticle', responses: jsonResponse({ type: 'object' }) }
        }
      }),
      { scope: 'read-only' }
    );
    expect(opIds(result.flow!.steps)).toEqual(['listArticles']);
    expect(step(result.flow!.steps, 'listArticles').extract).toEqual([]);
    expect(result.excludedOperationIds).toEqual(['getArticle']);
  });

  it('binds a non-identifier parameter when the list item carries the exact name', () => {
    const result = deriveFlowFromSpec(
      spec('Slug API', {
        '/articles': {
          get: {
            operationId: 'listArticles',
            responses: jsonResponse(envelope('data', { id: { type: 'string' }, slug: { type: 'string' } }))
          }
        },
        '/articles/{slug}': {
          get: { operationId: 'getArticle', responses: jsonResponse({ type: 'object' }) }
        }
      }),
      { scope: 'read-only' }
    );
    expect(opIds(result.flow!.steps)).toEqual(['listArticles', 'getArticle']);
    expect(step(result.flow!.steps, 'listArticles').extract).toEqual([
      { variable: 'listArticles.slug', jsonPath: '$.data[0].slug' }
    ]);
  });

  it('leaves top-level array and ambiguous envelope lists without extracts', () => {
    const result = deriveFlowFromSpec(
      spec('Shapes API', {
        '/bare': {
          get: { operationId: 'listBare', responses: jsonResponse({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } }) }
        },
        '/bare/{bareId}': { get: { operationId: 'getBare', responses: jsonResponse({ type: 'object' }) } },
        '/ambiguous': {
          get: {
            operationId: 'listAmbiguous',
            responses: jsonResponse({
              type: 'object',
              properties: {
                alpha: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
                beta: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } }
              }
            })
          }
        },
        '/ambiguous/{ambiguousId}': { get: { operationId: 'getAmbiguous', responses: jsonResponse({ type: 'object' }) } }
      }),
      { scope: 'read-only' }
    );
    expect(opIds(result.flow!.steps)).toEqual(['listAmbiguous', 'listBare']);
    expect(result.excludedOperationIds).toEqual(['getAmbiguous', 'getBare']);
  });

  it('keeps required query parameters as example bindings', () => {
    const result = deriveFlowFromSpec(
      spec('Geo API', {
        '/heat-map': {
          get: {
            operationId: 'getHeatMap',
            parameters: [
              { name: 'Latitude', in: 'query', required: true, schema: { type: 'number' } },
              { name: 'Longitude', in: 'query', required: true, schema: { type: 'number' } },
              { name: 'Zoom', in: 'query', schema: { type: 'integer' } }
            ],
            responses: jsonResponse({ type: 'object' })
          }
        }
      }),
      { scope: 'read-only' }
    );
    expect(step(result.flow!.steps, 'getHeatMap').bindings).toEqual([
      { fieldKey: 'Latitude', source: 'example' },
      { fieldKey: 'Longitude', source: 'example' }
    ]);
  });

  it('fails derivation with a scope-specific message when the spec has no GET operations', () => {
    const result = deriveFlowFromSpec(
      spec('Write-only API', {
        '/events': { post: { operationId: 'createEvent', responses: jsonResponse({ type: 'object' }, '201') } }
      }),
      { scope: 'read-only' }
    );
    expect(result.flow).toBeNull();
    expect(result.excludedOperationIds).toEqual(['createEvent']);
    expect(result.trace.excludedNonReadCount).toBe(1);
    expect(result.warnings[0]?.message).toContain('flow-derive-scope=read-only');
  });

  it('is deterministic for the same spec', () => {
    const first = deriveFlowFromSpec(petsSpec(), { scope: 'read-only' });
    const second = deriveFlowFromSpec(petsSpec(), { scope: 'read-only' });
    expect(second).toEqual(first);
  });
});

describe('deriveFlowFromSpec default scope is unchanged', () => {
  it('omitting scope and scope=full derive the same full-lifecycle flow', () => {
    const implicit = deriveFlowFromSpec(petsSpec());
    const explicit = deriveFlowFromSpec(petsSpec(), { scope: 'full' });
    expect(explicit).toEqual(implicit);
    expect(opIds(implicit.flow!.steps)).toEqual(['createPet', 'listPets', 'getPet', 'updatePet']);
    expect(step(implicit.flow!.steps, 'listPets').extract).toEqual([]);
    expect(implicit.trace.scope).toBe('full');
    expect(implicit.trace.excludedNonReadCount).toBe(0);
    expect(implicit.excludedOperationIds).toEqual(['deletePet']);
  });
});

describe('parseFlowDeriveScope', () => {
  it('defaults to full and accepts read-only case-insensitively', () => {
    expect(parseFlowDeriveScope(undefined)).toBe('full');
    expect(parseFlowDeriveScope('')).toBe('full');
    expect(parseFlowDeriveScope('FULL')).toBe('full');
    expect(parseFlowDeriveScope(' Read-Only ')).toBe('read-only');
  });

  it('rejects unknown scopes', () => {
    expect(() => parseFlowDeriveScope('get-only')).toThrow('Invalid flow-derive-scope');
  });
});
