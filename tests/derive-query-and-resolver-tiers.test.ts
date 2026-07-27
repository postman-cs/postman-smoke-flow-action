import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { deriveFlowFromSpec } from '../src/flow/derive.js';
import { resolveFlowRequests } from '../src/flow/resolver.js';
import type { FlowDefinition } from '../src/types.js';

type Spec = Record<string, unknown>;

function spec(paths: Record<string, unknown>): Spec {
  return { openapi: '3.0.3', info: { title: 'Probe API', version: '1.0.0' }, paths };
}

describe('derived query bindings and resolver tier precedence', () => {
  it.each([
    {
      name: 'a valid spec with zero operations',
      doc: spec({}),
      cause: 'found no operations in the OpenAPI document'
    },
    {
      name: 'a DELETE-only spec excluded by default',
      doc: spec({
        '/widgets/{widgetId}': {
          delete: {
            operationId: 'deleteWidget',
            responses: { '204': { description: 'deleted' } }
          }
        }
      }),
      cause: 'excluded every operation because each was a DELETE operation'
    }
  ])('Q3: $name produces an accurate hard-error cause', ({ doc, cause }) => {
    const result = deriveFlowFromSpec(doc as never);
    const warningText = result.warnings.map((warning) => warning.message).join('\n');

    expect(result.flow).toBeNull();
    expect(warningText).toContain(cause);
    expect(warningText).toContain('a smoke flow cannot be derived');
    expect(warningText).not.toContain('falling back to uncurated refresh');
  });

  it('Q-A: required query parameters produce example bindings so the transform preserves them', () => {
    const doc = spec({
      '/widgets': {
        get: {
          operationId: 'listWidgets',
          parameters: [
            { name: 'tenant', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } }
          ],
          responses: { '200': { description: 'ok' } }
        }
      }
    });
    const result = deriveFlowFromSpec(doc as never);
    const step = result.flow?.steps.find((s) => s.operationId === 'listWidgets');
    expect(step?.bindings.some((b) => b.fieldKey === 'tenant' && b.source === 'example')).toBe(true);
    expect(step?.bindings.some((b) => b.fieldKey === 'verbose')).toBe(false);
  });

  it('required query example/default literals are not embedded in structural flow bindings', () => {
    const doc = spec({
      '/widgets': {
        get: {
          operationId: 'listWidgets',
          parameters: [
            {
              name: 'tenant',
              in: 'query',
              required: true,
              example: 'SECRET_LITERAL_42',
              schema: { type: 'string', default: 'SECRET_LITERAL_42' }
            }
          ],
          responses: { '200': { description: 'ok' } }
        }
      }
    });
    const result = deriveFlowFromSpec(doc as never);
    const binding = result.flow?.steps[0]?.bindings.find((candidate) => candidate.fieldKey === 'tenant');
    expect(binding).toEqual({ fieldKey: 'tenant', source: 'example' });
    expect(binding).not.toHaveProperty('value');
    expect(binding?.source).not.toBe('literal');
    expect(JSON.stringify(result.flow)).not.toContain('SECRET_LITERAL_42');
  });

  it('Q-B: path-item-level required query parameters are honored too', () => {
    const doc = spec({
      '/reports': {
        parameters: [{ name: 'region', in: 'query', required: true, schema: { type: 'string' } }],
        get: { operationId: 'listReports', responses: { '200': { description: 'ok' } } }
      }
    });
    const result = deriveFlowFromSpec(doc as never);
    const step = result.flow?.steps.find((s) => s.operationId === 'listReports');
    expect(step?.bindings.some((b) => b.fieldKey === 'region' && b.source === 'example')).toBe(true);
  });

  it('Q-C: method+path tier beats a description-substring match on the wrong request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-flow-probe-'));
    const specPath = join(dir, 'openapi.json');
    writeFileSync(
      specPath,
      JSON.stringify(
        spec({
          '/items': { get: { responses: { '200': { description: 'ok' } } } },
          '/orders': { post: { operationId: 'createOrder', responses: { '201': { description: 'ok' } } } }
        })
      )
    );
    const flow: FlowDefinition = {
      name: 'probe',
      type: 'smoke',
      steps: [{ stepKey: 'get-items-1', operationId: 'get-items', bindings: [], extract: [] }]
    };
    const collection = {
      item: [
        {
          name: 'Create order',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/orders',
            description: 'Posts an order. See also get-items for listing.'
          }
        },
        {
          name: 'List items',
          request: { method: 'GET', url: '{{baseUrl}}/items' }
        }
      ]
    } as never;
    const resolved = resolveFlowRequests(flow, collection, specPath);
    const name = (resolved[0]?.item as { name?: string } | undefined)?.name;
    expect(name).toBe('List items');
  });

  it('Q-E: required query param chains prior_output from an exact-name producer, hoisting the producer resource', () => {
    // /audits sorts BEFORE /widgets lexically at equal depth, so without the
    // required-query dependency edge the consumer would run first and the
    // binding would degrade to example. The producer must be hoisted and the
    // query binding must chain.
    const doc = spec({
      '/audits': {
        get: {
          operationId: 'listAudits',
          parameters: [{ name: 'widgetId', in: 'query', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } }
        }
      },
      '/widgets': {
        post: {
          operationId: 'createWidget',
          responses: {
            '201': {
              description: 'created',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { widgetId: { type: 'string' } } }
                }
              }
            }
          }
        }
      }
    });
    const result = deriveFlowFromSpec(doc as never);
    const order = result.flow?.steps.map((s) => s.operationId);
    expect(order).toEqual(['createWidget', 'listAudits']);
    const step = result.flow?.steps.find((s) => s.operationId === 'listAudits');
    const binding = step?.bindings.find((b) => b.fieldKey === 'widgetId');
    expect(binding).toEqual({
      fieldKey: 'widgetId',
      source: 'prior_output',
      sourceStepKey: 'create-widget-1',
      variable: 'createWidget.widgetId'
    });
    expect(result.trace.bindingCount).toBe(1);
  });

  it('Q-D: description-substring fallback still resolves but warns', () => {
    const flow: FlowDefinition = {
      name: 'probe',
      type: 'smoke',
      steps: [{ stepKey: 'get-items-1', operationId: 'get-items', bindings: [], extract: [] }]
    };
    const collection = {
      item: [
        {
          name: 'Legacy listing request',
          request: {
            method: 'GET',
            url: '{{baseUrl}}/legacy',
            description: 'Implements get-items.'
          }
        }
      ]
    } as never;
    const warnings: string[] = [];
    const resolved = resolveFlowRequests(flow, collection, undefined, (m) => warnings.push(m));
    const name = (resolved[0]?.item as { name?: string } | undefined)?.name;
    expect(name).toBe('Legacy listing request');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('description substring');
  });
});
