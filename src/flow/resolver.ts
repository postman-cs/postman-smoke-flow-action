import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

import type { FlowDefinition, ResolvedRequest } from '../types.js';
import { ValidationError } from '../lib/errors.js';
import { collectOperations } from './derive.js';

type CollectionItem = Record<string, unknown>;
type OperationMatch = {
  method: string;
  path: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getItemName(item: CollectionItem): string {
  return typeof item.name === 'string' ? item.name : '';
}

function getRequestDescription(item: CollectionItem): string {
  const request = asRecord(item.request);
  if (!request) return '';
  if (typeof request.description === 'string') return request.description;
  const description = asRecord(request.description);
  return typeof description?.content === 'string' ? description.content : '';
}

function getRequestMethod(item: CollectionItem): string {
  const request = asRecord(item.request);
  return typeof request?.method === 'string' ? request.method.toUpperCase() : '';
}

function normalizePathTemplate(value: string): string {
  return value
    .replace(/[?#].*$/, '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\{\{[^}]+\}\}/, '')
    .replace(/:[^/]+/g, '{}')
    .replace(/\{[^/]+\}/g, '{}')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function getRequestPath(item: CollectionItem): string {
  const request = asRecord(item.request);
  const url = request?.url;
  if (typeof url === 'string') {
    return normalizePathTemplate(url);
  }

  const urlRecord = asRecord(url);
  if (!urlRecord) return '';
  if (typeof urlRecord.raw === 'string') {
    return normalizePathTemplate(urlRecord.raw);
  }
  const pathSegments = Array.isArray(urlRecord.path) ? urlRecord.path.map(String).join('/') : '';
  if (pathSegments) {
    return normalizePathTemplate(`/${pathSegments}`);
  }
  return '';
}

function flattenRequestItems(node: CollectionItem): CollectionItem[] {
  const results: CollectionItem[] = [];

  const visit = (item: CollectionItem): void => {
    if (item.request && typeof item.request === 'object') {
      results.push(item);
    }
    const children = Array.isArray(item.item) ? item.item : [];
    children.map(asRecord).filter((entry): entry is CollectionItem => Boolean(entry)).forEach(visit);
  };

  visit(node);
  return results;
}

function matchesOperationId(item: CollectionItem, operationId: string): boolean {
  const name = getItemName(item);
  const description = getRequestDescription(item);
  return (
    name === operationId ||
    name.toLowerCase() === operationId.toLowerCase() ||
    description.includes(operationId) ||
    description.toLowerCase().includes(operationId.toLowerCase())
  );
}

function loadOperationMatches(specPath?: string): Map<string, OperationMatch> {
  if (!specPath) {
    return new Map();
  }

  const document = parse(readFileSync(specPath, 'utf8')) as Record<string, unknown> | null;
  const paths = asRecord(document?.paths);
  if (!paths) {
    return new Map();
  }

  // Shared with derivation: same Path Item $ref handling, same synthetic
  // fallback operationIds, same collision suffixes. A derived step's
  // operationId therefore ALWAYS has a method+path entry here, even when the
  // spec omits operationId entirely.
  const operationMatches = new Map<string, OperationMatch>();
  for (const operation of collectOperations(document ?? {})) {
    operationMatches.set(operation.operationId, {
      method: operation.method,
      path: normalizePathTemplate(operation.path)
    });
  }

  return operationMatches;
}

function matchesOperationByRequestShape(item: CollectionItem, operationMatch?: OperationMatch): boolean {
  if (!operationMatch) {
    return false;
  }
  return (
    getRequestMethod(item) === operationMatch.method &&
    getRequestPath(item) === operationMatch.path
  );
}

export function resolveFlowRequests(
  flow: FlowDefinition,
  generatedCollection: CollectionItem,
  specPath?: string
): ResolvedRequest[] {
  const requestItems = flattenRequestItems(generatedCollection);
  const operationMatches = loadOperationMatches(specPath);

  return flow.steps.map((step) => {
    const match = requestItems.find(
      (item) =>
        matchesOperationId(item, step.operationId) ||
        matchesOperationByRequestShape(item, operationMatches.get(step.operationId))
    );
    if (!match) {
      throw new ValidationError(`Could not resolve operationId "${step.operationId}" in the generated temporary Smoke collection.`);
    }
    return {
      step,
      item: structuredClone(match)
    };
  });
}
