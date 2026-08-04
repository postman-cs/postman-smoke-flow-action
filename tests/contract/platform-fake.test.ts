import { describe, expect, it } from 'vitest';

import { HOSTS, createPlatform } from './platform-fake.js';

function proxy(platform: ReturnType<typeof createPlatform>, payload: unknown): Promise<Response> {
  return platform.fetch(`${HOSTS.prod.bifrost}/ws/proxy`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

describe('platform fake fail-closed contract', () => {
  it.each([
    ['service', { service: 'unknown', method: 'get', path: '/v3/collections/12345678-col-smoke/export' }],
    ['method', { service: 'collection', method: 'post', path: '/v3/collections/12345678-col-smoke/export' }],
    ['path', { service: 'collection', method: 'get', path: '/v3/collections/12345678-col-smoke/unmodeled' }],
    ['query', { service: 'specification', method: 'get', path: '/specifications/spec-contract/collections?unexpected=value' }],
    ['generation body', { service: 'specification', method: 'post', path: '/specifications/spec-contract/collections', body: { name: 'temp', unexpected: true } }],
    ['item create body', { service: 'collection', method: 'post', path: '/v3/collections/12345678-col-smoke/items/', body: { $kind: 'http-request', name: 'request', method: 'GET', url: 'https://api.example.com', headers: {}, position: { parent: { id: '12345678-col-smoke' } } } }],
    ['patch operation/path', { service: 'collection', method: 'patch', path: '/v3/collections/12345678-col-smoke/items/12345678-item-old-0001', body: [{ op: 'replace', path: '/name', value: 'nope' }] }]
  ])('rejects unrecognized %s', async (_label, payload) => {
    const platform = createPlatform();
    await expect(proxy(platform, payload)).rejects.toThrow('Unmatched smoke-flow platform fake request');
  });

  it('accepts a modeled smoke-flow wire request', async () => {
    const platform = createPlatform();
    const response = await proxy(platform, {
      service: 'specification',
      method: 'get',
      path: '/specifications/spec-contract/collections'
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: [] });
  });
});
