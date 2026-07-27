import { describe, expect, it } from 'vitest';

import { deriveFlowFromSpec } from '../src/flow/derive.js';

/**
 * Spec-shape matrix: 15 structurally different API archetypes, each derived
 * twice to prove determinism, each checked for structural invariants:
 *  - every prior_output binding references an earlier step's extract variable
 *  - no DELETE step present without allowDelete
 *  - stepKeys unique
 *  - derivation is a pure function of the spec bytes
 */

type Spec = Record<string, unknown>;

function makeSpec(title: string, paths: Record<string, unknown>, components?: Record<string, unknown>): Spec {
  return { openapi: '3.0.3', info: { title, version: '1.0.0' }, paths, ...(components ? { components } : {}) };
}

const json = (schema: unknown, code = '200') => ({
  [code]: { description: 'ok', content: { 'application/json': { schema } } }
});
const obj = (props: Record<string, unknown>) => ({ type: 'object', properties: props });
const str = { type: 'string' };

const ARCHETYPES: Array<{ name: string; spec: Spec; expectSteps?: number; expectNullFlow?: boolean }> = [
  {
    name: '01 e-commerce multi-resource CRUD',
    spec: makeSpec('Shop', {
      '/products': { post: { operationId: 'createProduct', responses: json(obj({ productId: str }), '201') }, get: { operationId: 'listProducts', responses: json({ type: 'array' }) } },
      '/products/{productId}': { get: { operationId: 'getProduct', responses: json(obj({ productId: str })) }, put: { operationId: 'updateProduct', responses: json(obj({})) }, delete: { operationId: 'deleteProduct', responses: { '204': { description: 'x' } } } },
      '/orders': { post: { operationId: 'createOrder', responses: json(obj({ orderId: str }), '201') }, get: { operationId: 'listOrders', responses: json({ type: 'array' }) } },
      '/orders/{orderId}': { get: { operationId: 'getOrder', responses: json(obj({})) } },
      '/carts': { post: { operationId: 'createCart', responses: json(obj({ cartId: str }), '201') } },
      '/carts/{cartId}/items': { post: { operationId: 'addCartItem', responses: json(obj({ itemId: str }), '201') } }
    }),
    expectSteps: 9
  },
  {
    name: '02 banking API with deep nesting',
    spec: makeSpec('Bank', {
      '/accounts': { post: { operationId: 'openAccount', responses: json(obj({ accountId: str }), '201') } },
      '/accounts/{accountId}': { get: { operationId: 'getAccount', responses: json(obj({})) } },
      '/accounts/{accountId}/transactions': { post: { operationId: 'postTransaction', responses: json(obj({ transactionId: str }), '201') }, get: { operationId: 'listTransactions', responses: json({ type: 'array' }) } },
      '/accounts/{accountId}/transactions/{transactionId}': { get: { operationId: 'getTransaction', responses: json(obj({})) } }
    })
  },
  {
    name: '03 webhook/event API (POST-heavy RPC)',
    spec: makeSpec('Events', {
      '/events/publish': { post: { operationId: 'publishEvent', responses: json(obj({ eventId: str })) } },
      '/events/replay': { post: { operationId: 'replayEvents', responses: json(obj({})) } },
      '/subscriptions': { post: { operationId: 'subscribe', responses: json(obj({ subscriptionId: str }), '201') }, get: { operationId: 'listSubscriptions', responses: json({ type: 'array' }) } },
      '/subscriptions/{subscriptionId}': { delete: { operationId: 'unsubscribe', responses: { '204': { description: 'x' } } } }
    })
  },
  {
    name: '04 read-only analytics API',
    spec: makeSpec('Analytics', {
      '/metrics': { get: { operationId: 'listMetrics', responses: json({ type: 'array' }) } },
      '/metrics/{metricId}': { get: { operationId: 'getMetric', responses: json(obj({})) } },
      '/dashboards': { get: { operationId: 'listDashboards', responses: json({ type: 'array' }) } },
      '/reports/{reportId}/download': { get: { operationId: 'downloadReport', responses: { '200': { description: 'ok', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } } } } }
    })
  },
  {
    name: '05 auth/identity API with token flows',
    spec: makeSpec('Identity', {
      '/users': { post: { operationId: 'registerUser', responses: json(obj({ userId: str }), '201') } },
      '/users/{userId}': { get: { operationId: 'getUser', responses: json(obj({})) }, patch: { operationId: 'updateUser', responses: json(obj({})) } },
      '/sessions': { post: { operationId: 'login', responses: json(obj({ sessionToken: str, userId: str }), '201') } },
      '/sessions/current': { delete: { operationId: 'logout', responses: { '204': { description: 'x' } } } }
    })
  },
  {
    name: '06 file storage API (binary payloads)',
    spec: makeSpec('Storage', {
      '/buckets': { post: { operationId: 'createBucket', responses: json(obj({ bucketId: str }), '201') } },
      '/buckets/{bucketId}/files': { post: { operationId: 'uploadFile', responses: { '201': { description: 'x', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } }, get: { operationId: 'listFiles', responses: json({ type: 'array' }) } },
      '/buckets/{bucketId}/files/{fileId}': { get: { operationId: 'downloadFile', responses: { '200': { description: 'x', content: { 'application/octet-stream': { schema: { type: 'string' } } } } } } }
    })
  },
  {
    name: '07 GraphQL-over-REST hybrid (single POST endpoint)',
    spec: makeSpec('GraphQL', {
      '/graphql': { post: { operationId: 'executeQuery', responses: json(obj({ data: obj({}) })) } }
    }),
    expectSteps: 1
  },
  {
    name: '08 IoT telemetry API (time-series, no ids)',
    spec: makeSpec('IoT', {
      '/devices/{deviceId}/telemetry': { post: { operationId: 'ingestTelemetry', responses: { '202': { description: 'accepted' } } }, get: { operationId: 'queryTelemetry', responses: json({ type: 'array' }) } },
      '/devices': { get: { operationId: 'listDevices', responses: json({ type: 'array' }) } }
    })
  },
  {
    name: '09 versioned paths (/v1, /v2 prefixes)',
    spec: makeSpec('Versioned', {
      '/v1/widgets': { post: { operationId: 'createWidgetV1', responses: json(obj({ widgetId: str }), '201') } },
      '/v1/widgets/{widgetId}': { get: { operationId: 'getWidgetV1', responses: json(obj({})) } },
      '/v2/widgets': { post: { operationId: 'createWidgetV2', responses: json(obj({ widgetId: str }), '201') } },
      '/v2/widgets/{widgetId}': { get: { operationId: 'getWidgetV2', responses: json(obj({})) } }
    })
  },
  {
    name: '10 long-running jobs API (202 + polling)',
    spec: makeSpec('Jobs', {
      '/jobs': { post: { operationId: 'submitJob', responses: json(obj({ jobId: str }), '202') }, get: { operationId: 'listJobs', responses: json({ type: 'array' }) } },
      '/jobs/{jobId}': { get: { operationId: 'getJobStatus', responses: json(obj({ status: str })) } },
      '/jobs/{jobId}/cancel': { post: { operationId: 'cancelJob', responses: json(obj({})) } }
    })
  },
  {
    name: '11 UUID-keyed API with kebab paths',
    spec: makeSpec('Kebab', {
      '/service-requests': { post: { operationId: 'createServiceRequest', responses: json(obj({ id: str }), '201') } },
      '/service-requests/{id}': { get: { operationId: 'getServiceRequest', responses: json(obj({})) } }
    })
  },
  {
    name: '12 batch operations API',
    spec: makeSpec('Batch', {
      '/batch/users': { post: { operationId: 'batchCreateUsers', responses: json({ type: 'array', items: obj({ userId: str }) }, '201') } },
      '/users/{userId}': { get: { operationId: 'getUser', responses: json(obj({})) } }
    })
  },
  {
    name: '13 petstore classic (mixed param conventions)',
    spec: makeSpec('Petstore', {
      '/pet': { post: { operationId: 'addPet', responses: json(obj({ id: str }), '200') }, put: { operationId: 'updatePet', responses: json(obj({})) } },
      '/pet/{petId}': { get: { operationId: 'getPetById', responses: json(obj({})) }, delete: { operationId: 'deletePet', responses: { '400': { description: 'x' } } } },
      '/pet/findByStatus': { get: { operationId: 'findPetsByStatus', responses: json({ type: 'array' }) } },
      '/store/order': { post: { operationId: 'placeOrder', responses: json(obj({ id: str })) } },
      '/store/order/{orderId}': { get: { operationId: 'getOrderById', responses: json(obj({})) } }
    })
  },
  {
    name: '14 empty spec (no paths)',
    spec: makeSpec('Empty', {}),
    expectNullFlow: true
  },
  {
    name: '15 delete-only spec (all ops excluded)',
    spec: makeSpec('Reaper', {
      '/tombstones/{tombstoneId}': { delete: { operationId: 'deleteTombstone', responses: { '204': { description: 'x' } } } }
    }),
    expectNullFlow: true
  },
  {
    name: '16 oneOf/anyOf response composition',
    spec: makeSpec(
      'Composed',
      {
        '/policies': { post: { operationId: 'createPolicy', responses: json({ $ref: '#/components/schemas/PolicyResult' }, '201') } },
        '/policies/{policyId}': { get: { operationId: 'getPolicy', responses: json(obj({})) } }
      },
      { schemas: { PolicyResult: { allOf: [{ type: 'object', properties: { policyId: { type: 'string' } } }] } } }
    )
  },
  {
    name: '17 path params in middle segments',
    spec: makeSpec('MidParam', {
      '/tenants/{tenantId}/config': { get: { operationId: 'getTenantConfig', responses: json(obj({})) }, put: { operationId: 'setTenantConfig', responses: json(obj({})) } },
      '/tenants': { post: { operationId: 'createTenant', responses: json(obj({ tenantId: str }), '201') } }
    })
  }
];

describe('derivation spec-shape matrix', () => {
  for (const archetype of ARCHETYPES) {
    it(`derives deterministically: ${archetype.name}`, () => {
      const one = deriveFlowFromSpec(archetype.spec);
      const two = deriveFlowFromSpec(structuredClone(archetype.spec));
      expect(JSON.stringify(two.flow)).toBe(JSON.stringify(one.flow));

      if (archetype.expectNullFlow) {
        expect(one.flow).toBeNull();
        return;
      }
      expect(one.flow).not.toBeNull();
      const steps = one.flow!.steps;
      if (archetype.expectSteps !== undefined) {
        expect(steps.length).toBe(archetype.expectSteps);
      }

      // Invariant: unique stepKeys.
      const keys = steps.map((step) => step.stepKey);
      expect(new Set(keys).size).toBe(keys.length);

      // Invariant: no DELETE-derived steps by default (operationIds from excluded list absent).
      for (const excluded of one.excludedOperationIds) {
        expect(steps.some((step) => step.operationId === excluded)).toBe(false);
      }

      // Invariant: every prior_output binding references an extract from an EARLIER step.
      const seenVariables = new Set<string>();
      for (const step of steps) {
        for (const binding of step.bindings) {
          if (binding.source === 'prior_output') {
            expect(binding.variable && seenVariables.has(binding.variable)).toBe(true);
            const producerIndex = steps.findIndex((candidate) => candidate.stepKey === binding.sourceStepKey);
            const consumerIndex = steps.indexOf(step);
            expect(producerIndex).toBeGreaterThanOrEqual(0);
            expect(producerIndex).toBeLessThan(consumerIndex);
          }
        }
        for (const extract of step.extract) {
          seenVariables.add(extract.variable);
        }
      }
    });
  }
});
