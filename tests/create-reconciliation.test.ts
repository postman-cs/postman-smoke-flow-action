import { describe, expect, it, vi } from 'vitest';

import { PostmanGatewaySmokeClient } from '../src/postman/postman-gateway-smoke-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';

type J = Record<string, unknown>;

interface Envelope {
  service: string;
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function gatewayFetch(handler: (env: Envelope) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Envelope[];
} {
  const calls: Envelope[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const env = JSON.parse(String(init?.body ?? '{}')) as Envelope;
    calls.push(env);
    return handler(env);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(
  handler: (env: Envelope) => Response | Promise<Response>,
  options: { workspaceId?: string; runIdentity?: string; teamId?: string } = {}
): { client: PostmanGatewaySmokeClient; calls: Envelope[]; sleep: ReturnType<typeof vi.fn> } {
  const { fetchImpl, calls } = gatewayFetch(handler);
  const sleep = vi.fn(async () => undefined);
  const provider = new AccessTokenProvider({ accessToken: 'tok' });
  const client = new PostmanGatewaySmokeClient({
    tokenProvider: provider,
    fetchImpl,
    sleepImpl: sleep,
    workspaceId: options.workspaceId ?? 'ws-owned',
    runIdentity: options.runIdentity ?? 'run-abc',
    ...(options.teamId ? { teamId: options.teamId, orgMode: true } : {})
  });
  return { client, calls, sleep };
}

function collectionExport(name: string, id: string): Response {
  return jsonResponse({
    data: {
      collection: {
        id,
        name,
        $kind: 'collection',
        items: []
      }
    }
  });
}

describe('Wave 2 create reconciliation', () => {
  it('accepted generation create then ambiguous 503 reconciles owned temp by task/name/snapshot (no second POST)', async () => {
    const preExisting = '11111111-old-temp';
    const ownedUid = '22222222-owned-temp';
    const foreignUid = '33333333-foreign-temp';
    const ownedName = '[Smoke][Temp] payments run-abc';
    let generationPosts = 0;
    let taskPolls = 0;

    const { client, calls } = makeClient((env) => {
      if (env.service === 'specification' && env.method === 'get' && env.path === '/specifications/spec-1/collections') {
        // First list is the pre-run snapshot; later lists include concurrent foreign + owned.
        const hasPosted = generationPosts > 0;
        const data = hasPosted
          ? [
              { collection: preExisting, state: 'in-sync' },
              { collection: ownedUid, state: 'in-sync' },
              { collection: foreignUid, state: 'in-sync' }
            ]
          : [{ collection: preExisting, state: 'in-sync' }];
        return jsonResponse({ data });
      }
      if (env.service === 'specification' && env.method === 'post' && env.path === '/specifications/spec-1/collections') {
        generationPosts += 1;
        // Durably accepted, but the proxy returns an ambiguous transient error.
        return jsonResponse({ error: { name: 'serverError', message: 'ESOCKETTIMEDOUT' } }, 503);
      }
      if (env.service === 'specification' && env.method === 'get' && env.path === '/tasks') {
        taskPolls += 1;
        return jsonResponse({ data: { 'task-owned': 'completed' } });
      }
      if (env.service === 'collection' && env.method === 'get' && env.path.endsWith('/export')) {
        const bare = env.path.split('/')[3];
        if (bare === 'owned-temp') return collectionExport(ownedName, ownedUid);
        if (bare === 'foreign-temp') return collectionExport('[Smoke][Temp] payments run-other', foreignUid);
        if (bare === 'old-temp') return collectionExport('[Smoke][Temp] payments stale', preExisting);
        return collectionExport('unknown', bare);
      }
      return jsonResponse({});
    });

    const uid = await client.generateCollection('spec-1', 'payments', '[Smoke][Temp]');
    expect(uid).toBe(ownedUid);
    expect(generationPosts).toBe(1);
    const posts = calls.filter(
      (c) => c.service === 'specification' && c.method === 'post' && c.path.endsWith('/collections')
    );
    expect(posts).toHaveLength(1);
    expect((posts[0]?.body as J).name).toBe(ownedName);
    expect(taskPolls).toBeGreaterThanOrEqual(0);
  });

  it('overlapping generation/cleanup only deletes the positively owned temporary collection', async () => {
    const aOwned = 'aaaaaaaa-run-a';
    const bOwned = 'bbbbbbbb-run-b';
    const deleted: string[] = [];

    const handlerFor = (runIdentity: string, ownedUid: string, peerUid: string) => {
      let posted = false;
      return (env: Envelope): Response => {
        if (env.service === 'specification' && env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          const data = posted
            ? [
                { collection: aOwned, state: 'in-sync' },
                { collection: bOwned, state: 'in-sync' }
              ]
            : [];
          return jsonResponse({ data });
        }
        if (env.service === 'specification' && env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          posted = true;
          return jsonResponse({ data: { taskId: `task-${runIdentity}` } });
        }
        if (env.service === 'specification' && env.method === 'get' && env.path === '/tasks') {
          return jsonResponse({ data: { [`task-${runIdentity}`]: 'completed' } });
        }
        if (env.service === 'collection' && env.method === 'get' && env.path.endsWith('/export')) {
          const bare = env.path.split('/')[3];
          if (bare === 'run-a') return collectionExport('[Smoke][Temp] payments run-a', aOwned);
          if (bare === 'run-b') return collectionExport('[Smoke][Temp] payments run-b', bOwned);
          return collectionExport('other', bare);
        }
        if (env.service === 'collection' && env.method === 'delete') {
          deleted.push(env.path.split('/').pop() ?? '');
          return jsonResponse({});
        }
        void peerUid;
        void ownedUid;
        return jsonResponse({});
      };
    };

    const a = makeClient(handlerFor('run-a', aOwned, bOwned), { runIdentity: 'run-a' });
    const b = makeClient(handlerFor('run-b', bOwned, aOwned), { runIdentity: 'run-b' });

    const [uidA, uidB] = await Promise.all([
      a.client.generateCollection('spec-1', 'payments', '[Smoke][Temp]'),
      b.client.generateCollection('spec-1', 'payments', '[Smoke][Temp]')
    ]);
    expect(uidA).toBe(aOwned);
    expect(uidB).toBe(bOwned);

    await a.client.deleteCollection(uidA);
    await expect(a.client.deleteCollection(uidB)).rejects.toThrow(/not owned|positively owned|refusing to delete/i);
    expect(deleted).toEqual(['run-a']);
  });

  it('refuses the first canonical delete/patch when the collection is not in the supplied workspace', async () => {
    const { client, calls } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get' && env.path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({
          data: [{ id: '55363555-other', name: 'Other Smoke' }]
        });
      }
      return jsonResponse({});
    }, { workspaceId: 'ws-owned' });

    await expect(
      client.updateCollection('55363555-canonical', {
        info: { name: '[Smoke] payments' },
        item: [{ name: 'Echo', request: { method: 'GET', url: 'https://example.com' } }]
      })
    ).rejects.toThrow(/workspace|does not belong|not found in workspace/i);

    expect(calls.some((c) => c.method === 'delete')).toBe(false);
    expect(calls.some((c) => c.method === 'patch')).toBe(false);
    expect(calls.some((c) => c.method === 'post' && c.path.endsWith('/items/'))).toBe(false);
  });

  it('fails closed on duplicate item names instead of picking one during reconcile', async () => {
    const { client } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get' && env.path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [{ id: '55363555-cid', name: '[Smoke] payments' }] });
      }
      if (env.method === 'get' && env.path.endsWith('/items/')) {
        return jsonResponse({
          data: [
            { id: '55363555-a', $kind: 'http-request', name: 'Echo' },
            { id: '55363555-b', $kind: 'http-request', name: 'Echo' }
          ]
        });
      }
      return jsonResponse({});
    });

    await expect(
      client.updateCollection('55363555-cid', {
        info: { name: '[Smoke] payments' },
        item: [{ name: 'Echo', request: { method: 'GET', url: 'https://example.com/a' } }]
      })
    ).rejects.toThrow(/duplicate/i);
  });

  it('stable rerun reconciles in place and does not create duplicate leaves', async () => {
    const items = new Map<string, J>([
      ['55363555-echo', { id: '55363555-echo', $kind: 'http-request', name: 'Echo', method: 'GET', url: 'https://example.com/old' }]
    ]);
    let createCount = 0;

    const { client, calls } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get' && env.path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [{ id: '55363555-cid', name: '[Smoke] payments' }] });
      }
      if (env.method === 'get' && env.path.endsWith('/items/')) {
        return jsonResponse({ data: [...items.values()] });
      }
      if (env.method === 'delete' && env.path.includes('/items/')) {
        const id = env.path.slice(env.path.lastIndexOf('/') + 1);
        items.delete(id);
        return jsonResponse({});
      }
      if (env.method === 'post' && env.path.endsWith('/items/')) {
        createCount += 1;
        const body = env.body as J;
        const id = `55363555-new-${createCount}`;
        items.set(id, { id, $kind: body.$kind, name: body.name, method: body.method, url: body.url });
        return jsonResponse({ data: { id } });
      }
      if (env.method === 'patch') return jsonResponse({ data: {} });
      return jsonResponse({});
    });

    const desired = {
      info: { name: '[Smoke] payments' },
      item: [
        {
          name: 'Echo',
          request: { method: 'GET', url: 'https://example.com/new' },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {});'] } }]
        }
      ]
    };

    await client.updateCollection('55363555-cid', desired);
    const createsAfterFirst = createCount;
    const echoNamesAfterFirst = [...items.values()].filter((i) => i.name === 'Echo');
    expect(echoNamesAfterFirst).toHaveLength(1);

    await client.updateCollection('55363555-cid', desired);
    expect([...items.values()].filter((i) => i.name === 'Echo')).toHaveLength(1);
    expect(createCount).toBe(createsAfterFirst);
    const rootDeletes = calls.filter((c) => c.method === 'delete' && /\/v3\/collections\/cid$/.test(c.path));
    expect(rootDeletes).toHaveLength(0);
  });

  it('stable nested rerun derives parents from live flat entries plus direct-child stubs', async () => {
    const listedItems = [
      {
        id: '55363555-folder-health',
        $kind: 'collection',
        name: 'health',
        items: [{ id: '55363555-health-check', $kind: 'http-request' }]
      },
      {
        id: '55363555-health-check',
        $kind: 'http-request',
        name: 'Check',
        items: []
      },
      {
        id: '55363555-folder-admin',
        $kind: 'collection',
        name: 'admin',
        items: [{ id: '55363555-admin-check', $kind: 'http-request' }]
      },
      {
        id: '55363555-admin-check',
        $kind: 'http-request',
        name: 'Check',
        items: []
      }
    ];
    const { client, calls } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get' && env.path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [{ id: '55363555-cid' }] });
      }
      if (env.method === 'get' && env.path.endsWith('/items/')) return jsonResponse({ data: listedItems });
      if (env.method === 'patch') return jsonResponse({ data: {} });
      return jsonResponse({ data: {} });
    });

    await client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] payments' },
      item: [
        {
          name: 'health',
          item: [{ name: 'Check', request: { method: 'GET', url: '{{baseUrl}}/health' } }]
        },
        {
          name: 'admin',
          item: [{ name: 'Check', request: { method: 'GET', url: '{{baseUrl}}/admin' } }]
        }
      ]
    });

    expect(calls.filter((call) => call.method === 'post' && call.path.endsWith('/items/'))).toHaveLength(0);
    const itemPatchPaths = calls
      .filter((call) => call.method === 'patch' && call.path.includes('/items/'))
      .map((call) => call.path);
    expect(itemPatchPaths).toContain('/v3/collections/55363555-cid/items/55363555-health-check');
    expect(itemPatchPaths).toContain('/v3/collections/55363555-cid/items/55363555-admin-check');
  });

  it('ambiguous nested request create adopts only the flat response item referenced by the requested parent stub', async () => {
    let requestCreates = 0;
    const listedItems: J[] = [
      {
        id: '55363555-folder-health',
        $kind: 'collection',
        name: 'health',
        items: []
      },
      {
        id: '55363555-folder-admin',
        $kind: 'collection',
        name: 'admin',
        items: [{ id: '55363555-admin-check', $kind: 'http-request' }]
      },
      {
        id: '55363555-admin-check',
        $kind: 'http-request',
        name: 'Check',
        items: []
      }
    ];
    const { client, calls } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get' && env.path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [{ id: '55363555-cid' }] });
      }
      if (env.method === 'get' && env.path.endsWith('/items/')) return jsonResponse({ data: listedItems });
      if (env.method === 'post' && env.path.endsWith('/items/')) {
        requestCreates += 1;
        const health = listedItems[0] as J;
        (health.items as J[]).push({ id: '55363555-health-check', $kind: 'http-request' });
        listedItems.push({
          id: '55363555-health-check',
          $kind: 'http-request',
          name: 'Check',
          items: []
        });
        return jsonResponse({ error: { message: 'accepted then disconnected' } }, 503);
      }
      if (env.method === 'patch') return jsonResponse({ data: {} });
      return jsonResponse({ data: {} });
    });

    await client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] payments' },
      item: [
        {
          name: 'health',
          item: [{ name: 'Check', request: { method: 'GET', url: '{{baseUrl}}/health' } }]
        },
        {
          name: 'admin',
          item: [{ name: 'Check', request: { method: 'GET', url: '{{baseUrl}}/admin' } }]
        }
      ]
    });

    expect(requestCreates).toBe(1);
    expect(calls.filter((call) => call.method === 'post' && call.path.endsWith('/items/'))).toHaveLength(1);
  });

  it('never promotes direct-child stubs into phantom unnamed siblings at depth two', async () => {
    const listedItems = [
      {
        id: '55363555-outer',
        $kind: 'collection',
        name: 'Outer',
        items: [
          { id: '55363555-inner', $kind: 'collection' },
          { id: '55363555-mid', $kind: 'http-request' }
        ]
      },
      {
        id: '55363555-inner',
        $kind: 'collection',
        name: 'Inner',
        items: [{ id: '55363555-deep', $kind: 'http-request' }]
      },
      { id: '55363555-mid', $kind: 'http-request', name: 'MidReq', items: [] },
      { id: '55363555-deep', $kind: 'http-request', name: 'DeepReq', items: [] }
    ];
    const { client, calls } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get' && env.path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [{ id: '55363555-cid' }] });
      }
      if (env.method === 'get' && env.path.endsWith('/items/')) return jsonResponse({ data: listedItems });
      if (env.method === 'patch') return jsonResponse({ data: {} });
      return jsonResponse({ data: {} });
    });

    await expect(client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] nested' },
      item: [
        {
          name: 'Outer',
          item: [
            {
              name: 'Inner',
              item: [{ name: 'DeepReq', request: { method: 'GET', url: '/deep' } }]
            },
            { name: 'MidReq', request: { method: 'GET', url: '/mid' } }
          ]
        }
      ]
    })).resolves.toBeUndefined();
    expect(calls.filter((call) => call.method === 'post' && call.path.endsWith('/items/'))).toHaveLength(0);
  });

  it('does not blind-retry folder/request create POSTs after an ambiguous 5xx; reconciles by name instead', async () => {
    let requestCreates = 0;
    let folderCreates = 0;
    const items: J[] = [];

    const { client } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get' && env.path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [{ id: '55363555-cid', name: '[Smoke] payments' }] });
      }
      if (env.method === 'get' && env.path.endsWith('/items/')) {
        return jsonResponse({ data: items });
      }
      if (env.method === 'post' && env.path.endsWith('/items/')) {
        const body = env.body as J;
        if (body.$kind === 'collection') {
          folderCreates += 1;
          if (folderCreates === 1) {
            // Accepted server-side, ambiguous to client.
            items.push({
              id: '55363555-folder-health',
              $kind: 'collection',
              name: 'health',
              items: []
            });
            return jsonResponse({ error: { name: 'serverError', message: 'ESOCKETTIMEDOUT' } }, 503);
          }
          return jsonResponse({ data: { id: '55363555-folder-dup' } });
        }
        requestCreates += 1;
        if (requestCreates === 1) {
          const folder = items.find((item) => item.id === '55363555-folder-health') as J;
          (folder.items as J[]).push({ id: '55363555-request-health', $kind: 'http-request' });
          items.push({
            id: '55363555-request-health',
            $kind: 'http-request',
            name: 'Health check',
            items: []
          });
          return jsonResponse({ error: { name: 'serverError', message: 'ESOCKETTIMEDOUT' } }, 503);
        }
        return jsonResponse({ data: { id: '55363555-request-dup' } });
      }
      if (env.method === 'patch') return jsonResponse({ data: {} });
      return jsonResponse({});
    });

    await client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] payments' },
      item: [
        {
          name: 'health',
          item: [
            {
              name: 'Health check',
              request: { method: 'GET', url: '{{baseUrl}}/health' }
            }
          ]
        }
      ]
    });

    expect(folderCreates).toBe(1);
    expect(requestCreates).toBe(1);
    expect(items.filter((i) => i.name === 'health')).toHaveLength(1);
    expect(items.filter((i) => i.name === 'Health check')).toHaveLength(1);
  });

  it.each([
    ['statusless transport error', () => new TypeError('socket closed')],
    ['408', () => jsonResponse({ error: 'timeout' }, 408)],
    ['429', () => jsonResponse({ error: 'rate limited' }, 429)],
    ['500', () => jsonResponse({ error: 'server error' }, 500)],
    ['503', () => jsonResponse({ error: 'unavailable' }, 503)]
  ])('reconciles ambiguous request create after %s without a second POST', async (_label, failure) => {
    let posted = false;
    let postCount = 0;
    const nested: J[] = [];
    const { client } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get' && env.path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [{ id: '55363555-cid' }] });
      }
      if (env.method === 'get' && env.path.endsWith('/items/')) return jsonResponse({ data: nested });
      if (env.method === 'post' && env.path.endsWith('/items/')) {
        postCount += 1;
        if (!posted) {
          posted = true;
          nested.push({
            id: '55363555-check',
            $kind: 'http-request',
            name: 'Check',
            items: []
          });
        }
        const result = failure();
        if (result instanceof Error) throw result;
        return result;
      }
      if (env.method === 'patch') return jsonResponse({ data: {} });
      return jsonResponse({ data: {} });
    });

    await client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] payments' },
      item: [{ name: 'Check', request: { method: 'GET', url: '{{baseUrl}}/health' } }]
    });
    expect(postCount).toBe(1);
  });

  it.each([400, 401, 403, 404, 409, 422])('does not reconcile ordinary %i create rejection', async (status) => {
    let itemListReads = 0;
    let postCount = 0;
    const { client } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get' && env.path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [{ id: '55363555-cid' }] });
      }
      if (env.method === 'get' && env.path.endsWith('/items/')) {
        itemListReads += 1;
        return jsonResponse({ data: [] });
      }
      if (env.method === 'post' && env.path.endsWith('/items/')) {
        postCount += 1;
        return jsonResponse({ error: 'rejected' }, status);
      }
      return jsonResponse({ data: {} });
    });

    await expect(client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] payments' },
      item: [{ name: 'Check', request: { method: 'GET', url: '{{baseUrl}}/health' } }]
    })).rejects.toThrow(String(status));
    expect(postCount).toBe(1);
    expect(itemListReads).toBe(2);
  });

  it('propagates permanent item-delete errors with the original cause and no blind retry', async () => {
    let deleteCount = 0;
    const item = {
      id: '55363555-old',
      $kind: 'http-request',
      name: 'Old',
      items: []
    };
    const { client } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get' && env.path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [{ id: '55363555-cid' }] });
      }
      if (env.method === 'get' && env.path.endsWith('/items/')) return jsonResponse({ data: [item] });
      if (env.method === 'delete' && env.path.includes('/items/')) {
        deleteCount += 1;
        return jsonResponse({ error: 'forbidden' }, 403);
      }
      return jsonResponse({ data: {} });
    });

    await expect(client.updateCollection('55363555-cid', {
      info: { name: '[Smoke] payments' },
      item: []
    })).rejects.toThrow('403');
    expect(deleteCount).toBe(1);
  });
});
