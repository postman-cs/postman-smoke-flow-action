import { describe, expect, it, vi } from 'vitest';

import { PostmanGatewaySmokeClient } from '../src/postman/postman-gateway-smoke-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';

type J = Record<string, unknown>;

interface Envelope {
  service: string;
  method: string;
  path: string;
  body?: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Build a fetch mock that routes gateway `/ws/proxy` envelopes to a handler. */
function gatewayFetch(handler: (env: Envelope) => Response): { fetchImpl: typeof fetch; calls: Envelope[] } {
  const calls: Envelope[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const env = JSON.parse(String(init?.body ?? '{}')) as Envelope;
    calls.push(env);
    return handler(env);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(handler: (env: Envelope) => Response, teamId?: string): { client: PostmanGatewaySmokeClient; calls: Envelope[] } {
  const { fetchImpl, calls } = gatewayFetch(handler);
  const provider = new AccessTokenProvider({ accessToken: 'tok' });
  const client = new PostmanGatewaySmokeClient({
    tokenProvider: provider,
    fetchImpl,
    ...(teamId ? { teamId, orgMode: true } : {})
  });
  return { client, calls };
}

describe('PostmanGatewaySmokeClient', () => {
  it('getCollection exports v3 IR and adapts it to a v2.1 collection', async () => {
    const v3Export = {
      data: {
        collection: {
          id: '55363555-abc',
          name: 'Exp Collection',
          $kind: 'collection',
          variables: [{ key: 'baseUrl', value: 'https://x' }],
          items: [
            {
              // Real export marks request folders as $kind:'collection' (not
              // 'folder'); the adapter must still recurse into `items`.
              $kind: 'collection',
              name: 'Group',
              items: [
                {
                  id: '55363555-leaf',
                  name: 'Do Post',
                  url: '{{baseUrl}}/post?q=1',
                  method: 'POST',
                  headers: [{ key: 'Content-Type', value: 'application/json' }],
                  body: { type: 'json', content: '{"a":1}' },
                  $kind: 'http-request',
                  scripts: [
                    { type: 'beforeRequest', code: 'console.log(1);' },
                    { type: 'afterResponse', code: 'pm.test("x", () => {});' }
                  ]
                }
              ]
            }
          ]
        }
      }
    };
    const { client } = makeClient((env) => {
      if (env.method === 'get' && env.path.endsWith('/export')) return jsonResponse(v3Export);
      return jsonResponse({});
    });

    const v2 = await client.getCollection('55363555-abc');
    expect((v2.info as J).name).toBe('Exp Collection');
    const folder = (v2.item as J[])[0];
    expect(folder.name).toBe('Group');
    const leaf = (folder.item as J[])[0];
    expect(leaf.name).toBe('Do Post');
    const request = leaf.request as J;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('{{baseUrl}}/post?q=1');
    expect(request.body).toEqual({ mode: 'raw', raw: '{"a":1}' });
    const events = leaf.event as J[];
    expect(events.map((e) => e.listen)).toEqual(['prerequest', 'test']);
    expect((events[0].script as J).exec).toEqual(['console.log(1);']);
  });

  it('updateCollection deletes existing items then recreates curated leaves with scripts + collection patch', async () => {
    const deleted = new Set<string>();
    const { client, calls } = makeClient((env) => {
      if (env.method === 'get' && env.path.endsWith('/items/')) {
        const remaining = deleted.has('55363555-old') ? [] : [{ id: '55363555-old', $kind: 'http-request', name: 'old' }];
        return jsonResponse({ data: remaining });
      }
      if (env.method === 'delete') {
        deleted.add(env.path.slice(env.path.lastIndexOf('/') + 1));
        return jsonResponse({});
      }
      if (env.method === 'post' && env.path.endsWith('/items/')) return jsonResponse({ data: { id: '55363555-new' } });
      if (env.method === 'patch') return jsonResponse({ data: {} });
      return jsonResponse({});
    });

    await client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] Reshaped' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }] },
      variable: [{ key: 'access_token', value: '', type: 'string' }],
      event: [{ listen: 'prerequest', script: { exec: ['// OAuth', 'console.log("o");'] } }],
      item: [
        {
          name: 'Echo',
          request: {
            method: 'POST',
            url: 'https://postman-echo.com/post',
            header: [{ key: 'Accept', value: 'application/json' }],
            body: { mode: 'raw', raw: '{"a":1}' },
            auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }] }
          },
          event: [
            { listen: 'prerequest', script: { exec: ['console.log("b");'] } },
            { listen: 'test', script: { exec: ['pm.test("a", () => {});'] } }
          ]
        }
      ]
    });

    // delete the pre-existing item (FULL public uid in items path)
    const del = calls.find((c) => c.method === 'delete' && c.path.includes('/items/'));
    expect(del?.path).toBe('/v3/collections/55363555-cid/items/55363555-old');

    // create the curated leaf with ROOT-level v3 IR fields (no payload wrapper)
    const create = calls.find((c) => c.method === 'post' && c.path.endsWith('/items/'));
    const createBody = create?.body as J;
    expect(createBody.$kind).toBe('http-request');
    expect(createBody.method).toBe('POST');
    expect(createBody.url).toBe('https://postman-echo.com/post');
    expect(createBody.payload).toBeUndefined();
    // body is v3 IR {type,content}, not v2 {mode,raw}
    expect(createBody.body).toEqual({ type: 'json', content: '{"a":1}' });
    // headers are {key,value}
    expect(createBody.headers).toEqual([{ key: 'Accept', value: 'application/json' }]);
    // auth is v3 IR {type,credentials:[{key,value}]} (type:'string' stripped)
    expect(createBody.auth).toEqual({ type: 'bearer', credentials: [{ key: 'token', value: '{{access_token}}' }] });

    // scripts patch on the new item (beforeRequest + afterResponse)
    const scriptsPatch = calls.find((c) => c.method === 'patch' && c.path.endsWith('/items/55363555-new'));
    const scriptsOps = scriptsPatch?.body as J[];
    const scripts = (scriptsOps[0].value as J[]).map((s) => s.type);
    expect(scripts).toEqual(['beforeRequest', 'afterResponse']);

    // collection-level patch: name + auth (v3 IR credentials) + variables
    const collPatch = calls.find((c) => c.method === 'patch' && /\/v3\/collections\/cid$/.test(c.path) && Array.isArray(c.body) && (c.body as J[]).some((o) => o.path === '/name'));
    const ops = collPatch?.body as J[];
    expect(ops.find((o) => o.path === '/name')?.value).toBe('[Smoke] Reshaped');
    const authOp = ops.find((o) => o.path === '/auth')?.value as J;
    expect(authOp.type).toBe('bearer');
    expect(Array.isArray(authOp.credentials)).toBe(true);

    // collection-level OAuth pre-request script in its OWN patch, http: root type
    const collScriptPatch = calls.find((c) => c.method === 'patch' && /\/v3\/collections\/cid$/.test(c.path) && Array.isArray(c.body) && (c.body as J[]).some((o) => o.path === '/scripts'));
    const collScripts = (collScriptPatch?.body as J[])[0].value as J[];
    expect(collScripts[0].type).toBe('http:beforeRequest');
  });

  it('preserves generated collection folders before recreating canonical request leaves', async () => {
    const { client, calls } = makeClient((env) => {
      if (env.method === 'get' && env.path.endsWith('/items/')) return jsonResponse({ data: [] });
      if (env.method === 'post' && env.path.endsWith('/items/')) {
        const body = env.body as J;
        const idByName: Record<string, string> = {
          health: '55363555-folder-health',
          'Health check': '55363555-request-health',
          v1: '55363555-folder-v1',
          'List widgets': '55363555-request-widgets'
        };
        return jsonResponse({ data: { id: idByName[String(body.name ?? '')] ?? '55363555-new' } });
      }
      if (env.method === 'patch') return jsonResponse({ data: {} });
      return jsonResponse({});
    });

    await client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] Generated' },
      item: [
        {
          name: 'health',
          item: [
            {
              name: 'Health check',
              request: {
                method: 'GET',
                url: '{{baseUrl}}/health',
                auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }] }
              }
            }
          ]
        },
        {
          name: 'v1',
          item: [
            {
              name: 'List widgets',
              request: {
                method: 'GET',
                url: '{{baseUrl}}/v1/widgets',
                auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }] }
              }
            }
          ]
        }
      ]
    });

    const createdItems = calls
      .filter((c) => c.method === 'post' && c.path.endsWith('/items/'))
      .map((c) => c.body as J);

    expect(createdItems.map((item) => [item.$kind, item.name])).toEqual([
      ['collection', 'health'],
      ['http-request', 'Health check'],
      ['collection', 'v1'],
      ['http-request', 'List widgets']
    ]);
    expect((createdItems[0]?.position as J).parent).toEqual({ id: '55363555-cid', $kind: 'collection' });
    expect((createdItems[1]?.position as J).parent).toEqual({ id: '55363555-folder-health', $kind: 'collection' });
    expect((createdItems[2]?.position as J).parent).toEqual({ id: '55363555-cid', $kind: 'collection' });
    expect((createdItems[3]?.position as J).parent).toEqual({ id: '55363555-folder-v1', $kind: 'collection' });
    expect(createdItems[1]?.url).toBe('{{baseUrl}}/health');
    expect(createdItems[3]?.url).toBe('{{baseUrl}}/v1/widgets');
    expect(createdItems[1]?.auth).toEqual({ type: 'bearer', credentials: [{ key: 'token', value: '{{access_token}}' }] });
    expect(createdItems[3]?.auth).toEqual({ type: 'bearer', credentials: [{ key: 'token', value: '{{access_token}}' }] });
  });

  it('removes collection auth when the desired collection is explicitly noauth', async () => {
    const { client, calls } = makeClient((env) => {
      if (env.method === 'get' && env.path.endsWith('/items/')) return jsonResponse({ data: [] });
      if (env.method === 'patch') return jsonResponse({ data: {} });
      return jsonResponse({});
    });

    await client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] OAuth Runtime' },
      auth: { type: 'noauth' },
      item: []
    });

    const collPatches = calls.filter((c) => c.method === 'patch' && /\/v3\/collections\/cid$/.test(c.path));
    expect(collPatches.map((c) => c.body)).toEqual([
      [{ op: 'replace', path: '/name', value: '[Smoke] OAuth Runtime' }],
      [{ op: 'remove', path: '/auth' }]
    ]);
  });

  it('treats collection auth removal as successful when no auth exists', async () => {
    const { client, calls } = makeClient((env) => {
      if (env.method === 'get' && env.path.endsWith('/items/')) return jsonResponse({ data: [] });
      if (env.method === 'patch') {
        const ops = env.body as J[];
        if (ops.some((op) => op.path === '/auth' && op.op === 'remove')) {
          return jsonResponse({
            error: {
              code: 'REJECTED_PATCH',
              details: {
                err: 'Remove operation must point to an existing value!'
              }
            }
          }, 400);
        }
        return jsonResponse({ data: {} });
      }
      return jsonResponse({});
    });

    await expect(client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] OAuth Runtime' },
      auth: { type: 'noauth' },
      variable: [{ key: 'access_token', value: '', type: 'string' }],
      item: []
    })).resolves.toBeUndefined();

    const collPatches = calls.filter((c) => c.method === 'patch' && /\/v3\/collections\/cid$/.test(c.path));
    expect(collPatches.map((c) => c.body)).toEqual([
      [
        { op: 'replace', path: '/name', value: '[Smoke] OAuth Runtime' },
        { op: 'add', path: '/variables', value: [{ key: 'access_token', value: '' }] }
      ],
      [{ op: 'remove', path: '/auth' }]
    ]);
  });

  it('retries the new-item scripts patch on a transient 404 (read-after-write lag)', async () => {
    let itemPatchAttempts = 0;
    const { fetchImpl, calls } = gatewayFetch((env) => {
      if (env.method === 'get' && env.path.endsWith('/items/')) return jsonResponse({ data: [] });
      if (env.method === 'post' && env.path.endsWith('/items/')) return jsonResponse({ data: { id: '55363555-new' } });
      if (env.method === 'patch' && env.path.endsWith('/items/55363555-new')) {
        itemPatchAttempts += 1;
        // First read-after-write hits a replica that has not seen the create.
        return itemPatchAttempts === 1
          ? jsonResponse({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Item not found' } }, 404)
          : jsonResponse({ data: {} });
      }
      return jsonResponse({});
    });
    const sleep = vi.fn(async () => undefined);
    const provider = new AccessTokenProvider({ accessToken: 'tok' });
    const client = new PostmanGatewaySmokeClient({ tokenProvider: provider, fetchImpl, sleepImpl: sleep });

    await client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] Reshaped' },
      item: [
        {
          name: 'Echo',
          request: { method: 'GET', url: 'https://postman-echo.com/get' },
          event: [{ listen: 'test', script: { exec: ['pm.test("a", () => {});'] } }]
        }
      ]
    });

    // create once, patch twice (404 then 200), one backoff sleep between.
    expect(itemPatchAttempts).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    const itemPatches = calls.filter((c) => c.method === 'patch' && c.path.endsWith('/items/55363555-new'));
    expect(itemPatches).toHaveLength(2);
  });

  it('surfaces a non-404 error from the new-item scripts patch without retrying', async () => {
    let itemPatchAttempts = 0;
    const { fetchImpl } = gatewayFetch((env) => {
      if (env.method === 'get' && env.path.endsWith('/items/')) return jsonResponse({ data: [] });
      if (env.method === 'post' && env.path.endsWith('/items/')) return jsonResponse({ data: { id: '55363555-new' } });
      if (env.method === 'patch' && env.path.endsWith('/items/55363555-new')) {
        itemPatchAttempts += 1;
        return jsonResponse({ error: { code: 'SCHEMA_ENFORCED' } }, 400);
      }
      return jsonResponse({});
    });
    const sleep = vi.fn(async () => undefined);
    const provider = new AccessTokenProvider({ accessToken: 'tok' });
    const client = new PostmanGatewaySmokeClient({ tokenProvider: provider, fetchImpl, sleepImpl: sleep });

    await expect(
      client.updateCollection('55363555-cid', {
        info: { name: '[Smoke] Reshaped' },
        item: [
          {
            name: 'Echo',
            request: { method: 'GET', url: 'https://postman-echo.com/get' },
            event: [{ listen: 'test', script: { exec: ['pm.test("a", () => {});'] } }]
          }
        ]
      })
    ).rejects.toThrow('400');
    expect(itemPatchAttempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not swallow permanent collection-script patch authorization errors', async () => {
    let scriptPatchAttempts = 0;
    const { client } = makeClient((env) => {
      if (env.method === 'get' && env.path.endsWith('/items/')) return jsonResponse({ data: [] });
      if (env.method === 'patch' && /\/v3\/collections\/cid$/.test(env.path)) {
        const ops = env.body as J[];
        if (ops.some((op) => op.path === '/scripts')) {
          scriptPatchAttempts += 1;
          return jsonResponse({ error: 'forbidden' }, 403);
        }
        return jsonResponse({ data: {} });
      }
      return jsonResponse({ data: {} });
    });

    await expect(client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] Reshaped' },
      event: [{ listen: 'prerequest', script: { exec: ['console.log("x");'] } }],
      item: []
    })).rejects.toThrow('403');
    expect(scriptPatchAttempts).toBe(1);
  });

  it('deleteCollection swallows a 404', async () => {
    const { client, calls } = makeClient((env) => {
      if (env.method === 'delete') return jsonResponse({ error: 'not found' }, 404);
      return jsonResponse({});
    });
    await expect(client.deleteCollection('55363555-gone')).resolves.toBeUndefined();
    expect(calls[0]?.path).toBe('/v3/collections/gone');
  });

  it('deleteCollection propagates a permanent authorization error without retrying', async () => {
    let attempts = 0;
    const { client } = makeClient((env) => {
      if (env.method === 'delete') {
        attempts += 1;
        return jsonResponse({ error: 'forbidden' }, 403);
      }
      return jsonResponse({});
    });
    await expect(client.deleteCollection('55363555-owned')).rejects.toThrow('403');
    expect(attempts).toBe(1);
  });
});
