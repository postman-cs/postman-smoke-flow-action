import { HttpError } from '../lib/http-error.js';
import { AccessTokenGatewayClient } from '../lib/postman/gateway-client.js';
import type { AccessTokenProvider } from '../lib/postman/token-provider.js';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((v): v is JsonRecord => Boolean(v)) : [];
}

function bareModelId(uid: string): string {
  const u = String(uid ?? '').trim();
  return u.includes('-') ? u.slice(u.indexOf('-') + 1) : u;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** v3 export body `{type:'json'|'text', content}` -> v2 `{mode:'raw', raw}`. */
function v3BodyToV2(body: JsonRecord | null): JsonRecord | undefined {
  if (!body) return undefined;
  const content = typeof body.content === 'string' ? body.content : '';
  return { mode: 'raw', raw: content };
}

/**
 * v3 IR auth -> v2 `{type, <type>:[...]}`. Per-item auth is a single
 * `{type, credentials}` object; collection-level auth round-trips as an ARRAY of
 * auth blocks (live-observed), so the first block is taken.
 */
function v3AuthToV2(auth: unknown): JsonRecord | undefined {
  const block = Array.isArray(auth) ? asRecord(auth[0]) : asRecord(auth);
  if (!block) return undefined;
  const type = typeof block.type === 'string' ? block.type : '';
  if (!type) return undefined;
  const credentials = Array.isArray(block.credentials) ? block.credentials : [];
  return { type, [type]: credentials };
}

/**
 * v3 scripts -> v2 `event[]`. Item-level scripts use `beforeRequest`/
 * `afterResponse`; collection-root scripts use `http:beforeRequest`/
 * `http:afterRequest` (the only types the root accepts). Both map to the v2
 * `prerequest`/`test` listen names.
 */
function v3ScriptsToV2Events(scripts: unknown): JsonRecord[] {
  return asArray(scripts)
    .map((script) => {
      const type = typeof script.type === 'string' ? script.type : '';
      const listen =
        type === 'beforeRequest' || type === 'http:beforeRequest'
          ? 'prerequest'
          : type === 'afterResponse' || type === 'http:afterRequest'
            ? 'test'
            : '';
      if (!listen) return null;
      const code = typeof script.code === 'string' ? script.code : '';
      return {
        listen,
        script: { exec: code.split('\n'), type: 'text/javascript' }
      } as JsonRecord;
    })
    .filter((event): event is JsonRecord => Boolean(event));
}

/** Map one v3 export node (folder or http-request leaf) to a v2.1 collection item. */
function v3NodeToV2Item(node: JsonRecord): JsonRecord {
  const name = typeof node.name === 'string' ? node.name : '';
  if (String(node.$kind ?? '') === 'folder') {
    return { name, item: asArray(node.items).map(v3NodeToV2Item) };
  }
  const request: JsonRecord = {
    method: typeof node.method === 'string' ? node.method : 'GET',
    url: typeof node.url === 'string' ? node.url : ''
  };
  const headers = Array.isArray(node.headers) ? node.headers : [];
  request.header = headers;
  const body = v3BodyToV2(asRecord(node.body));
  if (body) request.body = body;
  const auth = v3AuthToV2(asRecord(node.auth));
  if (auth) request.auth = auth;
  const item: JsonRecord = { name, request };
  const events = v3ScriptsToV2Events(node.scripts);
  if (events.length > 0) item.event = events;
  return item;
}

/** Full v3 export `data.collection` -> v2.1 collection (info/item/auth/variable). */
function v3ExportToV2Collection(v3: JsonRecord): JsonRecord {
  const name = typeof v3.name === 'string' ? v3.name : '';
  const collection: JsonRecord = {
    info: { name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: asArray(v3.items).map(v3NodeToV2Item)
  };
  const auth = v3AuthToV2(v3.auth);
  if (auth) collection.auth = auth;
  if (Array.isArray(v3.variables)) collection.variable = v3.variables;
  const events = v3ScriptsToV2Events(v3.scripts);
  if (events.length > 0) collection.event = events;
  return collection;
}

/** v2 request url (string or `{raw}`) -> raw string for a v3 create. */
function v2UrlToRaw(url: unknown): string {
  if (typeof url === 'string') return url;
  const record = asRecord(url);
  if (record && typeof record.raw === 'string') return record.raw;
  return '';
}

/**
 * v2 auth `{type, <type>:[{key,value,...}]}` -> v3 IR `{type, credentials:[{key,value}]}`.
 * Credentials are `{key,value}` pairs (v3-auth-adapter.ts) — the v2 `type:'string'`
 * field on each entry is dropped.
 */
function v2AuthToV3(auth: JsonRecord | null): JsonRecord | undefined {
  if (!auth) return undefined;
  const type = typeof auth.type === 'string' ? auth.type : '';
  if (!type || type === 'noauth') return undefined;
  const entries = Array.isArray(auth[type]) ? (auth[type] as unknown[]) : [];
  const credentials = entries
    .map(asRecord)
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .map((entry) => ({ key: String(entry.key ?? ''), value: entry.value ?? '' }));
  return { type, credentials };
}

/** Looks-like-JSON heuristic for choosing a v3 body `type` (json vs text). */
function looksLikeJson(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (!/^[[{]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** v2 body `{mode:'raw', raw}` -> v3 IR `{type:'json'|'text', content}` (root field on create). */
function v2BodyToV3(body: JsonRecord | null): JsonRecord | undefined {
  if (!body) return undefined;
  if (body.mode !== 'raw' || typeof body.raw !== 'string') return undefined;
  const raw = body.raw;
  return { type: looksLikeJson(raw) ? 'json' : 'text', content: raw };
}

/** v2 header array -> v3 root `headers` (`{key,value}` pairs). */
function v2HeadersToV3(header: unknown): JsonRecord[] {
  return asArray(header).map((entry) => ({ key: String(entry.key ?? ''), value: entry.value ?? '' }));
}

/** v2 `event[]` -> v3 per-item `/scripts` (prerequest->beforeRequest, test->afterResponse). */
function v2EventsToV3Scripts(events: unknown): JsonRecord[] {
  return asArray(events)
    .map((event) => {
      const listen = typeof event.listen === 'string' ? event.listen : '';
      const type = listen === 'prerequest' ? 'beforeRequest' : listen === 'test' ? 'afterResponse' : '';
      if (!type) return null;
      const script = asRecord(event.script);
      const exec = Array.isArray(script?.exec) ? script!.exec.map(String) : [];
      return { type, code: exec.join('\n'), language: 'text/javascript' } as JsonRecord;
    })
    .filter((script): script is JsonRecord => Boolean(script));
}

/**
 * v2 collection-level `event[]` -> v3 collection-root `/scripts`. The root accepts
 * only `http:beforeRequest` / `http:afterRequest` (REJECTED_PATCH otherwise), so
 * the listen names map to the `http:`-prefixed forms (live-observed).
 */
function v2EventsToV3CollectionScripts(events: unknown): JsonRecord[] {
  return asArray(events)
    .map((event) => {
      const listen = typeof event.listen === 'string' ? event.listen : '';
      const type = listen === 'prerequest' ? 'http:beforeRequest' : listen === 'test' ? 'http:afterRequest' : '';
      if (!type) return null;
      const script = asRecord(event.script);
      const exec = Array.isArray(script?.exec) ? script!.exec.map(String) : [];
      return { type, code: exec.join('\n'), language: 'text/javascript' } as JsonRecord;
    })
    .filter((script): script is JsonRecord => Boolean(script));
}

export interface PostmanGatewaySmokeClientOptions {
  tokenProvider: AccessTokenProvider;
  bifrostBaseUrl?: string;
  teamId?: string;
  orgMode?: boolean;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Access-token-only Smoke collection client. Replaces the PMAK
 * {@link PostmanSmokeClient} surface (`generateCollection`/`getCollection`/
 * `updateCollection`/`deleteCollection`) with gateway operations so the reshape
 * runs without a postman-api-key:
 *
 * - generate: `specification POST /specifications/:id/collections` + task poll
 *   (mirrors bootstrap's gateway assets client).
 * - read: `collection GET /v3/collections/:cid/export` -> v3 IR, adapted back to
 *   the v2.1 shape the resolver/transform/verify code consumes unchanged.
 * - update: full-replace reconcile — list + delete every existing item, then
 *   create the curated leaves in flow order (`POST /v3/collections/:cid/items/`,
 *   v2 body/auth accepted under `payload` on create), patch each item's scripts
 *   (`/scripts` beforeRequest/afterResponse — the runnable shape), then patch the
 *   collection-level name/auth/variables (`PATCH /v3/collections/:cid`).
 * - delete: `collection DELETE /v3/collections/:cid` (404-tolerant).
 *
 * The curated v2 collection produced by `buildCuratedSmokeCollection` is a flat
 * leaf list (secrets-resolver + curated requests), so the reconcile writes a flat
 * tree; folder nesting only appears on the generated temp collection, which is
 * read (export->v2 adapter handles folders) but never written back.
 */
export class PostmanGatewaySmokeClient {
  private static readonly GENERATION_LOCKED_MAX_RETRIES = 5;
  private static readonly GENERATION_POLL_ATTEMPTS = 45;
  private static readonly GENERATION_POLL_DELAY_MS = 2000;

  private readonly gateway: AccessTokenGatewayClient;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: PostmanGatewaySmokeClientOptions) {
    this.gateway = new AccessTokenGatewayClient({
      tokenProvider: options.tokenProvider,
      ...(options.bifrostBaseUrl ? { bifrostBaseUrl: options.bifrostBaseUrl } : {}),
      ...(options.teamId ? { teamId: options.teamId } : {}),
      ...(options.orgMode !== undefined ? { orgMode: options.orgMode } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  async generateCollection(specId: string, projectName: string, prefix: string): Promise<string> {
    const name = [prefix.trim(), projectName.trim()].filter(Boolean).join(' ');
    const body = { name, options: { requestNameSource: 'Fallback' } };

    const taskId = await this.postGenerationWithLockRetry(specId, body);

    if (taskId) {
      for (let attempt = 0; attempt < PostmanGatewaySmokeClient.GENERATION_POLL_ATTEMPTS; attempt += 1) {
        await this.sleepImpl(PostmanGatewaySmokeClient.GENERATION_POLL_DELAY_MS);
        const task = await this.gateway.requestJson<JsonRecord>({
          service: 'specification',
          method: 'get',
          path: '/tasks',
          query: { entityId: specId, entityType: 'specification', type: 'collection-generation' }
        });
        const status = String(asRecord(task?.data)?.[taskId] ?? '').toLowerCase();
        if (status === 'failed' || status === 'error') {
          throw new Error(`Collection generation task failed for ${prefix}`);
        }
        if (status && status !== 'in-progress' && status !== 'pending' && status !== 'queued') {
          break;
        }
        if (attempt === PostmanGatewaySmokeClient.GENERATION_POLL_ATTEMPTS - 1) {
          throw new Error(`Collection generation timed out for ${prefix}`);
        }
      }
    }

    const list = await this.gateway.requestJson<JsonRecord>({
      service: 'specification',
      method: 'get',
      path: `/specifications/${specId}/collections`
    });
    const entries = asArray(asRecord(list)?.data);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const uid = String(entries[i]?.collection ?? entries[i]?.collectionId ?? entries[i]?.id ?? '').trim();
      if (uid) return uid;
    }
    throw new Error(`Collection generation did not yield a collection uid for ${prefix}`);
  }

  /** POST the generation request, retrying a 423-locked spec; returns the task id. */
  private async postGenerationWithLockRetry(specId: string, body: unknown): Promise<string> {
    for (let lockedAttempt = 0; ; lockedAttempt += 1) {
      try {
        const created = await this.gateway.requestJson<JsonRecord>({
          service: 'specification',
          method: 'post',
          path: `/specifications/${specId}/collections`,
          body
        });
        return String(asRecord(created?.data)?.taskId ?? '').trim();
      } catch (error) {
        const locked = error instanceof HttpError && error.status === 423;
        if (!locked || lockedAttempt >= PostmanGatewaySmokeClient.GENERATION_LOCKED_MAX_RETRIES) {
          throw error;
        }
        await this.sleepImpl(5000 * Math.pow(2, lockedAttempt));
      }
    }
  }

  async getCollection(collectionUid: string): Promise<JsonRecord> {
    const cid = bareModelId(collectionUid);
    const exported = await this.gateway.requestJson<JsonRecord>({
      service: 'collection',
      method: 'get',
      path: `/v3/collections/${cid}/export`
    });
    const v3 = asRecord(asRecord(exported?.data)?.collection) ?? asRecord(exported?.data);
    if (!v3) {
      throw new Error(`Failed to export collection ${collectionUid}`);
    }
    return v3ExportToV2Collection(v3);
  }

  async updateCollection(collectionUid: string, collection: unknown): Promise<void> {
    const cid = bareModelId(collectionUid);
    const desired = asRecord(collection);
    if (!desired) {
      throw new Error(`updateCollection: invalid collection payload for ${collectionUid}`);
    }

    // Full-replace: delete every existing item (leaves + folders), then recreate.
    await this.deleteAllItems(cid);

    // Create curated leaves in order; collection.item is a flat leaf list.
    // The v3 IR item carries url/method/headers/body/auth at the ROOT (sibling
    // fields), NOT under a `payload` wrapper — a payload wrapper is silently
    // dropped (live-proven). Body/auth use the v3 IR shapes ({type,content} /
    // {type,credentials}); headers are {key,value} pairs.
    for (const leaf of asArray(desired.item)) {
      const request = asRecord(leaf.request) ?? {};
      const createBody: JsonRecord = {
        $kind: 'http-request',
        name: typeof leaf.name === 'string' ? leaf.name : '',
        method: typeof request.method === 'string' ? request.method : 'GET',
        url: v2UrlToRaw(request.url),
        headers: v2HeadersToV3(request.header),
        position: { parent: { id: cid, $kind: 'collection' } }
      };
      const body = v2BodyToV3(asRecord(request.body));
      if (body) createBody.body = body;
      const auth = v2AuthToV3(asRecord(request.auth));
      if (auth) createBody.auth = auth;
      const created = await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'post',
        path: `/v3/collections/${cid}/items/`,
        headers: { 'X-Entity-Type': 'http-request' },
        body: createBody
      });
      const newItemId = String(asRecord(created?.data)?.id ?? '').trim();
      const scripts = v2EventsToV3Scripts(leaf.event);
      if (newItemId && scripts.length > 0) {
        await this.gateway.request({
          service: 'collection',
          method: 'patch',
          path: `/v3/collections/${cid}/items/${newItemId}`,
          headers: { 'X-Entity-Type': 'http-request' },
          body: [{ op: 'add', path: '/scripts', value: scripts }]
        });
      }
    }

    // Collection-level: name, auth, variables.
    const ops: JsonRecord[] = [];
    const info = asRecord(desired.info);
    const name = typeof info?.name === 'string' ? info.name : undefined;
    if (name !== undefined) ops.push({ op: 'replace', path: '/name', value: name });
    const collAuth = v2AuthToV3(asRecord(desired.auth));
    if (collAuth) ops.push({ op: 'add', path: '/auth', value: collAuth });
    if (Array.isArray(desired.variable)) {
      const variables = desired.variable
        .map(asRecord)
        .filter((v): v is JsonRecord => Boolean(v))
        .map((v) => ({ key: String(v.key ?? ''), value: v.value ?? '' }));
      if (variables.length > 0) ops.push({ op: 'add', path: '/variables', value: variables });
    }
    if (ops.length > 0) {
      await this.gateway.request({
        service: 'collection',
        method: 'patch',
        path: `/v3/collections/${cid}`,
        body: ops
      });
    }

    // Collection-level scripts (e.g. the OAuth token-cache pre-request) go in a
    // SEPARATE patch: the root accepts only http:beforeRequest/http:afterRequest,
    // and mixing a rejected script op into the ops array above would 400 the whole
    // patch. Tolerated as best-effort so a script-shape rejection can't abort the
    // reconcile after items + collection metadata already landed.
    const collScripts = v2EventsToV3CollectionScripts(desired.event);
    if (collScripts.length > 0) {
      await this.gateway
        .request({
          service: 'collection',
          method: 'patch',
          path: `/v3/collections/${cid}`,
          body: [{ op: 'add', path: '/scripts', value: collScripts }]
        })
        .catch(() => undefined);
    }
  }

  /**
   * Delete every item (leaves + folders) from a collection, then verify the
   * collection is empty. The gateway's item-delete returns a spurious `500
   * GENERIC_ERROR` even though the delete lands server-side (live-observed); a
   * blind throw would abort the reconcile mid-replace. So per-item delete errors
   * are tolerated and the *end state* is the source of truth: re-list and retry
   * any survivors across a few rounds, throwing only if items genuinely persist.
   */
  private async deleteAllItems(cid: string): Promise<void> {
    const maxRounds = 4;
    for (let round = 0; round < maxRounds; round += 1) {
      const listed = await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'get',
        path: `/v3/collections/${cid}/items/`
      });
      const items = asArray(listed?.data);
      if (items.length === 0) return;
      if (round === maxRounds - 1) {
        throw new Error(`updateCollection: ${items.length} item(s) survived delete on collection ${cid}`);
      }
      for (const item of items) {
        const itemId = String(item.id ?? '').trim();
        if (!itemId) continue;
        const kind = String(item.$kind ?? 'http-request');
        try {
          await this.gateway.request({
            service: 'collection',
            method: 'delete',
            path: `/v3/collections/${cid}/items/${itemId}`,
            headers: { 'X-Entity-Type': kind }
          });
        } catch {
          // Tolerated: the gateway returns 500 on a delete that nonetheless
          // lands. The next round's re-list is authoritative.
        }
      }
    }
  }

  async deleteCollection(collectionUid: string): Promise<void> {
    const cid = bareModelId(collectionUid);
    try {
      await this.gateway.request({
        service: 'collection',
        method: 'delete',
        path: `/v3/collections/${cid}`
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return;
      }
      throw error;
    }
  }
}
