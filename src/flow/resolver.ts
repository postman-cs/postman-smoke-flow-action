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

/**
 * Match tiers, strongest first. Exact/case-insensitive name and method+path
 * (when spec-path is provided) are strong signals; a description substring is
 * weak -- a short operationId can appear inside an unrelated request's
 * description -- so it only applies when no strong tier matched anywhere in
 * the collection, and it produces a warning.
 */
function matchesByName(item: CollectionItem, operationId: string): boolean {
  const name = getItemName(item);
  return name === operationId || name.toLowerCase() === operationId.toLowerCase();
}

function matchesByDescription(item: CollectionItem, operationId: string): boolean {
  const description = getRequestDescription(item);
  return description.includes(operationId) || description.toLowerCase().includes(operationId.toLowerCase());
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

export function resolveOperationRequestTargets(
  operationIds: string[],
  generatedCollection: CollectionItem,
  specPath?: string,
  options: { allowMissing?: boolean } = {}
): Map<string, CollectionItem> {
  const requestItems = flattenRequestItems(generatedCollection);
  const operationMatches = loadOperationMatches(specPath);
  const resolved = new Map<string, CollectionItem>();

  for (const operationId of operationIds) {
    const nameMatches = requestItems.filter((item) => matchesByName(item, operationId));
    if (nameMatches.length > 1) {
      throw new ValidationError(
        `Auth plan operationId "${operationId}" is ambiguous: ${nameMatches.length} requests match by name.`
      );
    }
    if (nameMatches.length === 1) {
      resolved.set(operationId, nameMatches[0]!);
      continue;
    }

    const requestShapeMatches = requestItems.filter((item) =>
      matchesOperationByRequestShape(item, operationMatches.get(operationId))
    );
    if (requestShapeMatches.length > 1) {
      throw new ValidationError(
        `Auth plan operationId "${operationId}" is ambiguous: ${requestShapeMatches.length} requests match its method and path.`
      );
    }
    if (requestShapeMatches.length === 1) {
      resolved.set(operationId, requestShapeMatches[0]!);
      continue;
    }

    if (!options.allowMissing) {
      throw new ValidationError(
        `Could not resolve auth plan operationId "${operationId}" in the generated temporary Smoke collection.`
      );
    }
  }

  return resolved;
}

export function resolveFlowRequests(
  flow: FlowDefinition,
  generatedCollection: CollectionItem,
  specPath?: string,
  onWarning?: (message: string) => void
): ResolvedRequest[] {
  const requestItems = flattenRequestItems(generatedCollection);
  const operationMatches = loadOperationMatches(specPath);

  return flow.steps.map((step) => {
    // Tiered resolution: exact/case-insensitive name, then method+path from
    // the spec, then (weak, warned) description substring.
    let match = requestItems.find((item) => matchesByName(item, step.operationId));
    if (!match) {
      match = requestItems.find((item) =>
        matchesOperationByRequestShape(item, operationMatches.get(step.operationId))
      );
    }
    if (!match) {
      match = requestItems.find((item) => matchesByDescription(item, step.operationId));
      if (match) {
        onWarning?.(
          `Resolved operationId "${step.operationId}" to request "${getItemName(match)}" only via a description substring match; ` +
            `verify the flow targets the intended request (name and method+path tiers found no match).`
        );
      }
    }
    if (!match) {
      throw new ValidationError(`Could not resolve operationId "${step.operationId}" in the generated temporary Smoke collection.`);
    }
    return {
      step,
      item: structuredClone(match)
    };
  });
}
