import { HttpError } from '../lib/http-error.js';
import { AccessTokenGatewayClient } from '../lib/postman/gateway-client.js';
import type { AccessTokenProvider } from '../lib/postman/token-provider.js';

type JsonRecord = Record<string, unknown>;
type ParentRef = { id: string; $kind: 'collection' };
type ItemListing = {
  entries: JsonRecord[];
  parentByChildId: Map<string, string>;
};

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

/** Transient/ambiguous create responses where the server may have accepted the write. */
function isAmbiguousCreateError(error: unknown): boolean {
  if (!(error instanceof HttpError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

const isAmbiguousMutationError = isAmbiguousCreateError;

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
  // Container node: a request folder/group. The v3 export marks folders as
  // `$kind:'collection'` (NOT 'folder') with child requests under `items`; an
  // http-request leaf has no `items` (it carries `examples`). Recurse on either
  // signal so nested requests aren't lost as a `method:'GET', url:''` pseudo-leaf.
  const kind = String(node.$kind ?? '');
  if (kind === 'folder' || kind === 'collection' || Array.isArray(node.items)) {
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

function isNoAuth(auth: JsonRecord | null): boolean {
  return auth?.type === 'noauth';
}

function isMissingPatchValueError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 400 &&
    error.responseBody.includes('Remove operation must point to an existing value')
  );
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

function itemParentBareId(item: JsonRecord, parentByChildId: ReadonlyMap<string, string>): string | null {
  const itemId = bareModelId(String(item.id ?? item.uid ?? ''));
  const stubParent = itemId ? parentByChildId.get(itemId) : undefined;
  if (stubParent) return stubParent;

  // Stub references are authoritative. Keep position.parent only as a forward-
  // compatible fallback if a future listing starts returning it on full entries.
  const raw = asRecord(item.position)?.parent;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string') return bareModelId(raw);
  const record = asRecord(raw);
  if (record && typeof record.id === 'string') return bareModelId(String(record.id));
  return null;
}

export interface PostmanGatewaySmokeClientOptions {
  tokenProvider: AccessTokenProvider;
  bifrostBaseUrl?: string;
  teamId?: string;
  orgMode?: boolean;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Workspace that must own the canonical collection before any mutate. */
  workspaceId?: string;
  /**
   * Run-owned identity token embedded in temporary collection names so an
   * ambiguous generate response can be reconciled without adopting a peer run.
   */
  runIdentity?: string;
}

/**
 * Access-token-only Smoke collection client implementing the
 * `SmokeCollectionClient` surface (`generateCollection`/`getCollection`/
 * `updateCollection`/`deleteCollection`) with gateway operations so the reshape
 * runs without a postman-api-key:
 *
 * - generate: `specification POST /specifications/:id/collections` + task poll,
 *   with run-unique naming, pre-run snapshot correlation, and no blind POST retry.
 * - read: `collection GET /v3/collections/:cid/export` -> v3 IR, adapted back to
 *   the v2.1 shape the resolver/transform/verify code consumes unchanged.
 * - update: workspace ownership gate, then deterministic in-place item
 *   reconciliation by name (fail-closed on duplicates). Folder/request creates
 *   opt out of blind transport retries and reconcile after ambiguous 5xx.
 * - delete: only temporary collection IDs positively owned by this run
 *   (`collection DELETE /v3/collections/:cid`, 404-tolerant).
 *
 * Curated flow collections are already flat. No-flow refreshes can pass through
 * generated collection folders, so update writes the tree recursively to preserve
 * the generated folder structure.
 */
export class PostmanGatewaySmokeClient {
  private static readonly GENERATION_LOCKED_MAX_RETRIES = 5;
  private static readonly GENERATION_POLL_ATTEMPTS = 90;
  private static readonly GENERATION_POLL_DELAY_MS = 2000;

  private readonly gateway: AccessTokenGatewayClient;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly workspaceId?: string;
  private readonly runIdentity?: string;
  private readonly ownedTemporaryCollectionIds = new Set<string>();

  constructor(options: PostmanGatewaySmokeClientOptions) {
    this.gateway = new AccessTokenGatewayClient({
      tokenProvider: options.tokenProvider,
      ...(options.bifrostBaseUrl ? { bifrostBaseUrl: options.bifrostBaseUrl } : {}),
      ...(options.teamId ? { teamId: options.teamId } : {}),
      ...(options.orgMode !== undefined ? { orgMode: options.orgMode } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {})
    });
    this.sleepImpl = options.sleepImpl ?? sleep;
    const workspaceId = String(options.workspaceId ?? '').trim();
    this.workspaceId = workspaceId || undefined;
    const runIdentity = String(options.runIdentity ?? '').trim();
    this.runIdentity = runIdentity || undefined;
  }

  async generateCollection(specId: string, projectName: string, prefix: string): Promise<string> {
    const ownedName = [prefix.trim(), projectName.trim(), this.runIdentity].filter(Boolean).join(' ');
    const body = { name: ownedName, options: { requestNameSource: 'Fallback' } };
    const preSnapshot = await this.listSpecCollectionUids(specId);

    let taskId: string;
    try {
      taskId = await this.postGenerationWithLockRetry(specId, body);
    } catch (error) {
      if (!isAmbiguousCreateError(error)) {
        throw error;
      }
      const reconciled = await this.reconcileGeneratedCollection(specId, ownedName, preSnapshot);
      if (!reconciled) {
        throw error;
      }
      this.rememberOwnedTemporaryCollection(reconciled);
      return reconciled;
    }

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

    const owned = await this.reconcileGeneratedCollection(specId, ownedName, preSnapshot);
    if (!owned) {
      throw new Error(`Collection generation did not yield a collection uid for ${prefix}`);
    }
    this.rememberOwnedTemporaryCollection(owned);
    return owned;
  }

  /** POST the generation request, retrying a 423-locked spec; returns the task id. */
  private async postGenerationWithLockRetry(specId: string, body: unknown): Promise<string> {
    for (let lockedAttempt = 0; ; lockedAttempt += 1) {
      try {
        const created = await this.gateway.requestJson<JsonRecord>({
          service: 'specification',
          method: 'post',
          path: `/specifications/${specId}/collections`,
          body,
          // Unsafe create: never blind-retry an ambiguous accept.
          maxRetries: 0
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

  private async listSpecCollectionUids(specId: string): Promise<string[]> {
    const list = await this.gateway.requestJson<JsonRecord>({
      service: 'specification',
      method: 'get',
      path: `/specifications/${specId}/collections`
    });
    const uids: string[] = [];
    for (const entry of asArray(asRecord(list)?.data)) {
      const uid = String(entry.collection ?? entry.collectionId ?? entry.id ?? '').trim();
      if (uid) uids.push(uid);
    }
    return uids;
  }

  /**
   * Adopt the temporary collection that matches this run's unique name, preferring
   * IDs absent from the pre-run snapshot so peer temps are never selected.
   */
  private async reconcileGeneratedCollection(
    specId: string,
    ownedName: string,
    preSnapshot: readonly string[]
  ): Promise<string | null> {
    const pre = new Set(preSnapshot);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const listed = (await this.listSpecCollectionUids(specId)).filter((uid) => !pre.has(uid));
      const matches: string[] = [];
      for (const uid of listed) {
        try {
          const exported = await this.gateway.requestJson<JsonRecord>({
            service: 'collection',
            method: 'get',
            path: `/v3/collections/${bareModelId(uid)}/export`
          });
          const collection = asRecord(asRecord(exported?.data)?.collection) ?? asRecord(exported?.data);
          const name = typeof collection?.name === 'string' ? collection.name : '';
          if (name === ownedName) matches.push(uid);
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) throw error;
        }
      }
      if (matches.length === 1) return matches[0] ?? null;
      if (matches.length > 1) {
        throw new Error(
          `Collection generation reconciled ambiguously for ${ownedName}: ${matches.join(', ')}`
        );
      }
      if (attempt < 5) await this.sleepImpl(Math.min(2000, 250 * 2 ** attempt));
    }
    return null;
  }

  private rememberOwnedTemporaryCollection(collectionUid: string): void {
    const trimmed = String(collectionUid ?? '').trim();
    if (!trimmed) return;
    this.ownedTemporaryCollectionIds.add(trimmed);
    this.ownedTemporaryCollectionIds.add(bareModelId(trimmed));
  }

  private isOwnedTemporaryCollection(collectionUid: string): boolean {
    const trimmed = String(collectionUid ?? '').trim();
    if (!trimmed) return false;
    return (
      this.ownedTemporaryCollectionIds.has(trimmed) ||
      this.ownedTemporaryCollectionIds.has(bareModelId(trimmed))
    );
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

    await this.assertCanonicalBelongsToWorkspace(collectionUid);

    await this.reconcileItemsRecursive(cid, desired.item, { id: cid, $kind: 'collection' });

    // Collection-level: name, auth, variables.
    const ops: JsonRecord[] = [];
    const info = asRecord(desired.info);
    const name = typeof info?.name === 'string' ? info.name : undefined;
    if (name !== undefined) ops.push({ op: 'replace', path: '/name', value: name });
    const desiredAuth = asRecord(desired.auth);
    const collAuth = v2AuthToV3(desiredAuth);
    const clearCollectionAuth = !collAuth && isNoAuth(desiredAuth);
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
        body: ops,
        // Fixed-path add/replace operations are idempotent.
        maxRetries: 3
      });
    }
    if (clearCollectionAuth) {
      await this.clearCollectionAuth(cid);
    }

    // Collection-level scripts (e.g. the OAuth token-cache pre-request) go in a
    // separate patch. The root accepts only http:beforeRequest/http:afterRequest.
    // A schema-shape 400 remains best-effort, but auth and server failures surface.
    const collScripts = v2EventsToV3CollectionScripts(desired.event);
    if (collScripts.length > 0) {
      try {
        await this.gateway.request({
          service: 'collection',
          method: 'patch',
          path: `/v3/collections/${cid}`,
          body: [{ op: 'add', path: '/scripts', value: collScripts }],
          // Adding the same root script value is idempotent.
          maxRetries: 3
        });
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 400)) throw error;
      }
    }
  }

  private async assertCanonicalBelongsToWorkspace(collectionUid: string): Promise<void> {
    if (!this.workspaceId) {
      return;
    }
    const listed = await this.gateway.requestJson<JsonRecord>({
      service: 'collection',
      method: 'get',
      path: `/v3/collections/?workspace=${encodeURIComponent(this.workspaceId)}`
    });
    const collections = asArray(asRecord(listed)?.data ?? listed?.data);
    const bare = bareModelId(collectionUid);
    const found = collections.some((entry) => {
      const id = String(entry.id ?? entry.uid ?? '').trim();
      return id === collectionUid || bareModelId(id) === bare;
    });
    if (!found) {
      throw new Error(
        `Canonical collection ${collectionUid} does not belong to workspace ${this.workspaceId} (not found in workspace); refusing mutate`
      );
    }
  }

  private async clearCollectionAuth(cid: string): Promise<void> {
    try {
      await this.gateway.request({
        service: 'collection',
        method: 'patch',
        path: `/v3/collections/${cid}`,
        body: [{ op: 'remove', path: '/auth' }],
        // Removing auth has one end state; a repeated missing-value response is
        // handled below as successful reconciliation.
        maxRetries: 3
      });
    } catch (error) {
      if (isMissingPatchValueError(error)) {
        return;
      }
      throw error;
    }
  }

  private async listItems(cid: string): Promise<ItemListing> {
    const listed = await this.gateway.requestJson<JsonRecord>({
      service: 'collection',
      method: 'get',
      path: `/v3/collections/${cid}/items/`
    });
    const entries = asArray(listed?.data);
    const parentByChildId = new Map<string, string>();
    for (const parent of entries) {
      const parentId = bareModelId(String(parent.id ?? parent.uid ?? ''));
      if (!parentId) continue;
      for (const stub of asArray(parent.items)) {
        const childId = bareModelId(String(stub.id ?? stub.uid ?? ''));
        if (!childId) continue;
        const existingParent = parentByChildId.get(childId);
        if (existingParent && existingParent !== parentId) {
          throw new Error(`updateCollection: item ${childId} is referenced by multiple parents`);
        }
        parentByChildId.set(childId, parentId);
      }
    }
    return { entries, parentByChildId };
  }

  private listChildItems(listing: ItemListing, parentId: string, collectionCid: string): JsonRecord[] {
    const parentBare = bareModelId(parentId);
    const isCollectionRoot = parentBare === collectionCid || parentId === collectionCid;
    return listing.entries.filter((item) => {
      const itemParent = itemParentBareId(item, listing.parentByChildId);
      if (itemParent === null) {
        return isCollectionRoot;
      }
      return itemParent === parentBare || itemParent === bareModelId(parentId);
    });
  }

  private assertUniqueNames(items: JsonRecord[], parentId: string, label: string): Map<string, JsonRecord> {
    const byName = new Map<string, JsonRecord[]>();
    for (const item of items) {
      const name = String(item.name ?? '');
      const group = byName.get(name) ?? [];
      group.push(item);
      byName.set(name, group);
    }
    for (const [name, group] of byName) {
      if (group.length > 1) {
        throw new Error(
          `updateCollection: duplicate ${label} item name "${name}" under parent ${parentId}; refusing to reconcile`
        );
      }
    }
    const unique = new Map<string, JsonRecord>();
    for (const [name, group] of byName) {
      const only = group[0];
      if (only) unique.set(name, only);
    }
    return unique;
  }

  private async reconcileItemsRecursive(cid: string, desiredItems: unknown, parent: ParentRef): Promise<void> {
    const listing = await this.listItems(cid);
    const siblings = this.listChildItems(listing, parent.id, cid);
    const existingByName = this.assertUniqueNames(siblings, parent.id, 'existing');

    const desiredArray = asArray(desiredItems);
    const desiredNames = new Set<string>();
    for (const item of desiredArray) {
      const name = typeof item.name === 'string' ? item.name : '';
      if (desiredNames.has(name)) {
        throw new Error(`updateCollection: duplicate desired item name "${name}" under parent ${parent.id}`);
      }
      desiredNames.add(name);
    }

    for (const sibling of siblings) {
      const name = String(sibling.name ?? '');
      if (!desiredNames.has(name)) {
        await this.deleteItemTolerant(cid, sibling);
      }
    }

    const refreshed = this.listChildItems(await this.listItems(cid), parent.id, cid);
    const remainingByName = this.assertUniqueNames(refreshed, parent.id, 'existing');

    for (const item of desiredArray) {
      const name = typeof item.name === 'string' ? item.name : '';
      const request = asRecord(item.request);
      if (request) {
        const existing = remainingByName.get(name);
        if (existing && String(existing.$kind ?? 'http-request') === 'http-request') {
          await this.updateRequestItem(cid, existing, item, request, parent);
          continue;
        }
        if (existing) {
          await this.deleteItemTolerant(cid, existing);
        }
        await this.createRequestItem(cid, item, request, parent);
        continue;
      }

      if (Array.isArray(item.item)) {
        const existing = remainingByName.get(name) ?? existingByName.get(name);
        if (existing && String(existing.$kind ?? '') !== 'collection') {
          await this.deleteItemTolerant(cid, existing);
        }
        const folderId = existing && String(existing.$kind ?? '') === 'collection'
          ? String(existing.id ?? '').trim()
          : await this.createFolderItem(cid, item, parent);
        if (!folderId) {
          throw new Error(`updateCollection: missing folder id for ${name || '<unnamed>'}`);
        }
        await this.reconcileItemsRecursive(cid, item.item, { id: folderId, $kind: 'collection' });
      }
    }
  }

  private async deleteItemTolerant(cid: string, item: JsonRecord): Promise<void> {
    const itemId = String(item.id ?? '').trim();
    if (!itemId) return;
    const kind = String(item.$kind ?? 'http-request');
    let lastAmbiguousError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.gateway.request({
          service: 'collection',
          method: 'delete',
          path: `/v3/collections/${cid}/items/${itemId}`,
          headers: { 'X-Entity-Type': kind },
          maxRetries: 0
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return;
        if (!isAmbiguousMutationError(error)) throw error;
        lastAmbiguousError = error;
      }
      const remains = (await this.listItems(cid)).entries.some(
        (candidate) => bareModelId(String(candidate.id ?? candidate.uid ?? '')) === bareModelId(itemId)
      );
      if (!remains) return;
      if (attempt < 3) await this.sleepImpl(Math.min(2000, 250 * 2 ** attempt));
    }
    if (lastAmbiguousError) throw lastAmbiguousError;
    throw new Error(`updateCollection: item ${itemId} survived delete on collection ${cid}`);
  }

  private requestCreateBody(leaf: JsonRecord, request: JsonRecord, parent: ParentRef): JsonRecord {
    const createBody: JsonRecord = {
      $kind: 'http-request',
      name: typeof leaf.name === 'string' ? leaf.name : '',
      method: typeof request.method === 'string' ? request.method : 'GET',
      url: v2UrlToRaw(request.url),
      headers: v2HeadersToV3(request.header),
      position: { parent }
    };
    const body = v2BodyToV3(asRecord(request.body));
    if (body) createBody.body = body;
    const auth = v2AuthToV3(asRecord(request.auth));
    if (auth) createBody.auth = auth;
    return createBody;
  }

  private async updateRequestItem(
    cid: string,
    existing: JsonRecord,
    leaf: JsonRecord,
    request: JsonRecord,
    parent: ParentRef
  ): Promise<void> {
    const itemId = String(existing.id ?? existing.uid ?? '').trim();
    if (!itemId) throw new Error(`updateCollection: existing request ${String(leaf.name ?? '<unnamed>')} has no id`);
    const desired = this.requestCreateBody(leaf, request, parent);
    const ops: JsonRecord[] = Object.entries(desired)
      .filter(([key]) => key !== '$kind')
      .map(([key, value]) => ({ op: 'add', path: `/${key}`, value }));
    for (const optional of ['body', 'auth']) {
      if (!(optional in desired) && optional in existing) {
        ops.push({ op: 'remove', path: `/${optional}` });
      }
    }
    await this.gateway.request({
      service: 'collection',
      method: 'patch',
      path: `/v3/collections/${cid}/items/${itemId}`,
      headers: { 'X-Entity-Type': 'http-request' },
      body: ops,
      // Fixed-path request updates are idempotent. Missing optional removals
      // after an ambiguous accepted patch are reconciled below.
      maxRetries: 3
    }).catch((error: unknown) => {
      if (isMissingPatchValueError(error) && ops.some((op) => op.op === 'remove')) return;
      throw error;
    });
    await this.patchItemScripts(cid, itemId, v2EventsToV3Scripts(leaf.event));
  }

  private async findChildByName(cid: string, parentId: string, name: string): Promise<JsonRecord | null> {
    const children = this.listChildItems(await this.listItems(cid), parentId, cid);
    const matches = children.filter((item) => String(item.name ?? '') === name);
    if (matches.length > 1) {
      throw new Error(
        `updateCollection: duplicate item name "${name}" under parent ${parentId} after create; refusing to adopt`
      );
    }
    return matches[0] ?? null;
  }

  private async createFolderItem(cid: string, folder: JsonRecord, parent: ParentRef): Promise<string> {
    const name = typeof folder.name === 'string' ? folder.name : '';
    const createBody: JsonRecord = {
      $kind: 'collection',
      name,
      position: { parent }
    };
    try {
      const created = await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'post',
        path: `/v3/collections/${cid}/items/`,
        headers: { 'X-Entity-Type': 'folder' },
        body: createBody,
        maxRetries: 0
      });
      const data = asRecord(created?.data);
      const folderId = String(data?.id ?? data?.uid ?? '').trim();
      if (!folderId) {
        throw new Error(
          `updateCollection: gateway did not return an id for folder ${name.trim() || '<unnamed>'}`
        );
      }
      return folderId;
    } catch (error) {
      if (!isAmbiguousCreateError(error)) {
        throw error;
      }
      const adopted = await this.findChildByName(cid, parent.id, name);
      const folderId = String(adopted?.id ?? adopted?.uid ?? '').trim();
      if (!folderId) {
        throw error;
      }
      return folderId;
    }
  }

  private async createRequestItem(
    cid: string,
    leaf: JsonRecord,
    request: JsonRecord,
    parent: ParentRef
  ): Promise<void> {
    // The v3 IR item carries url/method/headers/body/auth at the ROOT (sibling
    // fields), NOT under a `payload` wrapper — a payload wrapper is silently
    // dropped (live-proven). Body/auth use the v3 IR shapes ({type,content} /
    // {type,credentials}); headers are {key,value} pairs.
    const name = typeof leaf.name === 'string' ? leaf.name : '';
    const createBody = this.requestCreateBody(leaf, request, parent);

    let newItemId: string;
    try {
      const created = await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'post',
        path: `/v3/collections/${cid}/items/`,
        headers: { 'X-Entity-Type': 'http-request' },
        body: createBody,
        maxRetries: 0
      });
      const data = asRecord(created?.data);
      newItemId = String(data?.id ?? data?.uid ?? '').trim();
    } catch (error) {
      if (!isAmbiguousCreateError(error)) {
        throw error;
      }
      const adopted = await this.findChildByName(cid, parent.id, name);
      newItemId = String(adopted?.id ?? adopted?.uid ?? '').trim();
      if (!newItemId) {
        throw error;
      }
    }

    const scripts = v2EventsToV3Scripts(leaf.event);
    if (newItemId && scripts.length > 0) {
      await this.patchItemScripts(cid, newItemId, scripts);
    }
  }

  /**
   * PATCH a freshly-created item's `/scripts`, tolerating the two transient
   * failures this immediate-after-create write is prone to on the shared gateway:
   *   - `404 RESOURCE_NOT_FOUND` — the create write returns the assigned id, but
   *     an immediate PATCH can hit a replica that has not yet observed the create
   *     (read-after-write lag, live-observed on org-mode teams).
   *   - a downstream `5xx` (e.g. `500 ESOCKETTIMEDOUT`) — a Bifrost/gateway read
   *     timeout, not a durable rejection.
   * `op:add /scripts` is idempotent (overwrites), so retrying either is safe.
   * This is a deeper, longer-backoff budget than the gateway client's inner
   * transient retry, to wait out a longer platform hiccup on this fragile write.
   * Non-transient errors (e.g. 4xx schema rejections) surface immediately.
   */
  private async patchItemScripts(cid: string, itemId: string, scripts: JsonRecord[]): Promise<void> {
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await this.gateway.request({
          service: 'collection',
          method: 'patch',
          path: `/v3/collections/${cid}/items/${itemId}`,
          headers: { 'X-Entity-Type': 'http-request' },
          body: [{ op: 'add', path: '/scripts', value: scripts }],
          maxRetries: 0
        });
        return;
      } catch (error) {
        const retriable = error instanceof HttpError && (error.status === 404 || error.status >= 500);
        if (!retriable || attempt === maxAttempts - 1) {
          throw error;
        }
        await this.sleepImpl(Math.min(2000, 300 * 2 ** attempt));
      }
    }
  }

  async deleteCollection(collectionUid: string): Promise<void> {
    if (this.runIdentity || this.ownedTemporaryCollectionIds.size > 0) {
      if (!this.isOwnedTemporaryCollection(collectionUid)) {
        throw new Error(
          `refusing to delete collection ${collectionUid}: not positively owned by this run`
        );
      }
    }

    const cid = bareModelId(collectionUid);
    try {
      await this.gateway.request({
        service: 'collection',
        method: 'delete',
        path: `/v3/collections/${cid}`,
        maxRetries: 0
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return;
      }
      if (!isAmbiguousMutationError(error)) throw error;
      try {
        await this.gateway.request({
          service: 'collection',
          method: 'get',
          path: `/v3/collections/${cid}/export`
        });
      } catch (readError) {
        if (readError instanceof HttpError && readError.status === 404) return;
        throw readError;
      }
      throw error;
    }
  }
}
