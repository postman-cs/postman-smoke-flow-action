import { describe, expect, it } from 'vitest';

import { applySmokeCollectionAuth, buildCuratedSmokeCollection } from '../src/postman/collection-transform.js';
import type { FlowDefinition, ResolvedRequest, SmokeAuthConfig } from '../src/types.js';

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

const oauthConfig: SmokeAuthConfig = {
  enabled: true,
  type: 'oauth2',
  grantType: 'client_credentials',
  tokenUrl: '{{auth_token_url}}',
  clientAuthentication: 'body',
  request: {
    contentType: 'application/x-www-form-urlencoded'
  },
  variables: {
    tokenUrl: 'auth_token_url',
    scope: 'auth_scope',
    clientId: 'auth_client_id',
    clientSecret: 'auth_client_secret',
    accessToken: 'access_token',
    expiresAt: 'access_token_expires_at'
  },
  cache: {
    refreshSkewSeconds: 60
  },
  apply: {
    header: 'Authorization',
    value: 'Bearer {{access_token}}'
  }
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
    expect(items).toHaveLength(3);
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

  it('omits the legacy AWS secrets resolver only when explicitly opted out', () => {
    const result = buildCuratedSmokeCollection(
      { info: { name: '[Smoke][Temp] Payments API' }, item: [] },
      flow,
      [
        {
          step: flow.steps[0]!,
          item: {
            name: 'createPayment',
            request: {
              method: 'POST',
              url: 'https://api.example.com/payments'
            }
          }
        }
      ],
      undefined,
      false
    );
    const items = result.collection.item as Array<Record<string, unknown>>;

    expect(items).toHaveLength(1);
    expect(items.map((item) => item.name)).not.toContain('00 - Resolve Secrets');
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

  it('adds optional OAuth token caching, placeholder variables, and bearer auth without serializing secrets', () => {
    const result = buildCuratedSmokeCollection(
      { info: { name: '[Smoke][Temp] Payments API' }, item: [] },
      flow,
      [
        {
          step: flow.steps[0]!,
          item: {
            name: 'createPayment',
            request: {
              method: 'POST',
              header: [{ key: 'Authorization', value: 'Bearer old-token' }],
              url: 'https://api.example.com/payments'
            }
          }
        }
      ],
      oauthConfig
    );

    const collectionText = JSON.stringify(result.collection);
    const events = result.collection.event as Array<Record<string, unknown>>;
    const variables = result.collection.variable as Array<Record<string, unknown>>;
    const items = result.collection.item as Array<Record<string, unknown>>;
    const request = (items[1] as Record<string, unknown>).request as Record<string, unknown>;
    const headers = request.header as Array<Record<string, unknown>>;

    expect(events).toHaveLength(1);
    expect(variables.map((variable) => variable.key)).toEqual([
      'auth_token_url',
      'auth_scope',
      'auth_client_id',
      'auth_client_secret',
      'access_token',
      'access_token_expires_at'
    ]);
    expect(variables.find((variable) => variable.key === 'auth_client_secret')?.value).toBe('');
    expect(collectionText).toContain('pm.variables.set(accessTokenVariable, accessToken)');
    expect(collectionText).toContain('pm.variables.set(expiresAtVariable');
    expect(collectionText).not.toContain('pm.environment.set');
    expect(headers.filter((header) => header.key === 'Authorization')).toEqual([]);
    expect(request.auth).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }]
    });
    expect(collectionText).not.toContain('super-secret');
    expect(collectionText).not.toContain('real-access-token');
  });

  it('applies OAuth to an existing Smoke collection idempotently without changing item order', () => {
    const existingCollection = {
      info: { name: '[Smoke] Providers API', _postman_id: 'info-123' },
      uid: '54270406-collection-uid-123',
      event: [
        {
          listen: 'prerequest',
          script: {
            type: 'text/javascript',
            exec: ['// Existing manual collection script']
          }
        },
        {
          listen: 'prerequest',
          script: {
            type: 'text/javascript',
            exec: ['// [Smoke Flow] Auto-generated OAuth2 client-credentials token cache.', '// old generated script']
          }
        }
      ],
      item: [
        {
          name: '00 - Resolve Secrets',
          request: {
            auth: { type: 'awsv4' },
            method: 'POST',
            url: 'https://secretsmanager.us-west-2.amazonaws.com'
          }
        },
        {
          name: 'Providers',
          item: [
            {
              name: 'searchProviders',
              request: {
                method: 'GET',
                header: [{ key: 'Authorization', value: 'Bearer old-token' }],
                url: '{{baseUrl}}/v1/providers'
              }
            },
            {
              name: 'getProvider',
              request: {
                method: 'GET',
                url: '{{baseUrl}}/v1/providers/{{providerId}}'
              }
            }
          ]
        }
      ],
      response: [{ id: 'resp-123' }]
    };

    const once = applySmokeCollectionAuth(existingCollection, oauthConfig);
    const twice = applySmokeCollectionAuth(once.collection, oauthConfig);
    const collectionText = JSON.stringify(twice.collection);
    const events = twice.collection.event as Array<Record<string, unknown>>;
    const items = twice.collection.item as Array<Record<string, unknown>>;
    const folderItems = items[1]?.item as Array<Record<string, unknown>>;
    const resolverRequest = items[0]?.request as Record<string, unknown>;
    const firstSmokeRequest = folderItems[0]?.request as Record<string, unknown>;
    const secondSmokeRequest = folderItems[1]?.request as Record<string, unknown>;

    expect(twice.authRequestCount).toBe(2);
    expect((twice.collection.info as Record<string, unknown>)._postman_id).toBeUndefined();
    expect((twice.collection as Record<string, unknown>).uid).toBeUndefined();
    expect((twice.collection as Record<string, unknown>).response).toBeUndefined();
    expect(items.map((item) => item.name)).toEqual(['00 - Resolve Secrets', 'Providers']);
    expect(folderItems.map((item) => item.name)).toEqual(['searchProviders', 'getProvider']);
    expect(resolverRequest.auth).toEqual({ type: 'awsv4' });
    expect(firstSmokeRequest.auth).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }]
    });
    expect(secondSmokeRequest.auth).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }]
    });
    expect(firstSmokeRequest.header).toEqual([]);
    expect(events).toHaveLength(2);
    expect(collectionText.match(/Auto-generated OAuth2 client-credentials token cache/g) ?? []).toHaveLength(1);
    expect(collectionText).toContain('Existing manual collection script');
    expect(collectionText).not.toContain('old generated script');
  });
});
