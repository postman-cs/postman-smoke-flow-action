/**
 * In-memory Postman/Bifrost transport for smoke-flow contract tests.
 *
 * Serves the wire shapes the production clients parse -- mint, PMAK /me, iapub
 * session, and the Bifrost /ws/proxy envelope for the specification and
 * collection services -- so the REAL runAction composition root can execute a
 * complete curated reshape with zero live transport.
 *
 * Shared by the recorder (`record-fake-cassettes.test.ts`) and by any future
 * failure-injection lane, so both assert against one transport instead of two
 * drifting copies.
 */

export const HOSTS = {
  prod: {
    api: 'https://api.getpostman.com',
    bifrost: 'https://bifrost-premium-https-v4.gw.postman.com',
    iapub: 'https://iapub.postman.co'
  }
} as const;

/** Ambient credentials/tokens every contract run must blank before it starts. */
export const NEUTRALIZED_ENV_VARS = [
  'POSTMAN_API_KEY',
  'POSTMAN_ACCESS_TOKEN',
  'POSTMAN_TEAM_ID',
  'POSTMAN_WORKSPACE_TEAM_ID'
];

function fail(message: string): never {
  throw new Error(`Unmatched smoke-flow platform fake request: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

interface FakeItem {
  id: string;
  $kind: string;
  name: string;
  method?: string;
  url?: string;
  headers?: Array<Record<string, unknown>>;
  body?: Record<string, unknown>;
  auth?: Record<string, unknown> | null;
  scripts?: Array<Record<string, unknown>>;
  parentId?: string;
}

interface FakeCollection {
  id: string;
  name: string;
  variables: Array<Record<string, unknown>>;
  auth?: Record<string, unknown> | null;
  scripts?: Array<Record<string, unknown>>;
  items: Map<string, FakeItem>;
}

export interface PlatformOptions {
  teamId?: number;
  userId?: number;
  /** The canonical Smoke collection's id (bare model id). */
  smokeCollectionId?: string;
  /** The canonical Smoke collection's name (election key -- must survive). */
  smokeCollectionName?: string;
  /** Workspace id that owns the canonical collection. */
  workspaceId?: string;
  /** Spec id generation runs against. */
  specId?: string;
  /** Items served on the generated temporary collection's export. */
  generatedItems?: Array<{
    name: string;
    method: string;
    url: string;
    requestBody?: Record<string, unknown>;
  }>;
}

export interface PlatformState {
  mintCount: number;
  generatedCollectionId: string;
  tempCollectionDeleted: boolean;
  canonicalPatched: boolean;
  events: string[];
}

let itemSequence = 0;
function nextId(prefix: string): string {
  itemSequence += 1;
  return `${prefix}-${String(itemSequence).padStart(4, '0')}`;
}

/**
 * Create the deterministic platform fake. Item/collection ids are sequential
 * (never random) so a recorded cassette replays byte-identically.
 */
export function createPlatform(options: PlatformOptions = {}) {
  itemSequence = 0;
  const teamId = options.teamId ?? 10490519;
  const userId = options.userId ?? 12345678;
  const workspaceId = options.workspaceId ?? 'ws-contract';
  const specId = options.specId ?? 'spec-contract';
  const smokeCollectionId = options.smokeCollectionId ?? '12345678-col-smoke';
  const smokeCollectionName = options.smokeCollectionName ?? 'payments Smoke Tests';
  const generatedItems = options.generatedItems ?? [
    {
      name: 'createPayment',
      method: 'POST',
      url: 'https://api.example.com/payments',
      requestBody: { type: 'json', content: '{"amount":100}' }
    },
    { name: 'getPayment', method: 'GET', url: 'https://api.example.com/payments/{paymentId}' }
  ];

  const state: PlatformState = {
    mintCount: 0,
    generatedCollectionId: '',
    tempCollectionDeleted: false,
    canonicalPatched: false,
    events: []
  };

  const collections = new Map<string, FakeCollection>();
  collections.set(smokeCollectionId, {
    id: smokeCollectionId,
    name: smokeCollectionName,
    variables: [],
    items: new Map(
      [
        {
          id: nextId('12345678-item-old'),
          $kind: 'http-request',
          name: 'stale request',
          method: 'GET',
          url: 'https://api.example.com/stale'
        } satisfies FakeItem
      ].map((item) => [item.id, item])
    )
  });

  /** One pending generation task; flips to completed on the first poll. */
  let generationTask: { id: string; polls: number } | undefined;

  function exportCollection(collection: FakeCollection): Record<string, unknown> {
    const items = [...collection.items.values()].map((item) => ({
      id: item.id,
      $kind: item.$kind,
      name: item.name,
      ...(item.method ? { method: item.method } : {}),
      ...(item.url ? { url: item.url } : {}),
      ...(item.headers ? { headers: item.headers } : {}),
      ...(item.body ? { body: item.body } : {}),
      ...(item.scripts ? { scripts: item.scripts } : {})
    }));
    return {
      data: {
        collection: {
          id: collection.id,
          name: collection.name,
          $kind: 'collection',
          variables: collection.variables,
          items
        }
      }
    };
  }

  function handleProxy(payload: {
    service: string;
    method: string;
    path: string;
    body?: unknown;
    query?: Record<string, unknown>;
  }): Response {
    const method = String(payload.method ?? 'get').toLowerCase();
    const parsed = new URL(String(payload.path ?? ''), 'https://smoke-flow-fake.invalid');
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const pathQuery = Object.fromEntries(parsed.searchParams.entries());
    const query = payload.query === undefined ? pathQuery : payload.query;
    state.events.push(`proxy:${payload.service} ${method.toUpperCase()} ${pathname}`);

    const requireQuery = (expected: Record<string, string> = {}) => {
      if (!isRecord(query) || !hasOnlyKeys(query, Object.keys(expected))) {
        fail(`proxy query for ${payload.service} ${method.toUpperCase()} ${pathname}`);
      }
      for (const [key, value] of Object.entries(expected)) {
        if (query[key] !== value) fail(`proxy query for ${payload.service} ${method.toUpperCase()} ${pathname}`);
      }
      if (Object.keys(pathQuery).length > 0 && JSON.stringify(pathQuery) !== JSON.stringify(expected)) {
        fail(`proxy path query for ${payload.service} ${method.toUpperCase()} ${pathname}`);
      }
    };
    const requireBody = (keys: readonly string[]) => {
      if (!isRecord(payload.body) || !hasOnlyKeys(payload.body, keys)) {
        fail(`proxy body for ${payload.service} ${method.toUpperCase()} ${pathname}`);
      }
      return payload.body;
    };
    const requireNoBody = () => {
      if (payload.body !== undefined) fail(`proxy body for ${payload.service} ${method.toUpperCase()} ${pathname}`);
    };
    const requirePatch = (paths: readonly string[], validOps: Record<string, readonly string[]>) => {
      if (!Array.isArray(payload.body) || payload.body.length === 0) {
        fail(`proxy patch body for ${payload.service} ${method.toUpperCase()} ${pathname}`);
      }
      for (const op of payload.body) {
        if (!isRecord(op) || !hasOnlyKeys(op, ['op', 'path', 'value']) ||
          typeof op.op !== 'string' || typeof op.path !== 'string' || !paths.includes(op.path) ||
          !validOps[op.path]?.includes(op.op) || (op.op === 'remove' ? 'value' in op : !('value' in op))) {
          fail(`proxy patch body for ${payload.service} ${method.toUpperCase()} ${pathname}`);
        }
        if (op.op !== 'remove' && (
          (op.path === '/name' || op.path === '/method' || op.path === '/url') && typeof op.value !== 'string' ||
          (op.path === '/headers' || op.path === '/variables' || op.path === '/scripts') && !Array.isArray(op.value) ||
          (op.path === '/position' || op.path === '/body' || op.path === '/auth') && !isRecord(op.value)
        )) fail(`proxy patch body for ${payload.service} ${method.toUpperCase()} ${pathname}`);
      }
    };

    if (payload.service === 'specification') {
      if (method === 'get' && pathname === `/specifications/${specId}/collections`) {
        requireQuery();
        requireNoBody();
        const data = state.generatedCollectionId && !state.tempCollectionDeleted
          ? [{ collection: state.generatedCollectionId }]
          : [];
        return json({ data });
      }
      if (method === 'post' && pathname === `/specifications/${specId}/collections`) {
        requireQuery();
        const body = requireBody(['name', 'options']);
        if (typeof body.name !== 'string' || !isRecord(body.options) ||
          !hasOnlyKeys(body.options, ['requestNameSource']) || body.options.requestNameSource !== 'Fallback') {
          fail(`proxy body for ${payload.service} ${method.toUpperCase()} ${pathname}`);
        }
        const requestedName = body.name;
        const generated: FakeCollection = {
          id: nextId('12345678-col-temp'),
          name: requestedName,
          variables: [{ key: 'baseUrl', value: 'https://api.example.com' }],
          items: new Map(
            generatedItems.map((item) => {
              const created: FakeItem = {
                id: nextId('12345678-item-gen'),
                $kind: 'http-request',
                name: item.name,
                method: item.method,
                url: item.url,
                ...(item.requestBody ? { body: item.requestBody } : {})
              };
              return [created.id, created];
            })
          )
        };
        collections.set(generated.id, generated);
        state.generatedCollectionId = generated.id;
        generationTask = { id: nextId('task'), polls: 0 };
        return json({ data: { taskId: generationTask.id } });
      }
      if (method === 'get' && pathname === '/tasks') {
        requireQuery({ entityId: specId, entityType: 'specification', type: 'collection-generation' });
        requireNoBody();
        if (!generationTask) return json({ data: {} });
        generationTask.polls += 1;
        return json({ data: { [generationTask.id]: 'completed' } });
      }
    }

    if (payload.service === 'collection') {
      const exportMatch = pathname.match(/^\/v3\/collections\/([^/]+)\/export$/);
      if (method === 'get' && exportMatch) {
        requireQuery();
        requireNoBody();
        const collection = resolveCollection(String(exportMatch[1]));
        if (!collection) return json({ error: 'not found' }, 404);
        return json(exportCollection(collection));
      }
      if (method === 'get' && pathname === '/v3/collections') {
        requireQuery({ workspace: workspaceId });
        requireNoBody();
        // Workspace ownership gate: the canonical collection lives in the workspace.
        return json({ data: [{ id: smokeCollectionId }] });
      }
      const itemsMatch = pathname.match(/^\/v3\/collections\/([^/]+)\/items$/);
      if (method === 'get' && itemsMatch) {
        requireQuery();
        requireNoBody();
        const collection = resolveCollection(String(itemsMatch[1]));
        if (!collection) return json({ error: 'not found' }, 404);
        return json({
          data: [...collection.items.values()].map((item) => ({
            id: item.id,
            $kind: item.$kind,
            name: item.name
          }))
        });
      }
      if (method === 'post' && itemsMatch) {
        requireQuery();
        const collection = resolveCollection(String(itemsMatch[1]));
        if (!collection) return json({ error: 'not found' }, 404);
        const body = requireBody(['$kind', 'name', 'method', 'url', 'headers', 'position', 'body', 'auth']);
        if (body.$kind !== 'http-request' || typeof body.name !== 'string' ||
          typeof body.method !== 'string' || typeof body.url !== 'string' || !Array.isArray(body.headers) ||
          !isRecord(body.position) || !('parent' in body.position) ||
          (body.body !== undefined && !isRecord(body.body)) || (body.auth !== undefined && !isRecord(body.auth))) {
          fail(`proxy body for ${payload.service} ${method.toUpperCase()} ${pathname}`);
        }
        const created: FakeItem = {
          id: nextId('12345678-item-new'),
          $kind: String(body.$kind ?? 'http-request'),
          name: String(body.name ?? ''),
          ...(body.method ? { method: String(body.method) } : {}),
          ...(body.url ? { url: String(body.url) } : {}),
          ...(Array.isArray(body.headers) ? { headers: body.headers as Array<Record<string, unknown>> } : {}),
          ...(body.body && typeof body.body === 'object' ? { body: body.body as Record<string, unknown> } : {}),
          ...(Array.isArray(body.scripts) ? { scripts: body.scripts as Array<Record<string, unknown>> } : {})
        };
        collection.items.set(created.id, created);
        return json({ data: { id: created.id } });
      }
      const itemMatch = pathname.match(/^\/v3\/collections\/([^/]+)\/items\/([^/]+)$/);
      if (itemMatch) {
        const collection = resolveCollection(String(itemMatch[1]));
        if (!collection) return json({ error: 'not found' }, 404);
        const itemId = String(itemMatch[2]);
        const item =
          collection.items.get(itemId) ??
          [...collection.items.values()].find((entry) => entry.id.endsWith(itemId));
        if (method === 'get') {
          requireQuery();
          requireNoBody();
          if (!item) return json({ error: 'not found' }, 404);
          return json({
            data: {
              id: item.id,
              $kind: item.$kind,
              name: item.name,
              ...(item.method ? { method: item.method } : {}),
              ...(item.url ? { url: item.url } : {}),
              ...(item.headers ? { headers: item.headers } : {}),
              ...(item.body ? { body: item.body } : {}),
              ...(item.scripts ? { scripts: item.scripts } : {})
            }
          });
        }
        if (method === 'delete') {
          requireQuery();
          requireNoBody();
          if (item) collection.items.delete(item.id);
          return json({ data: {} });
        }
        if (method === 'patch') {
          requireQuery();
          requirePatch(
            ['/name', '/method', '/url', '/headers', '/position', '/body', '/auth', '/scripts'],
            {
              '/name': ['add'], '/method': ['add'], '/url': ['add'], '/headers': ['add'],
              '/position': ['add'], '/body': ['add', 'remove'], '/auth': ['add', 'remove'],
              '/scripts': ['add']
            }
          );
          if (!item) return json({ error: 'not found' }, 404);
          for (const op of (payload.body as Array<Record<string, unknown>>) ?? []) {
            const path = String(op.path ?? '');
            if (path === '/scripts') item.scripts = op.value as Array<Record<string, unknown>>;
            if (path === '/name') item.name = String(op.value ?? '');
            if (path === '/auth') item.auth = op.value as Record<string, unknown>;
            if (path === '/url') item.url = String(op.value ?? '');
            if (path === '/headers') item.headers = op.value as Array<Record<string, unknown>>;
            if (path === '/body') item.body = op.value as Record<string, unknown>;
          }
          return json({ data: {} });
        }
      }
      const collMatch = pathname.match(/^\/v3\/collections\/([^/]+)$/);
      if (collMatch) {
        const collection = resolveCollection(String(collMatch[1]));
        if (method === 'patch') {
          requireQuery();
          requirePatch(
            ['/name', '/auth', '/variables', '/scripts'],
            { '/name': ['replace'], '/auth': ['add', 'remove'], '/variables': ['add'], '/scripts': ['add'] }
          );
          if (!collection) return json({ error: 'not found' }, 404);
          for (const op of (payload.body as Array<Record<string, unknown>>) ?? []) {
            const path = String(op.path ?? '');
            if (path === '/name') collection.name = String(op.value ?? '');
            if (path === '/auth' && op.op !== 'remove') collection.auth = op.value as Record<string, unknown>;
            if (path === '/auth' && op.op === 'remove') collection.auth = null;
            if (path === '/variables') collection.variables = op.value as Array<Record<string, unknown>>;
            if (path === '/scripts') collection.scripts = op.value as Array<Record<string, unknown>>;
          }
          if (collection.id === smokeCollectionId) state.canonicalPatched = true;
          return json({ data: {} });
        }
        if (method === 'delete') {
          requireQuery();
          requireNoBody();
          if (collection && collection.id === state.generatedCollectionId) {
            state.tempCollectionDeleted = true;
            collections.delete(collection.id);
          }
          return json({ data: {} });
        }
      }
    }

    fail(`proxy ${payload.service} ${method.toUpperCase()} ${pathname}`);
  }

  function resolveCollection(candidate: string): FakeCollection | undefined {
    const bare = candidate.includes('-') ? candidate : candidate;
    return (
      collections.get(candidate) ??
      [...collections.values()].find(
        (entry) => entry.id.endsWith(bare) || bare.endsWith(entry.id)
      )
    );
  }

  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    state.events.push(`fetch:${method} ${url}`);
    const hosts = HOSTS.prod;

    if (url === `${hosts.api}/service-account-tokens` && method === 'POST') {
      state.mintCount += 1;
      return json({ access_token: 'access-token-test' }, 201);
    }
    if (url === `${hosts.api}/me` && method === 'GET') {
      return json({ user: { id: userId, teamId } });
    }
    if (url === `${hosts.iapub}/api/sessions/current` && method === 'GET') {
      return json({
        session: { identity: { team: String(teamId) }, consumerType: 'service_account' }
      });
    }
    if (url === `${hosts.bifrost}/ws/proxy` && method === 'POST') {
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        service?: unknown;
        method?: unknown;
        path?: unknown;
        body?: unknown;
        query?: unknown;
      };
      return handleProxy({
        service: String(payload.service ?? ''),
        method: String(payload.method ?? 'get'),
        path: String(payload.path ?? ''),
        body: payload.body,
        ...(payload.query && typeof payload.query === 'object'
          ? { query: payload.query as Record<string, unknown> }
          : {})
      });
    }

    fail(`${method} ${url}`);
  }) as typeof fetch;

  return { fetch: fetchImpl, state, collections, workspaceId, specId, smokeCollectionId };
}
