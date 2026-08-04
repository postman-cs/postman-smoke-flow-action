import { describe, expect, it, vi } from 'vitest';

import { PostmanGatewaySmokeClient } from '../src/postman/postman-gateway-smoke-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';

/**
 * Collection ROOT ACL contract (live-proven 2026-08-03, non-org + org sandbox).
 *
 * Postman tightened ACLs on the collection-service ROOT routes. Sending the
 * bare model id now fails closed:
 *
 *   PATCH /v3/collections/:id            bare=403 FORBIDDEN   full=200
 *   GET   /v3/collections/:id            bare=403 FORBIDDEN   full=200
 *   GET   /v3/collections/:id/export     bare=200             full=200
 *   DELETE /v3/collections/:id           bare=200             full=200
 */

const UUID = '6b9b8a7c-1111-4222-8333-444455556666';
const OWNER = '55363555';
const FULL = `${OWNER}-${UUID}`;
const WORKSPACE = 'ws-smoke-acl';

const FULL_PUBLIC_UID_RE =
  /^\d+-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface Envelope {
  service: string;
  method: string;
  path: string;
  body?: unknown;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

function forbidden(id: string): Response {
  return jsonResponse(
    {
      error: {
        code: 'FORBIDDEN',
        message: `Access to the requested resource "${id}" has been denied`
      }
    },
    { status: 403 }
  );
}

function rootSegment(path: string): string | undefined {
  const match = /^\/v3\/collections\/([^/?]+)$/.exec(path);
  return match?.[1];
}

function makeClient(
  handler: (env: Envelope) => Response,
  options: { workspaceId?: string; sleepImpl?: (ms: number) => Promise<void> } = {}
): { client: PostmanGatewaySmokeClient; calls: Envelope[] } {
  const calls: Envelope[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const env = JSON.parse(String(init?.body ?? '{}')) as Envelope;
    calls.push(env);
    return handler(env);
  }) as unknown as typeof fetch;
  const client = new PostmanGatewaySmokeClient({
    tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
    fetchImpl,
    workspaceId: options.workspaceId ?? WORKSPACE,
    ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {})
  });
  return { client, calls };
}

function aclEnforcingHandler(options: {
  inventory: Array<{ id: string; name: string }>;
}): (env: Envelope) => Response {
  return (env) => {
    const path = String(env.path);

    if (env.service === 'collection' && path.startsWith('/v3/collections/?workspace=')) {
      return jsonResponse({ data: options.inventory });
    }

    if (env.service === 'collection' && path.endsWith('/items/')) {
      return jsonResponse({ data: [] });
    }

    if (env.service === 'collection' && /\/export$/.test(path)) {
      return jsonResponse({ data: { collection: { name: 'Smoke', items: [] } } });
    }

    const segment = rootSegment(path);
    if (env.service === 'collection' && segment !== undefined) {
      if ((env.method === 'patch' || env.method === 'get') && !FULL_PUBLIC_UID_RE.test(segment)) {
        return forbidden(segment);
      }
      if (env.method === 'delete') {
        return jsonResponse({ data: { id: segment } });
      }
      return jsonResponse({ data: { id: FULL } });
    }

    return jsonResponse({ data: {} });
  };
}

const minimalUpdate = {
  info: { name: '[Smoke] ACL' },
  item: []
};

describe('PostmanGatewaySmokeClient collection ROOT ACL', () => {
  it('sends the full public uid on updateCollection ROOT PATCH when the caller already has it', async () => {
    const inventory = [{ id: FULL, name: '[Smoke] ACL' }];
    const { client, calls } = makeClient(aclEnforcingHandler({ inventory }));

    await client.updateCollection(FULL, minimalUpdate);

    const rootPatches = calls.filter(
      (call) =>
        call.service === 'collection' &&
        call.method === 'patch' &&
        rootSegment(String(call.path)) !== undefined
    );
    expect(rootPatches.length).toBeGreaterThan(0);
    for (const call of rootPatches) {
      expect(rootSegment(String(call.path))).toBe(FULL);
    }
    expect(
      calls.some(
        (call) =>
          call.service === 'collection' &&
          call.method === 'patch' &&
          rootSegment(String(call.path)) === UUID
      )
    ).toBe(false);
  });

  it('resolves a bare model id from workspace inventory before ROOT PATCH', async () => {
    const inventory = [{ id: FULL, name: '[Smoke] ACL' }];
    const { client, calls } = makeClient(aclEnforcingHandler({ inventory }));

    await client.updateCollection(UUID, minimalUpdate);

    const rootPatches = calls.filter(
      (call) => call.service === 'collection' && call.method === 'patch' && rootSegment(String(call.path))
    );
    expect(rootPatches.map((call) => call.path)).toEqual([`/v3/collections/${FULL}`]);
    expect(calls.some((call) => call.path === `/v3/collections/${UUID}/items/`)).toBe(false);
    expect(calls.some((call) => call.path === `/v3/collections/${FULL}/items/`)).toBe(true);
  });

  it('polls inventory when the ROOT-addressable uid is briefly invisible', async () => {
    let inventoryReads = 0;
    const sleeps: number[] = [];
    const inventory: Array<{ id: string; name: string }> = [];
    const { client, calls } = makeClient(
      (env) => {
        const path = String(env.path);
        if (env.service === 'collection' && path.startsWith('/v3/collections/?workspace=')) {
          inventoryReads += 1;
          if (inventoryReads >= 3) inventory.push({ id: FULL, name: '[Smoke] ACL' });
          return jsonResponse({ data: inventory });
        }
        return aclEnforcingHandler({ inventory })(env);
      },
      { sleepImpl: async (delayMs) => { sleeps.push(delayMs); } }
    );

    await client.updateCollection(UUID, minimalUpdate);

    expect(inventoryReads).toBeGreaterThanOrEqual(3);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(
      calls.filter((call) => call.service === 'collection' && call.method === 'patch').map((call) => call.path)
    ).toEqual([`/v3/collections/${FULL}`]);
  });

  it('keeps polling when inventory first exposes only the bare identity', async () => {
    let inventoryReads = 0;
    const { client, calls } = makeClient((env) => {
      const path = String(env.path);
      if (env.service === 'collection' && path.startsWith('/v3/collections/?workspace=')) {
        inventoryReads += 1;
        return jsonResponse({
          data: [{ id: inventoryReads < 3 ? UUID : FULL, name: '[Smoke] ACL' }]
        });
      }
      if (env.service === 'collection' && path.endsWith('/items/')) {
        return jsonResponse({ data: [] });
      }
      const segment = rootSegment(path);
      if (env.service === 'collection' && segment !== undefined) {
        if ((env.method === 'patch' || env.method === 'get') && !FULL_PUBLIC_UID_RE.test(segment)) {
          return forbidden(segment);
        }
        return jsonResponse({ data: { id: FULL } });
      }
      return jsonResponse({ data: {} });
    });

    await client.updateCollection(UUID, minimalUpdate);

    expect(inventoryReads).toBeGreaterThanOrEqual(3);
    expect(
      calls.filter((call) => call.service === 'collection' && call.method === 'patch').map((call) => call.path)
    ).toEqual([`/v3/collections/${FULL}`]);
  });

  it('fails closed when inventory never promotes a bare identity to a ROOT-addressable uid', async () => {
    const { client, calls } = makeClient((env) => {
      const path = String(env.path);
      if (env.service === 'collection' && path.startsWith('/v3/collections/?workspace=')) {
        return jsonResponse({ data: [{ id: UUID, name: '[Smoke] ACL' }] });
      }
      if (env.service === 'collection' && path.endsWith('/items/')) {
        return jsonResponse({ data: [] });
      }
      const segment = rootSegment(path);
      if (env.service === 'collection' && segment !== undefined) {
        return forbidden(segment);
      }
      return jsonResponse({ data: {} });
    });

    await expect(client.updateCollection(UUID, minimalUpdate)).rejects.toThrow(
      /COLLECTION_ROOT_UID_RESOLUTION_FAILED/
    );
    expect(
      calls.filter(
        (call) =>
          call.service === 'collection' &&
          (call.method === 'patch' || call.method === 'get') &&
          rootSegment(String(call.path)) !== undefined
      )
    ).toEqual([]);
  });

  it('never sends a bare id to ROOT PATCH when workspace-id is missing', async () => {
    const calls: Envelope[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')) as Envelope);
      return jsonResponse({ data: {} });
    }) as unknown as typeof fetch;
    const client = new PostmanGatewaySmokeClient({
      tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
      fetchImpl
    });

    await expect(client.updateCollection(UUID, minimalUpdate)).rejects.toThrow(
      /COLLECTION_ROOT_UID_RESOLUTION_FAILED/
    );
    expect(calls).toEqual([]);
  });

  it('keeps export and delete on bare model ids', async () => {
    const { client, calls } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get' && env.path.endsWith('/export')) {
        return jsonResponse({ data: { collection: { name: 'Smoke', items: [] } } });
      }
      if (env.service === 'collection' && env.method === 'delete') {
        return jsonResponse({ data: { id: UUID } });
      }
      return jsonResponse({ data: {} });
    });

    await client.getCollection(FULL);
    await client.deleteCollection(FULL);

    expect(calls.find((call) => call.method === 'get' && call.path.endsWith('/export'))?.path).toBe(
      `/v3/collections/${UUID}/export`
    );
    expect(calls.find((call) => call.method === 'delete')?.path).toBe(`/v3/collections/${UUID}`);
  });
});
