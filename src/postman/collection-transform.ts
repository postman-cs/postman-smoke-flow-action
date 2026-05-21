import type { FlowBinding, FlowDefinition, FlowStep, ResolvedRequest } from '../types.js';
import { createPreRequestEvent, createSecretsResolverItem, createTestEvent, countAssertionsForStep } from './scripts.js';

type JsonRecord = Record<string, unknown>;

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
      const [rawKey = '', ...rawValueParts] = entry.split('=');
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
      raw = raw.replace(new RegExp(`\"${binding.fieldKey}\"\\s*:\\s*\"[^\"]*\"`, 'g'), `"${binding.fieldKey}": "{{${binding.fieldKey}}}"`);
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

function curateRequestItem(resolved: ResolvedRequest): JsonRecord {
  const item = structuredClone(resolved.item);
  item.name = resolved.step.name?.trim() || resolved.step.operationId;
  const request = asRecord(item.request);
  if (request) {
    updateRequestUrl(request, resolved.step);
    updateRequestBody(request, resolved.step);
  }
  applyFlowScripts(item, resolved.step);
  return item;
}

export function buildCuratedSmokeCollection(
  generatedCollection: JsonRecord,
  flow: FlowDefinition,
  resolvedRequests: ResolvedRequest[]
): { collection: JsonRecord; bindingCount: number; extractCount: number; assertionCount: number } {
  const collection = sanitizeForCollectionUpdate(structuredClone(generatedCollection)) as JsonRecord;
  const info = asRecord(collection.info);
  if (info) {
    info.name = `[Smoke] ${flow.name}`;
  }
  collection.item = [createSecretsResolverItem(), ...resolvedRequests.map(curateRequestItem)];
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
