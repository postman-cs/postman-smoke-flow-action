import type {
  FlowBinding,
  FlowDefinition,
  FlowStep,
  ResolvedRequest,
  SmokeApiKeyConfig,
  SmokeApiKeySettings,
  SmokeAuthConfig,
  SmokeAuthPlan,
  SmokeAuthProfile,
  SmokeOAuthConfig,
  SmokeOAuthSettings
} from '../types.js';
import { resolveOperationRequestTargets } from '../flow/resolver.js';
import {
  createSecretsResolverItem,
  isSecretsResolverEnabled,
  SECRETS_RESOLVER_ITEM_NAME,
  type SecretsResolverProvider
} from '@postman-cse/automation-core';

import {
  createOAuthPreRequestEvent,
  createPreRequestEvent,
  createTestEvent,
  countAssertionsForStep
} from './scripts.js';

type JsonRecord = Record<string, unknown>;
export type CollectionVerification = {
  ok: boolean;
  summary: string;
};

export type GeneratedSmokeCollectionBuildOptions = {
  secretsResolverProvider?: SecretsResolverProvider;
  collectionName?: string;
  scriptSourceCollection?: JsonRecord;
  authPlan?: SmokeAuthPlan;
  specPath?: string;
  /**
   * The canonical Smoke collection currently in Postman. Bootstrap elects and
   * adopts that final by exact `info.name`; a refresh that renames it via the
   * `/name` PATCH breaks election and triggers a fresh import/orphan cascade.
   * Carry `info.name` forward from the canonical target, not the generated
   * source. `info.description` is carried forward defensively only — this
   * client's v3 export does not surface it and its root PATCH does not write
   * it, so any bootstrap marker there is preserved simply by never being touched.
   */
  canonicalCollection?: JsonRecord;
};

const GENERATED_OAUTH_EVENT_MARKER = '[Smoke Flow] Auto-generated OAuth2 client-credentials token cache';
const LEGACY_SECRETS_RESOLVER_ITEM_NAME = SECRETS_RESOLVER_ITEM_NAME;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function sanitizeForCollectionUpdate(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeForCollectionUpdate);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = { ...(value as JsonRecord) };
  delete record.id;
  delete record.uid;
  delete record._postman_id;
  delete record.response;

  if (record.request && typeof record.request === 'object' && record.request !== null) {
    const request = { ...(record.request as JsonRecord) };
    delete request.id;
    delete request.uid;
    delete request._postman_id;
    record.request = request;
  }

  for (const [key, child] of Object.entries(record)) {
    record[key] = sanitizeForCollectionUpdate(child);
  }
  return record;
}

function setNestedValue(root: JsonRecord, dottedKey: string, value: unknown): void {
  const segments = dottedKey.split('.');
  let cursor: JsonRecord = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const next = asRecord(cursor[segment]);
    if (next) {
      cursor = next;
      continue;
    }
    cursor[segment] = {};
    cursor = cursor[segment] as JsonRecord;
  }
  cursor[segments[segments.length - 1]!] = value;
}

function getVariableBindings(step: FlowStep) {
  return step.bindings.filter((binding) => binding.source !== 'example');
}

function getBindingByFieldKey(step: FlowStep): Map<string, FlowBinding> {
  return new Map(step.bindings.map((binding) => [binding.fieldKey, binding]));
}

function decodeQueryKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    return key;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function updateRawUrlQuery(rawUrl: string, step: FlowStep): string {
  const bindingByFieldKey = getBindingByFieldKey(step);
  const [withoutHash, hash = ''] = rawUrl.split('#', 2);
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex === -1) {
    return rawUrl;
  }

  const base = withoutHash.slice(0, queryIndex);
  const queryString = withoutHash.slice(queryIndex + 1);
  const nextQuery = queryString
    .split('&')
    .filter(Boolean)
    .flatMap((entry) => {
      const rawKey = entry.split('=', 1)[0] ?? '';
      const binding = bindingByFieldKey.get(decodeQueryKey(rawKey));
      if (!binding) {
        return [];
      }

      if (binding.source === 'example') {
        return [entry];
      }

      return [`${rawKey}={{${binding.fieldKey}}}`];
    })
    .join('&');

  const nextWithoutHash = nextQuery ? `${base}?${nextQuery}` : base;
  return hash ? `${nextWithoutHash}#${hash}` : nextWithoutHash;
}

function updateRequestUrl(request: JsonRecord, step: FlowStep): void {
  const variableBindings = getVariableBindings(step);
  const bindingByFieldKey = getBindingByFieldKey(step);
  const url = request.url;
  if (typeof url === 'string') {
    let next = url;
    for (const binding of variableBindings) {
      next = next.replace(new RegExp(`\\{${binding.fieldKey}\\}`, 'g'), `{{${binding.fieldKey}}}`);
      next = next.replace(new RegExp(`:${binding.fieldKey}(?=[/?&#]|$)`, 'g'), `{{${binding.fieldKey}}}`);
    }
    request.url = updateRawUrlQuery(next, step);
    return;
  }

  const urlRecord = asRecord(url);
  if (!urlRecord) {
    return;
  }

  if (typeof urlRecord.raw === 'string') {
    let nextRaw = urlRecord.raw;
    for (const binding of variableBindings) {
      nextRaw = nextRaw.replace(new RegExp(`\\{${binding.fieldKey}\\}`, 'g'), `{{${binding.fieldKey}}}`);
      nextRaw = nextRaw.replace(new RegExp(`:${binding.fieldKey}(?=[/?&#]|$)`, 'g'), `{{${binding.fieldKey}}}`);
    }
    urlRecord.raw = updateRawUrlQuery(nextRaw, step);
  }

  if (Array.isArray(urlRecord.variable)) {
    urlRecord.variable = urlRecord.variable.map((entry) => {
      const variable = asRecord(entry) ?? {};
      const key = typeof variable.key === 'string' ? variable.key : '';
      if (variableBindings.some((binding) => binding.fieldKey === key)) {
        variable.value = `{{${key}}}`;
      }
      return variable;
    });
  }

  if (Array.isArray(urlRecord.query)) {
    urlRecord.query = urlRecord.query.flatMap((entry) => {
      const query = asRecord(entry) ?? {};
      const key = typeof query.key === 'string' ? query.key : '';
      const binding = bindingByFieldKey.get(key);
      if (!binding) {
        return [];
      }
      if (binding.source !== 'example') {
        query.value = `{{${key}}}`;
      }
      return [query];
    });
  }
}

function updateRequestBody(request: JsonRecord, step: FlowStep): void {
  const variableBindings = getVariableBindings(step);
  const body = asRecord(request.body);
  if (!body || body.mode !== 'raw' || typeof body.raw !== 'string') {
    return;
  }
  let raw = body.raw;

  try {
    const json = JSON.parse(raw) as JsonRecord;
    for (const binding of variableBindings) {
      setNestedValue(json, binding.fieldKey, `{{${binding.fieldKey}}}`);
    }
    raw = JSON.stringify(json, null, 2);
  } catch {
    for (const binding of variableBindings) {
      const fieldPattern = escapeRegExp(binding.fieldKey);
      raw = raw.replace(new RegExp(`"${fieldPattern}"\\s*:\\s*"[^"]*"`, 'g'), `"${binding.fieldKey}": "{{${binding.fieldKey}}}"`);
    }
  }
  body.raw = raw;
}

function applyFlowScripts(item: JsonRecord, step: FlowStep): void {
  const existingEvents = Array.isArray(item.event) ? item.event : [];
  item.event = existingEvents
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .filter((entry) => entry.listen !== 'prerequest' && entry.listen !== 'test');
  (item.event as JsonRecord[]).push(createPreRequestEvent(step), createTestEvent(step));
}

function removeHeader(request: JsonRecord, key: string): void {
  const headers = Array.isArray(request.header)
    ? request.header
        .map((entry) => asRecord(entry))
        .filter((entry): entry is JsonRecord => Boolean(entry))
    : [];

  request.header = headers.filter((entry) => typeof entry.key !== 'string' || entry.key.toLowerCase() !== key.toLowerCase());
}

function removeRawUrlQueryParam(rawUrl: string, key: string): string {
  const [withoutHash, hash = ''] = rawUrl.split('#', 2);
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex === -1) {
    return rawUrl;
  }

  const base = withoutHash.slice(0, queryIndex);
  const queryString = withoutHash.slice(queryIndex + 1);
  const nextQuery = queryString
    .split('&')
    .filter(Boolean)
    .filter((entry) => decodeQueryKey(entry.split('=', 1)[0] ?? '').toLowerCase() !== key.toLowerCase())
    .join('&');
  const nextWithoutHash = nextQuery ? `${base}?${nextQuery}` : base;
  return hash ? `${nextWithoutHash}#${hash}` : nextWithoutHash;
}

function removeQueryParam(request: JsonRecord, key: string): void {
  const url = request.url;
  if (typeof url === 'string') {
    request.url = removeRawUrlQueryParam(url, key);
    return;
  }

  const urlRecord = asRecord(url);
  if (!urlRecord) {
    return;
  }

  if (typeof urlRecord.raw === 'string') {
    urlRecord.raw = removeRawUrlQueryParam(urlRecord.raw, key);
  }
  if (Array.isArray(urlRecord.query)) {
    urlRecord.query = urlRecord.query.filter((entry) => {
      const query = asRecord(entry);
      return !query || typeof query.key !== 'string' || query.key.toLowerCase() !== key.toLowerCase();
    });
  }
}

function getOAuthVariableNames(authConfig: SmokeOAuthSettings): Required<NonNullable<SmokeOAuthSettings['variables']>> {
  return {
    tokenUrl: authConfig.variables?.tokenUrl || 'auth_token_url',
    scope: authConfig.variables?.scope || 'auth_scope',
    clientId: authConfig.variables?.clientId || 'auth_client_id',
    clientSecret: authConfig.variables?.clientSecret || 'auth_client_secret',
    accessToken: authConfig.variables?.accessToken || 'access_token',
    expiresAt: authConfig.variables?.expiresAt || 'access_token_expires_at'
  };
}

function isOAuthAuthConfig(authConfig: SmokeAuthConfig): authConfig is SmokeOAuthConfig {
  return authConfig.type === 'oauth2';
}

function getApiKeyVariableName(authConfig: SmokeApiKeySettings): string {
  return authConfig.variables?.apiKey?.trim() || 'api_key';
}

function getApiKeyName(authConfig: SmokeApiKeySettings): string {
  return authConfig.name.trim();
}

function createApiKeyAuth(authConfig: SmokeApiKeySettings): JsonRecord {
  return {
    type: 'apikey',
    apikey: [
      {
        key: 'key',
        value: getApiKeyName(authConfig),
        type: 'string'
      },
      {
        key: 'value',
        value: `{{${getApiKeyVariableName(authConfig)}}}`,
        type: 'string'
      },
      {
        key: 'in',
        value: authConfig.in,
        type: 'string'
      }
    ]
  };
}

function setRequestBearerAuth(request: JsonRecord, authConfig: SmokeOAuthSettings): void {
  const variables = getOAuthVariableNames(authConfig);
  request.auth = {
    type: 'bearer',
    bearer: [
      {
        key: 'token',
        value: `{{${variables.accessToken}}}`,
        type: 'string'
      }
    ]
  };
  removeHeader(request, authConfig.apply?.header || 'Authorization');
}

function prepareRequestForCollectionApiKeyAuth(request: JsonRecord, authConfig: SmokeApiKeySettings): void {
  const apiKeyName = getApiKeyName(authConfig);
  delete request.auth;
  if (authConfig.in === 'header') {
    removeHeader(request, apiKeyName);
  } else {
    removeQueryParam(request, apiKeyName);
  }
}

function applyAuthToRequest(request: JsonRecord, authConfig: SmokeAuthConfig | undefined): boolean {
  if (!authConfig?.enabled) {
    return false;
  }

  if (isOAuthAuthConfig(authConfig)) {
    setRequestBearerAuth(request, authConfig);
  } else {
    prepareRequestForCollectionApiKeyAuth(request, authConfig);
  }
  return true;
}

function upsertCollectionVariable(collection: JsonRecord, key: string, value = ''): void {
  const variables = Array.isArray(collection.variable)
    ? collection.variable
        .map((entry) => asRecord(entry))
        .filter((entry): entry is JsonRecord => Boolean(entry))
    : [];
  const existing = variables.find((entry) => entry.key === key);
  if (existing) {
    if (typeof existing.value !== 'string') {
      existing.value = value;
    }
  } else {
    variables.push({ key, value, type: 'string' });
  }
  collection.variable = variables;
}

function seedOAuthCollectionVariables(collection: JsonRecord, authConfig: SmokeOAuthConfig): void {
  const variables = getOAuthVariableNames(authConfig);
  const tokenUrlValue = authConfig.tokenUrl.includes('{{') ? '' : authConfig.tokenUrl;
  upsertCollectionVariable(collection, variables.tokenUrl, tokenUrlValue);
  upsertCollectionVariable(collection, variables.scope);
  upsertCollectionVariable(collection, variables.clientId);
  upsertCollectionVariable(collection, variables.clientSecret);
  upsertCollectionVariable(collection, variables.accessToken);
  upsertCollectionVariable(collection, variables.expiresAt);
}

function seedApiKeyCollectionVariables(collection: JsonRecord, authConfig: SmokeApiKeyConfig): void {
  upsertCollectionVariable(collection, getApiKeyVariableName(authConfig));
}

function getTemplateVariableNames(template: string | undefined): string[] {
  if (!template) {
    return [];
  }
  return [...template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
}

function seedAuthPlanVariables(collection: JsonRecord, authPlan: SmokeAuthPlan): void {
  for (const profile of Object.values(authPlan.profiles)) {
    if (profile.type === 'oauth2') {
      const variables = profile.variables;
      for (const variableName of [
        variables.clientId,
        variables.clientSecret,
        variables.accessToken,
        variables.expiresAt,
        ...getTemplateVariableNames(profile.tokenUrl),
        ...getTemplateVariableNames(profile.scope)
      ]) {
        upsertCollectionVariable(collection, variableName);
      }
      continue;
    }
    if (profile.type === 'apiKey') {
      upsertCollectionVariable(collection, profile.variables.apiKey);
    }
  }
}

function getScriptExecText(event: JsonRecord): string {
  const script = asRecord(event.script);
  const exec = script?.exec;
  if (Array.isArray(exec)) {
    return exec.map((line) => String(line)).join('\n');
  }
  if (typeof exec === 'string') {
    return exec;
  }
  return '';
}

function isGeneratedOAuthEvent(event: JsonRecord): boolean {
  return event.listen === 'prerequest' && getScriptExecText(event).includes(GENERATED_OAUTH_EVENT_MARKER);
}

function setRequestEvents(item: JsonRecord, events: JsonRecord[]): void {
  if (events.length > 0) {
    item.event = events;
  } else {
    delete item.event;
  }
}

function removeGeneratedOAuthEventsFromItem(item: JsonRecord): JsonRecord[] {
  const events = Array.isArray(item.event) ? item.event : [];
  return events
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .filter((entry) => !isGeneratedOAuthEvent(entry));
}

function applyAuthProfileToItem(item: JsonRecord, profile: SmokeAuthProfile): void {
  const request = asRecord(item.request);
  if (!request) {
    return;
  }

  const retainedEvents = removeGeneratedOAuthEventsFromItem(item);
  if (profile.type === 'oauth2') {
    setRequestBearerAuth(request, profile);
    setRequestEvents(item, [
      ...retainedEvents,
      createOAuthPreRequestEvent(profile, { scopeTemplate: profile.scope })
    ]);
    return;
  }
  if (profile.type === 'apiKey') {
    request.auth = createApiKeyAuth(profile);
    if (profile.in === 'header') {
      removeHeader(request, profile.name);
    } else {
      removeQueryParam(request, profile.name);
    }
    setRequestEvents(item, retainedEvents);
    return;
  }

  request.auth = { type: 'noauth' };
  removeHeader(request, 'Authorization');
  setRequestEvents(item, retainedEvents);
}

function prepareCollectionForAuthPlan(collection: JsonRecord, authPlan: SmokeAuthPlan): void {
  collection.auth = { type: 'noauth' };
  const existingEvents = Array.isArray(collection.event) ? collection.event : [];
  const retainedEvents = existingEvents
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .filter((entry) => !isGeneratedOAuthEvent(entry));
  if (retainedEvents.length > 0) {
    collection.event = retainedEvents;
  } else {
    delete collection.event;
  }
  seedAuthPlanVariables(collection, authPlan);
}

function applyCollectionAuth(collection: JsonRecord, authConfig: SmokeAuthConfig | undefined): void {
  if (!authConfig?.enabled) {
    return;
  }

  const existingEvents = Array.isArray(collection.event) ? collection.event : [];
  const retainedEvents = existingEvents
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .filter((entry) => !isGeneratedOAuthEvent(entry));

  if (isOAuthAuthConfig(authConfig)) {
    collection.auth = { type: 'noauth' };
    seedOAuthCollectionVariables(collection, authConfig);
    collection.event = [...retainedEvents, createOAuthPreRequestEvent(authConfig)];
    return;
  }

  collection.auth = createApiKeyAuth(authConfig);
  seedApiKeyCollectionVariables(collection, authConfig);
  if (retainedEvents.length > 0) {
    collection.event = retainedEvents;
  } else {
    delete collection.event;
  }
}

function applyAuthToCollectionItems(items: unknown, authConfig: SmokeAuthConfig): number {
  if (!Array.isArray(items)) {
    return 0;
  }

  return items.reduce((count, entry) => {
    const item = asRecord(entry);
    if (!item) {
      return count;
    }

    let nextCount = count;
    const request = asRecord(item.request);
    // The resolver item keeps its AWSv4 auth: matching by isSecretsResolverItem
    // covers name aliases and the awsv4/secretsmanager heuristic, so target-API
    // credentials are never applied to (or leak toward) the AWS endpoint.
    if (request && !isSecretsResolverItem(item) && applyAuthToRequest(request, authConfig)) {
      nextCount += 1;
    }

    return nextCount + applyAuthToCollectionItems(item.item, authConfig);
  }, 0);
}

function getRequestUrlText(request: JsonRecord): string {
  const url = request.url;
  if (typeof url === 'string') {
    return url;
  }
  const urlRecord = asRecord(url);
  if (!urlRecord) {
    return '';
  }
  if (typeof urlRecord.raw === 'string') {
    return urlRecord.raw;
  }
  const host = Array.isArray(urlRecord.host) ? urlRecord.host.map(String).join('.') : '';
  const path = Array.isArray(urlRecord.path) ? urlRecord.path.map(String).join('/') : '';
  return [host, path].filter(Boolean).join('/');
}

function normalizeMatchText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function getRequestMethod(request: JsonRecord): string {
  return normalizeMatchText(request.method || 'GET');
}

function getRequestUrlMatchKey(item: JsonRecord): string {
  const request = asRecord(item.request);
  if (!request) {
    return '';
  }
  const url = normalizeMatchText(getRequestUrlText(request));
  return url ? `${getRequestMethod(request)} ${url}` : '';
}

function getRequestNameMatchKey(item: JsonRecord): string {
  const request = asRecord(item.request);
  if (!request) {
    return '';
  }
  const name = normalizeMatchText(item.name);
  return name ? `${getRequestMethod(request)} ${name}` : '';
}

function getRequestEvents(item: JsonRecord): JsonRecord[] {
  return Array.isArray(item.event)
    ? item.event.map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => Boolean(entry))
    : [];
}

function indexUniqueRequestEvents(items: JsonRecord[], getKey: (item: JsonRecord) => string): Map<string, JsonRecord[]> {
  const matches = new Map<string, JsonRecord[][]>();
  for (const item of items) {
    const events = getRequestEvents(item);
    if (events.length === 0) {
      continue;
    }
    const key = getKey(item);
    if (!key) {
      continue;
    }
    const existing = matches.get(key) ?? [];
    existing.push(events);
    matches.set(key, existing);
  }

  const unique = new Map<string, JsonRecord[]>();
  for (const [key, eventSets] of matches) {
    if (eventSets.length === 1) {
      unique.set(key, eventSets[0]!);
    }
  }
  return unique;
}

function mergeRequestEvents(targetEvents: JsonRecord[], sourceEvents: JsonRecord[]): JsonRecord[] {
  const merged = [...targetEvents];
  const seen = new Set(targetEvents.map((event) => `${String(event.listen ?? '')}\n${getScriptExecText(event)}`));
  for (const event of sourceEvents) {
    const key = `${String(event.listen ?? '')}\n${getScriptExecText(event)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(structuredClone(event) as JsonRecord);
  }
  return merged;
}

function preserveRequestEventsFromCollection(collection: JsonRecord, scriptSourceCollection: JsonRecord | undefined): void {
  if (!scriptSourceCollection) {
    return;
  }

  const sourceItems = collectSmokeRequestItems(scriptSourceCollection.item);
  const eventsByUrl = indexUniqueRequestEvents(sourceItems, getRequestUrlMatchKey);
  const eventsByName = indexUniqueRequestEvents(sourceItems, getRequestNameMatchKey);
  for (const item of collectSmokeRequestItems(collection.item)) {
    const sourceEvents = eventsByUrl.get(getRequestUrlMatchKey(item)) ?? eventsByName.get(getRequestNameMatchKey(item));
    if (!sourceEvents || sourceEvents.length === 0) {
      continue;
    }
    const mergedEvents = mergeRequestEvents(getRequestEvents(item), sourceEvents);
    if (mergedEvents.length > 0) {
      item.event = mergedEvents;
    }
  }
}

/**
 * Carry the canonical Smoke collection's identity fields onto a rebuilt body.
 *
 * Bootstrap elects the canonical Smoke final by exact `info.name`; this package
 * previously broke election by PATCHing `/name` to the flow-derived title.
 * `info.name` is therefore the operative field and must survive the rebuild.
 * `info.description` is carried forward defensively only — the v3 export path
 * does not surface it and the root PATCH does not write it, so the marker is
 * preserved simply by never being touched. Absent canonical fields stay absent.
 */
function applyCanonicalCollectionIdentity(
  collection: JsonRecord,
  canonicalCollection: JsonRecord | undefined
): void {
  if (!canonicalCollection) {
    return;
  }
  const canonicalInfo = asRecord(canonicalCollection.info);
  if (!canonicalInfo) {
    return;
  }

  const info = asRecord(collection.info) ?? {};
  const canonicalName = typeof canonicalInfo.name === 'string' ? canonicalInfo.name.trim() : '';
  if (canonicalName) {
    info.name = canonicalName;
  }
  const canonicalDescription = canonicalInfo.description;
  if (typeof canonicalDescription === 'string' || asRecord(canonicalDescription)) {
    info.description = canonicalDescription;
  } else {
    delete info.description;
  }
  collection.info = info;
}

/**
 * The shared factory omits `script.type`, which the pre-provider AWS helper
 * always carried. Stamp it back on so the injected item keeps the historical
 * wire shape and matches every other script this action emits.
 */
function buildSecretsResolverItem(provider: SecretsResolverProvider): JsonRecord {
  const item = createSecretsResolverItem(provider) as JsonRecord;
  const events = Array.isArray(item.event) ? item.event : [];
  for (const entry of events) {
    const event = asRecord(entry);
    const script = asRecord(event?.script);
    if (script && typeof script.type !== 'string') {
      script.type = 'text/javascript';
    }
  }
  return item;
}

function isSecretsResolverItem(item: JsonRecord): boolean {
  const name = typeof item.name === 'string' ? item.name.trim().toLowerCase() : '';
  if (name === LEGACY_SECRETS_RESOLVER_ITEM_NAME.toLowerCase() || name === 'resolve secrets') {
    return true;
  }

  const request = asRecord(item.request);
  if (!request) {
    return false;
  }
  const auth = asRecord(request.auth);
  const authType = typeof auth?.type === 'string' ? auth.type.toLowerCase() : '';
  const urlText = getRequestUrlText(request).toLowerCase();
  const headers = Array.isArray(request.header)
    ? request.header.map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => Boolean(entry))
    : [];
  const hasSecretsManagerTarget = headers.some(
    (entry) =>
      typeof entry.key === 'string' &&
      entry.key.toLowerCase() === 'x-amz-target' &&
      String(entry.value ?? '').toLowerCase().includes('secretsmanager.getsecretvalue')
  );

  const isAwsShape = authType === 'awsv4' && (urlText.includes('secretsmanager') || hasSecretsManagerTarget);
  // Bearer-token providers: match the vault/secret-manager endpoints so a
  // renamed helper is still detected instead of being treated as an API
  // operation (duplicated on rebuild, stripped-check missed, auth overwritten).
  const isAzureShape = authType === 'bearer' && urlText.includes('vault.azure.net');
  const isGcpShape =
    authType === 'bearer' && urlText.includes('secretmanager.googleapis.com') && urlText.includes(':access');

  return isAwsShape || isAzureShape || isGcpShape;
}

function removeSecretsResolverItems(items: unknown): unknown {
  if (!Array.isArray(items)) {
    return items;
  }

  return items
    .map((entry) => {
      const item = asRecord(entry);
      if (!item) {
        return entry;
      }
      if (Array.isArray(item.item)) {
        item.item = removeSecretsResolverItems(item.item);
      }
      return item;
    })
    .filter((entry) => {
      const item = asRecord(entry);
      return !item || !isSecretsResolverItem(item);
    });
}

function containsSecretsResolverItem(items: unknown): boolean {
  if (!Array.isArray(items)) {
    return false;
  }

  return items.some((entry) => {
    const item = asRecord(entry);
    if (!item) {
      return false;
    }
    return isSecretsResolverItem(item) || containsSecretsResolverItem(item.item);
  });
}

function collectSmokeRequestItems(items: unknown): JsonRecord[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.flatMap((entry) => {
    const item = asRecord(entry);
    if (!item) {
      return [];
    }

    const nestedItems = collectSmokeRequestItems(item.item);
    const request = asRecord(item.request);
    if (!request || isSecretsResolverItem(item)) {
      return nestedItems;
    }

    return [item, ...nestedItems];
  });
}

function getAuthPlanTargetMap(authPlan: SmokeAuthPlan): Map<string, string> {
  return new Map(authPlan.targets.map((target) => [target.operationId, target.profile]));
}

function applyAuthPlanToGeneratedCollection(
  collection: JsonRecord,
  authPlan: SmokeAuthPlan,
  specPath?: string
): number {
  prepareCollectionForAuthPlan(collection, authPlan);
  const targets = resolveOperationRequestTargets(
    authPlan.targets.map((target) => target.operationId),
    collection,
    specPath
  );
  const assignedItems = new Set<JsonRecord>();

  for (const target of authPlan.targets) {
    const item = targets.get(target.operationId);
    if (!item) {
      continue;
    }
    if (assignedItems.has(item)) {
      throw new Error(
        `Auth plan operationId "${target.operationId}" resolves to a request that is already assigned to another profile.`
      );
    }
    applyAuthProfileToItem(item, authPlan.profiles[target.profile]!);
    assignedItems.add(item);
  }

  const missingItems = collectSmokeRequestItems(collection.item).filter((item) => !assignedItems.has(item));
  if (missingItems.length > 0) {
    const names = missingItems.slice(0, 5).map((item) => String(item.name ?? '<unnamed request>'));
    const suffix = missingItems.length > 5 ? `, and ${missingItems.length - 5} more` : '';
    throw new Error(
      `Auth plan does not assign a profile to ${missingItems.length} active Smoke request(s): ${names.join(', ')}${suffix}. Add an operationId target for every request, using noauth when authentication is intentionally absent.`
    );
  }

  return assignedItems.size;
}

function resolveCuratedAuthProfile(
  authPlan: SmokeAuthPlan,
  operationId: string
): SmokeAuthProfile {
  const profileName = getAuthPlanTargetMap(authPlan).get(operationId);
  if (!profileName) {
    throw new Error(
      `Auth plan does not assign a profile to active Smoke operationId "${operationId}".`
    );
  }
  return authPlan.profiles[profileName]!;
}

function hasGeneratedOAuthEvent(collection: JsonRecord): boolean {
  const events = Array.isArray(collection.event) ? collection.event : [];
  return events
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .some((entry) => isGeneratedOAuthEvent(entry));
}

function hasCollectionAuth(collection: JsonRecord): boolean {
  const auth = asRecord(collection.auth);
  return Boolean(auth && typeof auth.type === 'string' && auth.type !== '' && auth.type !== 'noauth');
}

function getCollectionVariableKeys(collection: JsonRecord): Set<string> {
  const variables = Array.isArray(collection.variable) ? collection.variable : [];
  return new Set(
    variables
      .map((entry) => asRecord(entry))
      .filter((entry): entry is JsonRecord => Boolean(entry))
      .map((entry) => String(entry.key ?? ''))
      .filter(Boolean)
  );
}

function requestUsesBearerAuth(request: JsonRecord, accessTokenVariable: string): boolean {
  const auth = asRecord(request.auth);
  if (!auth || auth.type !== 'bearer') {
    return false;
  }
  const bearer = Array.isArray(auth.bearer) ? auth.bearer : [];
  return bearer
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .some((entry) => entry.key === 'token' && entry.value === `{{${accessTokenVariable}}}`);
}

function countBearerAuthRequests(items: unknown, authConfig: SmokeOAuthConfig): number {
  if (!Array.isArray(items)) {
    return 0;
  }

  const variables = getOAuthVariableNames(authConfig);
  return items.reduce((count, entry) => {
    const item = asRecord(entry);
    if (!item) {
      return count;
    }

    let nextCount = count;
    const request = asRecord(item.request);
    if (request && !isSecretsResolverItem(item) && requestUsesBearerAuth(request, variables.accessToken)) {
      nextCount += 1;
    }
    return nextCount + countBearerAuthRequests(item.item, authConfig);
  }, 0);
}

function authUsesApiKey(auth: JsonRecord | null, authConfig: SmokeApiKeySettings): boolean {
  if (!auth || auth.type !== 'apikey') {
    return false;
  }
  const apiKey = Array.isArray(auth.apikey) ? auth.apikey : [];
  const entries = apiKey.map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => Boolean(entry));
  const valueVariable = getApiKeyVariableName(authConfig);
  const credentialByKey = new Map(entries.map((entry) => [String(entry.key ?? ''), entry.value]));
  return (
    credentialByKey.get('key') === getApiKeyName(authConfig) &&
    credentialByKey.get('value') === `{{${valueVariable}}}` &&
    String(credentialByKey.get('in') ?? '').toLowerCase() === authConfig.in
  );
}

function collectionUsesApiKeyAuth(collection: JsonRecord, authConfig: SmokeApiKeyConfig): boolean {
  return authUsesApiKey(asRecord(collection.auth), authConfig);
}

function collectRequestsWithExplicitAuth(items: unknown): string[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.flatMap((entry) => {
    const item = asRecord(entry);
    if (!item) {
      return [];
    }

    const nested = collectRequestsWithExplicitAuth(item.item);
    const request = asRecord(item.request);
    const auth = asRecord(request?.auth);
    if (!request || isSecretsResolverItem(item) || !auth || auth.type === 'noauth') {
      return nested;
    }

    return [String(item.name ?? '<unnamed request>'), ...nested];
  });
}

function getTopLevelItems(collection: JsonRecord): JsonRecord[] {
  return Array.isArray(collection.item)
    ? collection.item
        .map((entry) => asRecord(entry))
        .filter((entry): entry is JsonRecord => Boolean(entry))
    : [];
}

function hasFlowRequestScripts(item: JsonRecord): boolean {
  const events = Array.isArray(item.event)
    ? item.event.map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => Boolean(entry))
    : [];
  return events.some((entry) => entry.listen === 'prerequest') && events.some((entry) => entry.listen === 'test');
}

function itemHasGeneratedOAuthEvent(item: JsonRecord): boolean {
  return getRequestEvents(item).some((event) => isGeneratedOAuthEvent(event));
}

function isPersistedNoAuth(auth: JsonRecord | null): boolean {
  // The Postman v3 collection API persists noauth by omitting the auth block.
  return auth === null || auth.type === 'noauth';
}

function verifyAuthPlanAssignment(
  item: JsonRecord,
  profile: SmokeAuthProfile,
  variableKeys: Set<string>
): string[] {
  const request = asRecord(item.request);
  if (!request) {
    return ['request body is missing'];
  }
  const failures: string[] = [];

  if (profile.type === 'oauth2') {
    const requiredVariables = [
      profile.variables.clientId,
      profile.variables.clientSecret,
      profile.variables.accessToken,
      profile.variables.expiresAt,
      ...getTemplateVariableNames(profile.tokenUrl),
      ...getTemplateVariableNames(profile.scope)
    ];
    const missingVariables = requiredVariables.filter((name) => !variableKeys.has(name));
    if (!requestUsesBearerAuth(request, profile.variables.accessToken)) {
      failures.push(`missing bearer auth for {{${profile.variables.accessToken}}}`);
    }
    if (!itemHasGeneratedOAuthEvent(item)) {
      failures.push('missing request-level OAuth token script');
    }
    if (missingVariables.length > 0) {
      failures.push(`missing variable(s): ${missingVariables.join(', ')}`);
    }
    return failures;
  }

  if (profile.type === 'apiKey') {
    if (!authUsesApiKey(asRecord(request.auth), profile)) {
      failures.push(`missing request-level ${profile.in} API key auth`);
    }
    if (!variableKeys.has(profile.variables.apiKey)) {
      failures.push(`missing API key variable: ${profile.variables.apiKey}`);
    }
    if (itemHasGeneratedOAuthEvent(item)) {
      failures.push('unexpected OAuth token script');
    }
    return failures;
  }

  const auth = asRecord(request.auth);
  if (!isPersistedNoAuth(auth)) {
    failures.push('missing explicit noauth request setting');
  }
  if (itemHasGeneratedOAuthEvent(item)) {
    failures.push('unexpected OAuth token script');
  }
  return failures;
}

export function verifySmokeCollectionAuthPlan(
  collection: JsonRecord,
  authPlan: SmokeAuthPlan,
  options: { specPath?: string; flow?: FlowDefinition } = {}
): CollectionVerification {
  const failures: string[] = [];
  const variableKeys = getCollectionVariableKeys(collection);
  const collectionAuth = asRecord(collection.auth);
  if (!isPersistedNoAuth(collectionAuth)) {
    failures.push('collection-level auth must be noauth when an auth plan is active');
  }
  if (hasGeneratedOAuthEvent(collection)) {
    failures.push('OAuth token acquisition must be request-level when an auth plan is active');
  }

  const assignments: Array<{ item: JsonRecord; profile: SmokeAuthProfile; operationId: string }> = [];
  try {
    if (options.flow) {
      const itemsByName = new Map(
        getTopLevelItems(collection)
          .filter((item) => asRecord(item.request) && !isSecretsResolverItem(item))
          .map((item) => [String(item.name ?? ''), item])
      );
      const targetMap = getAuthPlanTargetMap(authPlan);
      for (const step of options.flow.steps) {
        const itemName = step.name?.trim() || step.operationId;
        const item = itemsByName.get(itemName);
        const profileName = targetMap.get(step.operationId);
        if (!item || !profileName) {
          failures.push(`active operationId "${step.operationId}" has no persisted auth profile`);
          continue;
        }
        assignments.push({ item, profile: authPlan.profiles[profileName]!, operationId: step.operationId });
      }
    } else {
      const resolved = resolveOperationRequestTargets(
        authPlan.targets.map((target) => target.operationId),
        collection,
        options.specPath
      );
      const assignedItems = new Set<JsonRecord>();
      for (const target of authPlan.targets) {
        const item = resolved.get(target.operationId);
        if (!item) {
          continue;
        }
        if (assignedItems.has(item)) {
          failures.push(`operationId "${target.operationId}" resolves to an already assigned request`);
          continue;
        }
        assignedItems.add(item);
        assignments.push({
          item,
          profile: authPlan.profiles[target.profile]!,
          operationId: target.operationId
        });
      }
      const missingItems = collectSmokeRequestItems(collection.item).filter((item) => !assignedItems.has(item));
      if (missingItems.length > 0) {
        failures.push(`${missingItems.length} active request(s) have no auth profile`);
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  for (const assignment of assignments) {
    const assignmentFailures = verifyAuthPlanAssignment(
      assignment.item,
      assignment.profile,
      variableKeys
    );
    failures.push(
      ...assignmentFailures.map(
        (failure) => `operationId "${assignment.operationId}": ${failure}`
      )
    );
  }

  return {
    ok: failures.length === 0,
    summary:
      failures.length > 0
        ? failures.join('; ')
        : `auth plan persisted on ${assignments.length} request(s)`
  };
}

export function verifySmokeCollectionAuth(
  collection: JsonRecord,
  authConfig: SmokeAuthConfig,
  options: { secretsResolverProvider?: SecretsResolverProvider } = {}
): CollectionVerification {
  const variableKeys = getCollectionVariableKeys(collection);
  const failures: string[] = [];

  if (isOAuthAuthConfig(authConfig)) {
    const variables = getOAuthVariableNames(authConfig);
    const missingVariables = Object.values(variables).filter((variableName) => !variableKeys.has(variableName));
    const bearerAuthRequestCount = countBearerAuthRequests(collection.item, authConfig);
    if (hasCollectionAuth(collection)) {
      failures.push('collection-level auth is still present while OAuth request auth is enabled');
    }
    if (!hasGeneratedOAuthEvent(collection)) {
      failures.push('missing generated OAuth pre-request script');
    }
    if (missingVariables.length > 0) {
      failures.push(`missing OAuth collection variable(s): ${missingVariables.join(', ')}`);
    }
    if (bearerAuthRequestCount === 0) {
      failures.push('no requests use generated bearer auth');
    }
    if (!isSecretsResolverEnabled(options.secretsResolverProvider ?? 'none') && containsSecretsResolverItem(collection.item)) {
      failures.push('secrets resolver request is still present');
    }

    return {
      ok: failures.length === 0,
      summary: failures.length > 0 ? failures.join('; ') : `OAuth persisted on ${bearerAuthRequestCount} request(s)`
    };
  }

  const apiKeyVariable = getApiKeyVariableName(authConfig);
  const inheritedRequestCount = collectSmokeRequestItems(collection.item).length;
  const requestsWithExplicitAuth = collectRequestsWithExplicitAuth(collection.item);
  if (!variableKeys.has(apiKeyVariable)) {
    failures.push(`missing API key collection variable: ${apiKeyVariable}`);
  }
  if (!collectionUsesApiKeyAuth(collection, authConfig)) {
    failures.push('missing collection-level API key auth');
  }
  if (inheritedRequestCount === 0) {
    failures.push('no requests inherit generated API key auth');
  }
  if (requestsWithExplicitAuth.length > 0) {
    const sample = requestsWithExplicitAuth.slice(0, 5).join(', ');
    const suffix = requestsWithExplicitAuth.length > 5 ? `, and ${requestsWithExplicitAuth.length - 5} more` : '';
    failures.push(`request(s) override collection-level API key auth: ${sample}${suffix}`);
  }
  if (!isSecretsResolverEnabled(options.secretsResolverProvider ?? 'none') && containsSecretsResolverItem(collection.item)) {
    failures.push('secrets resolver request is still present');
  }

  return {
    ok: failures.length === 0,
    summary: failures.length > 0 ? failures.join('; ') : `API key auth persisted at collection level for ${inheritedRequestCount} request(s)`
  };
}

export function verifyGeneratedSmokeCollection(
  collection: JsonRecord,
  authConfig: SmokeAuthConfig | undefined,
  options: {
    secretsResolverProvider?: SecretsResolverProvider;
    authPlan?: SmokeAuthPlan;
    specPath?: string;
  } = {}
): CollectionVerification {
  const requestItems = collectSmokeRequestItems(collection.item);
  const requestsMissingUrls = requestItems
    .filter((item) => {
      const request = asRecord(item.request);
      return !request || !getRequestUrlText(request).trim();
    })
    .map((item) => String(item.name ?? '<unnamed request>'));
  const failures: string[] = [];

  if (requestItems.length === 0) {
    failures.push('no Smoke requests found in generated collection');
  }
  if (requestsMissingUrls.length > 0) {
    const sample = requestsMissingUrls.slice(0, 5).join(', ');
    const suffix = requestsMissingUrls.length > 5 ? `, and ${requestsMissingUrls.length - 5} more` : '';
    failures.push(`generated Smoke request(s) missing URL: ${sample}${suffix}`);
  }
  if (!authConfig?.enabled && !isSecretsResolverEnabled(options.secretsResolverProvider ?? 'none') && containsSecretsResolverItem(collection.item)) {
    failures.push('secrets resolver request is still present');
  }
  if (isSecretsResolverEnabled(options.secretsResolverProvider ?? 'none') && !containsSecretsResolverItem(collection.item)) {
    failures.push('secrets resolver request is missing for the selected secrets-resolver provider');
  }

  if (authConfig?.enabled) {
    const authVerification = verifySmokeCollectionAuth(collection, authConfig, options);
    if (!authVerification.ok) {
      failures.push(authVerification.summary);
    }
  }
  if (options.authPlan) {
    const authVerification = verifySmokeCollectionAuthPlan(collection, options.authPlan, {
      specPath: options.specPath
    });
    if (!authVerification.ok) {
      failures.push(authVerification.summary);
    }
  }

  return {
    ok: failures.length === 0,
    summary: failures.length > 0 ? failures.join('; ') : `generated Smoke collection persisted with ${requestItems.length} request(s)`
  };
}

export function verifyCuratedSmokeCollection(
  collection: JsonRecord,
  flow: FlowDefinition,
  authConfig: SmokeAuthConfig | undefined,
  options: { secretsResolverProvider?: SecretsResolverProvider; authPlan?: SmokeAuthPlan } = {}
): CollectionVerification {
  const topLevelItems = getTopLevelItems(collection);
  const requestItems = topLevelItems.filter((item) => asRecord(item.request) && !isSecretsResolverItem(item));
  const requestNames = requestItems.map((item) => String(item.name ?? ''));
  const expectedRequestNames = flow.steps.map((step) => step.name?.trim() || step.operationId);
  const missingRequests = expectedRequestNames.filter((name) => !requestNames.includes(name));
  const requestsMissingScripts = requestItems
    .filter((item) => expectedRequestNames.includes(String(item.name ?? '')) && !hasFlowRequestScripts(item))
    .map((item) => String(item.name ?? ''));
  const failures: string[] = [];

  if (requestItems.length !== expectedRequestNames.length) {
    failures.push(`expected ${expectedRequestNames.length} curated request(s), found ${requestItems.length}`);
  }
  if (missingRequests.length > 0) {
    failures.push(`missing curated request(s): ${missingRequests.join(', ')}`);
  }
  if (requestsMissingScripts.length > 0) {
    failures.push(`missing flow script(s): ${requestsMissingScripts.join(', ')}`);
  }

  const hasSecretsResolver = containsSecretsResolverItem(collection.item);
  if (!isSecretsResolverEnabled(options.secretsResolverProvider ?? 'none') && hasSecretsResolver) {
    failures.push('secrets resolver request is still present');
  }
  if (isSecretsResolverEnabled(options.secretsResolverProvider ?? 'none') && !hasSecretsResolver) {
    failures.push('secrets resolver request is missing');
  }

  if (authConfig?.enabled) {
    const authVerification = verifySmokeCollectionAuth(collection, authConfig, options);
    if (!authVerification.ok) {
      failures.push(authVerification.summary);
    }
  }
  if (options.authPlan) {
    const authVerification = verifySmokeCollectionAuthPlan(collection, options.authPlan, { flow });
    if (!authVerification.ok) {
      failures.push(authVerification.summary);
    }
  }

  return {
    ok: failures.length === 0,
    summary: failures.length > 0 ? failures.join('; ') : `curated flow persisted with ${requestItems.length} request(s)`
  };
}

function curateRequestItem(
  resolved: ResolvedRequest,
  authConfig?: SmokeAuthConfig,
  authProfile?: SmokeAuthProfile
): JsonRecord {
  const item = structuredClone(resolved.item);
  item.name = resolved.step.name?.trim() || resolved.step.operationId;
  const request = asRecord(item.request);
  if (request) {
    updateRequestUrl(request, resolved.step);
    updateRequestBody(request, resolved.step);
  }
  applyFlowScripts(item, resolved.step);
  const curatedRequest = asRecord(item.request);
  if (curatedRequest) {
    applyAuthToRequest(curatedRequest, authConfig);
  }
  if (authProfile) {
    applyAuthProfileToItem(item, authProfile);
  }
  return item;
}

export function applySmokeCollectionAuth(
  existingCollection: JsonRecord,
  authConfig: SmokeAuthConfig,
  options: { secretsResolverProvider?: SecretsResolverProvider } = {}
): { collection: JsonRecord; authRequestCount: number } {
  const collection = sanitizeForCollectionUpdate(structuredClone(existingCollection)) as JsonRecord;
  // Auth-only path: only an EXPLICIT opt-out removes a resolver the caller
  // already has. Leaving this on the 'none' default would silently strip the
  // helper out of every existing collection on the next auth refresh.
  if (options.secretsResolverProvider === 'none') {
    collection.item = removeSecretsResolverItems(collection.item);
  }
  applyCollectionAuth(collection, authConfig);
  const authRequestCount = applyAuthToCollectionItems(collection.item, authConfig);
  return {
    collection: sanitizeForCollectionUpdate(collection) as JsonRecord,
    authRequestCount
  };
}

export function buildGeneratedSmokeCollection(
  generatedCollection: JsonRecord,
  authConfig?: SmokeAuthConfig,
  options: GeneratedSmokeCollectionBuildOptions = {}
): { collection: JsonRecord; authRequestCount: number; requestCount: number } {
  const collection = sanitizeForCollectionUpdate(structuredClone(generatedCollection)) as JsonRecord;
  if (options.collectionName) {
    const info = asRecord(collection.info) ?? {};
    info.name = options.collectionName;
    collection.info = info;
  }
  applyCanonicalCollectionIdentity(collection, options.canonicalCollection);
  if (!isSecretsResolverEnabled(options.secretsResolverProvider ?? 'none')) {
    collection.item = removeSecretsResolverItems(collection.item);
  } else if (!containsSecretsResolverItem(collection.item)) {
    // Opt-in contract (action.yml secrets-resolver defaults to none): when a
    // provider IS selected the helper leads the generated collection even if
    // the generator did not emit one.
    const items = Array.isArray(collection.item) ? collection.item : [];
    collection.item = [buildSecretsResolverItem(options.secretsResolverProvider ?? 'none'), ...items];
  }
  preserveRequestEventsFromCollection(collection, options.scriptSourceCollection);

  let authRequestCount = 0;
  if (authConfig?.enabled) {
    applyCollectionAuth(collection, authConfig);
    authRequestCount = applyAuthToCollectionItems(collection.item, authConfig);
  } else if (options.authPlan) {
    authRequestCount = applyAuthPlanToGeneratedCollection(
      collection,
      options.authPlan,
      options.specPath
    );
  }

  return {
    collection: sanitizeForCollectionUpdate(collection) as JsonRecord,
    authRequestCount,
    requestCount: collectSmokeRequestItems(collection.item).length
  };
}

export function buildCuratedSmokeCollection(
  generatedCollection: JsonRecord,
  flow: FlowDefinition,
  resolvedRequests: ResolvedRequest[],
  authConfig?: SmokeAuthConfig,
  secretsResolverProvider: SecretsResolverProvider = 'none',
  options: { canonicalCollection?: JsonRecord; authPlan?: SmokeAuthPlan } = {}
): { collection: JsonRecord; bindingCount: number; extractCount: number; assertionCount: number } {
  const collection = sanitizeForCollectionUpdate(structuredClone(generatedCollection)) as JsonRecord;
  const info = asRecord(collection.info);
  if (info) {
    info.name = `[Smoke] ${flow.name}`;
  }
  applyCanonicalCollectionIdentity(collection, options.canonicalCollection);
  if (options.authPlan) {
    prepareCollectionForAuthPlan(collection, options.authPlan);
  } else {
    applyCollectionAuth(collection, authConfig);
  }
  const requestItems = resolvedRequests.map((request) =>
    curateRequestItem(
      request,
      authConfig,
      options.authPlan
        ? resolveCuratedAuthProfile(options.authPlan, request.step.operationId)
        : undefined
    )
  );
  collection.item = isSecretsResolverEnabled(secretsResolverProvider)
    ? [buildSecretsResolverItem(secretsResolverProvider), ...requestItems]
    : requestItems;
  const sanitizedCollection = sanitizeForCollectionUpdate(collection) as JsonRecord;

  const bindingCount = flow.steps.reduce((sum, step) => sum + step.bindings.length, 0);
  const extractCount = flow.steps.reduce((sum, step) => sum + step.extract.length, 0);
  const assertionCount = flow.steps.reduce((sum, step) => sum + countAssertionsForStep(step), 0);

  return {
    collection: sanitizedCollection,
    bindingCount,
    extractCount,
    assertionCount
  };
}
