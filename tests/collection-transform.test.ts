import { describe, expect, it } from 'vitest';

import { buildCuratedSmokeCollection } from '../src/postman/collection-transform.js';
import type { FlowDefinition, ResolvedRequest } from '../src/types.js';

const flow: FlowDefinition = {
  name: 'Payments API happy path',
  type: 'smoke',
  steps: [
    {
      stepKey: 'create-payment-1',
      operationId: 'createPayment',
      bindings: [],
      extract: [{ variable: 'createPayment.paymentId', jsonPath: '$.paymentId' }]
    },
    {
      stepKey: 'get-payment-by-id-2',
      operationId: 'getPaymentById',
      bindings: [
        {
          fieldKey: 'paymentId',
          source: 'prior_output',
          sourceStepKey: 'create-payment-1',
          variable: 'createPayment.paymentId'
        }
      ],
      extract: []
    }
  ]
};

describe('collection transform', () => {
  it('builds a curated smoke collection with scripted requests', () => {
    const generatedCollection = {
      info: { name: '[Smoke][Temp] Payments API', _postman_id: 'info-123' },
      uid: '54270406-collection-uid-123',
      response: [{ id: 'resp-123' }],
      item: []
    };
    const resolvedRequests: ResolvedRequest[] = [
      {
        step: flow.steps[0]!,
        item: {
          name: 'createPayment',
          id: '11111111-1111-1111-1111-111111111111',
          uid: '54270406-11111111-1111-1111-1111-111111111111',
          request: {
            method: 'POST',
            url: 'https://api.example.com/payments',
            body: {
              mode: 'raw',
              raw: '{"amount":"10"}'
            }
          },
          response: [{ id: 'resp-123' }]
        }
      },
      {
        step: flow.steps[1]!,
        item: {
          name: 'getPaymentById',
          id: '22222222-2222-2222-2222-222222222222',
          uid: '54270406-22222222-2222-2222-2222-222222222222',
          request: {
            method: 'GET',
            url: 'https://api.example.com/payments/{paymentId}'
          },
          response: [{ id: 'resp-456' }]
        }
      }
    ];

    const result = buildCuratedSmokeCollection(generatedCollection, flow, resolvedRequests);
    const items = result.collection.item as Array<Record<string, unknown>>;

    expect(result.bindingCount).toBe(1);
    expect(result.extractCount).toBe(1);
    expect((result.collection.info as Record<string, unknown>).name).toBe('[Smoke] Payments API happy path');
    expect((result.collection.info as Record<string, unknown>)._postman_id).toBeUndefined();
    expect((result.collection as Record<string, unknown>).uid).toBeUndefined();
    expect((result.collection as Record<string, unknown>).response).toBeUndefined();
    expect(items[0]?.name).toBe('00 - Resolve Secrets');
    expect(items[2]?.request).toBeDefined();
    expect((items[1] as Record<string, unknown>).id).toBeUndefined();
    expect((items[1] as Record<string, unknown>).uid).toBeUndefined();
    expect((items[1] as Record<string, unknown>).response).toBeUndefined();
    expect((items[2] as Record<string, unknown>).id).toBeUndefined();
    expect((items[2] as Record<string, unknown>).uid).toBeUndefined();
    expect((items[2] as Record<string, unknown>).response).toBeUndefined();
    expect(JSON.stringify(items[2])).toContain('{{paymentId}}');
    expect(JSON.stringify(items[1])).toContain('Extract createPayment.paymentId');
  });

  it('preserves generated example values for source=example bindings', () => {
    const exampleFlow: FlowDefinition = {
      name: 'Remote POS happy path',
      type: 'smoke',
      steps: [
        {
          stepKey: 'create-remote-invoice-1',
          operationId: 'createRemoteInvoice',
          bindings: [
            {
              fieldKey: 'customer.customerNumber',
              source: 'example'
            }
          ],
          extract: [{ variable: 'createRemoteInvoice.invoiceNumber', jsonPath: '$.invoiceNumber' }]
        }
      ]
    };

    const generatedCollection = {
      info: { name: '[Smoke][Temp] Remote POS API' },
      item: []
    };
    const resolvedRequests: ResolvedRequest[] = [
      {
        step: exampleFlow.steps[0]!,
        item: {
          name: 'createRemoteInvoice',
          request: {
            method: 'POST',
            url: 'https://api.example.com/remote-invoices',
            body: {
              mode: 'raw',
              raw: '{"customer":{"customerNumber":90001234},"delivery":true}'
            }
          }
        }
      }
    ];

    const result = buildCuratedSmokeCollection(generatedCollection, exampleFlow, resolvedRequests);
    const items = result.collection.item as Array<Record<string, unknown>>;
    const requestBody = JSON.stringify((items[1] as Record<string, unknown>).request);
    const prerequest = JSON.stringify((items[1] as Record<string, unknown>).event);

    expect(requestBody).toContain('90001234');
    expect(requestBody).not.toContain('{{customer.customerNumber}}');
    expect(prerequest).not.toContain('customer.customerNumber');
  });

  it('removes generated query params that are not selected in flow bindings', () => {
    const providerFlow: FlowDefinition = {
      name: 'Providers happy path',
      type: 'smoke',
      steps: [
        {
          stepKey: 'search-providers-1',
          operationId: 'searchProviders',
          bindings: [
            { fieldKey: 'source', source: 'literal', value: 'kyruus' },
            { fieldKey: 'telehealth', source: 'literal', value: 'true' },
            { fieldKey: 'location-lat', source: 'literal', value: '33.28516' },
            { fieldKey: 'location-lon', source: 'literal', value: '-111.857176' },
            { fieldKey: 'distance', source: 'literal', value: '5' }
          ],
          extract: []
        }
      ]
    };

    const generatedCollection = {
      info: { name: '[Smoke][Temp] Providers API' },
      item: []
    };
    const resolvedRequests: ResolvedRequest[] = [
      {
        step: providerFlow.steps[0]!,
        item: {
          name: 'searchProviders',
          request: {
            method: 'GET',
            url: {
              raw:
                '{{baseUrl}}/v1/providers?provider-id=prov-elena-martinez&location-lat={{location-lat}}&location-lon={{location-lon}}&distance={{distance}}&telehealth={{telehealth}}&accepting-new-patients=true&page-size=25&source={{source}}',
              host: ['{{baseUrl}}'],
              path: ['v1', 'providers'],
              query: [
                { key: 'provider-id', value: 'prov-elena-martinez' },
                { key: 'location-lat', value: '{{location-lat}}' },
                { key: 'location-lon', value: '{{location-lon}}' },
                { key: 'distance', value: '{{distance}}' },
                { key: 'telehealth', value: '{{telehealth}}' },
                { key: 'accepting-new-patients', value: 'true' },
                { key: 'page-size', value: '25' },
                { key: 'source', value: '{{source}}' }
              ]
            }
          }
        }
      }
    ];

    const result = buildCuratedSmokeCollection(generatedCollection, providerFlow, resolvedRequests);
    const items = result.collection.item as Array<Record<string, unknown>>;
    const request = (items[1] as Record<string, unknown>).request as Record<string, unknown>;
    const url = request.url as Record<string, unknown>;
    const query = url.query as Array<Record<string, unknown>>;

    expect(url.raw).toBe(
      '{{baseUrl}}/v1/providers?location-lat={{location-lat}}&location-lon={{location-lon}}&distance={{distance}}&telehealth={{telehealth}}&source={{source}}'
    );
    expect(query.map((entry) => entry.key)).toEqual(['location-lat', 'location-lon', 'distance', 'telehealth', 'source']);
    expect(JSON.stringify(url)).not.toContain('provider-id');
    expect(JSON.stringify(url)).not.toContain('accepting-new-patients');
    expect(JSON.stringify(url)).not.toContain('page-size');
  });

  it('preserves selected source=example query params while pruning unselected params', () => {
    const exampleFlow: FlowDefinition = {
      name: 'Providers happy path',
      type: 'smoke',
      steps: [
        {
          stepKey: 'alternate-providers-1',
          operationId: 'listAlternateProviders',
          bindings: [
            { fieldKey: 'providerId', source: 'example' },
            { fieldKey: 'use-care-team', source: 'example' }
          ],
          extract: []
        }
      ]
    };

    const result = buildCuratedSmokeCollection(
      { info: { name: '[Smoke][Temp] Providers API' }, item: [] },
      exampleFlow,
      [
        {
          step: exampleFlow.steps[0]!,
          item: {
            name: 'listAlternateProviders',
            request: {
              method: 'GET',
              url: '{{baseUrl}}/v1/providers/{providerId}/alternates?providerId=prov-123&use-care-team=true&use-location=true'
            }
          }
        }
      ]
    );

    const items = result.collection.item as Array<Record<string, unknown>>;
    const request = (items[1] as Record<string, unknown>).request as Record<string, unknown>;

    expect(request.url).toBe('{{baseUrl}}/v1/providers/{providerId}/alternates?providerId=prov-123&use-care-team=true');
  });
});
