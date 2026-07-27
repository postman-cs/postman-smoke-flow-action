import { describe, expect, it } from 'vitest';

import { deriveFlowFromSpec } from '../src/flow/derive.js';

type Spec = Record<string, unknown>;

function spec(title: string, paths: Record<string, unknown>): Spec {
  return { openapi: '3.0.3', info: { title, version: '1.0.0' }, paths };
}

function jsonResponse(schema: unknown, code = '200'): Record<string, unknown> {
  return { [code]: { description: 'ok', content: { 'application/json': { schema } } } };
}

describe('derived extract provenance', () => {
  it('OpenAPI 3.1 nullable-union arrays never produce an extract', () => {
    // an array-valued property has ambiguous item identity, so a nullable union must be treated as its non-null member.
    const document = {
      openapi: '3.1.0',
      info: { title: 'Things API', version: '1.0.0' },
      paths: {
        '/things': {
          post: {
            operationId: 'createThing',
            responses: jsonResponse(
              {
                type: 'object',
                properties: { thingId: { type: ['array', 'null'], items: { type: 'string' } } }
              },
              '201'
            )
          }
        },
        '/things/{thingId}': {
          get: { operationId: 'getThing', responses: jsonResponse({ type: 'object' }) }
        }
      }
    };
    const result = deriveFlowFromSpec(document);
    const create = result.flow!.steps.find((s) => s.operationId === 'createThing')!;
    expect(create.extract).toEqual([]);
  });

  it('plain array-valued response properties also yield no extract (control)', () => {
    const result = deriveFlowFromSpec(
      spec('Things API', {
        '/things': {
          post: {
            operationId: 'createThing',
            responses: jsonResponse(
              {
                type: 'object',
                properties: { thingId: { type: 'array', items: { type: 'string' } } }
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
    expect(create.extract).toEqual([]);
  });

  it('an id-suffixed response property with no consuming path parameter is not published', () => {
    // an extract exists only to feed a prior_output binding, so an unconsumed property must not emit a hard `expected extracted value to exist` assertion.
    const result = deriveFlowFromSpec(
      spec('Ops API', {
        '/ops': {
          post: {
            operationId: 'runOp',
            responses: jsonResponse({
              type: 'object',
              properties: { ErrorId: { type: ['integer', 'null'] }, isSuccess: { type: 'boolean' } }
            })
          }
        }
      })
    );
    const runOp = result.flow!.steps.find((s) => s.operationId === 'runOp')!;
    expect(runOp.extract).toEqual([]);
    expect(result.trace.extractCount).toBe(0);
  });

  it('a consumed id is still published', () => {
    const result = deriveFlowFromSpec(
      spec('Payments API', {
        '/payments': {
          post: {
            operationId: 'createPayment',
            responses: jsonResponse({ type: 'object', properties: { paymentId: { type: 'string' } } }, '201')
          }
        },
        '/payments/{paymentId}': {
          get: { operationId: 'getPaymentById', responses: jsonResponse({ type: 'object' }) }
        }
      })
    );
    const create = result.flow!.steps.find((s) => s.operationId === 'createPayment')!;
    const read = result.flow!.steps.find((s) => s.operationId === 'getPaymentById')!;
    expect(create.extract).toEqual([{ variable: 'createPayment.paymentId', jsonPath: '$.paymentId' }]);
    expect(read.bindings).toEqual([
      { fieldKey: 'paymentId', source: 'prior_output', sourceStepKey: create.stepKey, variable: 'createPayment.paymentId' }
    ]);
  });

  it('nullable-array payload plus unconsumed error id yields zero extracts (Clean Harbors Drum API shape)', () => {
    // Clean Harbors Drum API shape that made a shared Postman mock gate red.
    const result = deriveFlowFromSpec(
      spec('Drum API', {
        '/GenerateDrumNumber': {
          post: {
            operationId: 'generateDrumNumber',
            responses: jsonResponse({
              type: 'object',
              properties: { DrumTrackingList: { type: ['array', 'null'], items: { type: 'string' } } }
            })
          }
        },
        '/createretaildrums': {
          post: {
            operationId: 'createRetailDrums',
            responses: jsonResponse({
              type: 'object',
              properties: { isSuccess: { type: 'boolean' }, ErrorId: { type: ['integer', 'null'] } }
            })
          }
        },
        '/{drum_no}': {
          get: { operationId: 'getDrum', responses: jsonResponse({ type: 'object' }) }
        }
      })
    );
    expect(result.trace.extractCount).toBe(0);
    for (const step of result.flow!.steps) {
      expect(step.extract).toEqual([]);
    }
    // Nothing publishes drum_no, so GET /:drum_no is excluded rather than derived
    // with an unsubstituted path segment. This is the ADO getDrumData 404.
    expect(result.flow!.steps.some((s) => s.operationId === 'getDrum')).toBe(false);
    expect(result.excludedOperationIds).toEqual(['getDrum']);
    expect(result.trace.excludedUnresolvedPathParamCount).toBe(1);
  });
});
