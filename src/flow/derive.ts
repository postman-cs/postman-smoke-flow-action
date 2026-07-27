import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

import type { FlowBinding, FlowDefinition, FlowExtract, FlowStep, FlowWarning } from '../types.js';
import { assertPathWithinCwd } from '../lib/paths.js';
import { ValidationError } from '../lib/errors.js';

/**
 * Deterministic smoke-flow derivation from an OpenAPI document.
 *
 * Produces the same FlowDefinition shape the curated flow.yaml parser emits, so
 * everything downstream (resolver, transform, verifier, summary outputs) is
 * shared with the curated path. Nothing here is random, time-dependent, or
 * network-dependent: the same spec bytes always derive the same flow.
 *
 * Rules (v1, documented in docs/derived-flow.md):
 *  1. Operations are grouped into resources by their normalized collection path
 *     (path with trailing parameter segments stripped).
 *  2. Per-resource CRUD order: create (POST on collection path) -> list (GET on
 *     collection path) -> read (GET on item path) -> update (PUT/PATCH on item
 *     path) -> delete (DELETE on item path). Non-CRUD operations keep spec
 *     order after the recognized lifecycle.
 *  3. Output->input dependencies: a POST whose 2xx response schema contains a
 *     property matching an item-path parameter (exact name, or resource-id
 *     convention like `id` ~ `{petId}`) produces an extract; consumers bind it
 *     via prior_output.
 *  4. Steps with unmet path-parameter dependencies fall back to source=example
 *     bindings (the generated request example value is preserved).
 *  5. DELETE operations are derived but EXCLUDED from the flow by default;
 *     enabling them requires flow-allow-delete=true AND every path parameter
 *     must resolve from the create step of the resource that OWNS that
 *     parameter (owner-scoped provenance: {projectId} only from the /projects
 *     create). Global cross-resource fallbacks never satisfy provenance.
 *  6. Total order across resources: base order sorts resources by (depth of
 *     collection path, path lexical); operations inside a resource follow rule
 *     2 with (method, path) lexical tie-breaks. A stable dependency pass then
 *     emits each resource only after its producer resources (parameter owners,
 *     or exact-name producers elsewhere): the earliest base-order resource with
 *     all producers emitted goes next; a dependency cycle falls back to base
 *     order.
 */

export type DerivedFlowResult = {
  flow: FlowDefinition | null;
  warnings: FlowWarning[];
  /** Operations recognized but excluded (currently: DELETE without allow flag). */
  excludedOperationIds: string[];
  /** Machine-readable derivation trace for the summary output. */
  trace: DerivationTrace;
};

export type DerivationTrace = {
  resourceCount: number;
  operationCount: number;
  derivedStepCount: number;
  extractCount: number;
  bindingCount: number;
  excludedDeleteCount: number;
  /** Steps dropped because a required path parameter had no producer in the spec. */
  excludedUnresolvedPathParamCount: number;
  unresolvedParameterCount: number;
};

export type DeriveOptions = {
  allowDelete?: boolean;
  flowName?: string;
};

type JsonRecord = Record<string, unknown>;

export type SpecOperation = {
  operationId: string;
  method: string;
  path: string;
  /** Path with trailing `{param}` segments stripped; resource grouping key. */
  collectionPath: string;
  /** True when the path's final segment is a parameter (item-style path). */
  isItemPath: boolean;
  pathParams: PathParamRef[];
  /** Required query parameter names, merged path-item + operation, operation wins. */
  requiredQueryParams: string[];
  requestBodyProps: string[];
  responseProps: Map<string, string>; // property name -> jsonPath
  specIndex: number;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

const MAX_REF_DEPTH = 16;

function resolveRef(document: JsonRecord, ref: string): JsonRecord | null {
  if (!ref.startsWith('#/')) return null;
  let cursor: unknown = document;
  for (const segment of ref.slice(2).split('/')) {
    const record = asRecord(cursor);
    if (!record) return null;
    cursor = record[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return asRecord(cursor);
}

function derefSchema(document: JsonRecord, schema: JsonRecord | null, depth = 0): JsonRecord | null {
  if (!schema || depth > MAX_REF_DEPTH) return schema;
  const ref = typeof schema.$ref === 'string' ? schema.$ref : '';
  if (!ref) return schema;
  const resolved = resolveRef(document, ref);
  return resolved ? derefSchema(document, resolved, depth + 1) : null;
}

/**
 * Merge path-item and operation `parameters` per OpenAPI override rules
 * ((name, in) identity, operation wins) and return required query parameter
 * names in deterministic declaration order. Parameter Object $refs resolve
 * through the document; unresolvable refs are skipped.
 */
function collectRequiredQueryParams(
  document: JsonRecord,
  pathItem: JsonRecord,
  operation: JsonRecord
): string[] {
  const merged = new Map<string, { name: string; required: boolean }>();
  const absorb = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const param = derefSchema(document, asRecord(entry));
      if (!param) continue;
      const name = typeof param.name === 'string' ? param.name.trim() : '';
      const location = typeof param.in === 'string' ? param.in : '';
      if (!name || location !== 'query') continue;
      merged.set(`${name}::${location}`, { name, required: param.required === true });
    }
  };
  absorb(pathItem.parameters);
  absorb(operation.parameters); // operation-level entries override path-item entries
  return [...merged.values()].filter((param) => param.required).map((param) => param.name);
}

/**
 * Collect scalar-bearing property names from a response schema, with the
 * jsonPath needed to reach each. Traverses objects one level of nesting deep
 * plus array-of-object unwrap (`$[0].id` style is NOT emitted -- top-level
 * arrays yield no extracts in v1 because item identity is ambiguous).
 */
function collectResponseProps(document: JsonRecord, schema: JsonRecord | null): Map<string, string> {
  const found = new Map<string, { jsonPath: string; depth: number }>();
  const root = derefSchema(document, schema);
  if (!root) return new Map();

  const visiting = new Set<JsonRecord>();
  const visit = (node: JsonRecord | null, prefix: string, depth: number): void => {
    const resolved = derefSchema(document, node);
    if (!resolved || depth > 2) return;
    // Cycle guard: recursive allOf/$ref graphs terminate instead of overflowing.
    if (visiting.has(resolved)) return;
    visiting.add(resolved);
    try {
      // allOf composition: merge every branch, first writer wins (deterministic).
      if (Array.isArray(resolved.allOf)) {
        for (const branch of resolved.allOf) {
          visit(asRecord(branch), prefix, depth);
        }
      }
      const props = asRecord(resolved.properties);
      if (!props) return;
      for (const key of Object.keys(props).sort()) {
        const child = derefSchema(document, asRecord(props[key]));
        const jsonPath = `${prefix}.${key}`;
        const rawType = child?.type;
        const childTypes = Array.isArray(rawType)
          ? rawType.filter((entry): entry is string => typeof entry === 'string')
          : typeof rawType === 'string'
            ? [rawType]
            : [];
        // OpenAPI 3.1 nullable unions (['array','null']) resolve to the non-null member so the array guard fires.
        const childType = childTypes.find((entry) => entry !== 'null') ?? '';
        if (
          childType === 'object' ||
          (child && asRecord(child.properties)) ||
          (child && Array.isArray(child.allOf))
        ) {
          visit(child, jsonPath, depth + 1);
          continue;
        }
        if (childType === 'array') continue;
        // Shallower paths win: a top-level `id` must never be shadowed by a
        // nested object's `id` that happens to be visited first in key order.
        const existing = found.get(key);
        if (!existing || depth < existing.depth) {
          found.set(key, { jsonPath, depth });
        }
      }
    } finally {
      // Every exit path (including the no-properties early return) must clear
      // the active-node marker, or a shared allOf-only schema visited twice in
      // one response is skipped as a false cycle.
      visiting.delete(resolved);
    }
  };

  visit(root, '$', 0);
  const result = new Map<string, string>();
  for (const [key, entry] of found) {
    result.set(key, entry.jsonPath);
  }
  return result;
}

/**
 * Pick the JSON media entry from a content map. Extraction scripts parse
 * response bodies as JSON, so non-JSON media (XML, CSV, binary) must never
 * feed extracts or request-shape hints.
 */
function pickJsonMediaKey(content: JsonRecord): string | undefined {
  return Object.keys(content)
    .sort()
    .find((key) => key.includes('json'));
}

function collectRequestBodyProps(document: JsonRecord, operation: JsonRecord): string[] {
  const requestBody = derefSchema(document, asRecord(operation.requestBody));
  const content = asRecord(requestBody?.content);
  if (!content) return [];
  const jsonKey = pickJsonMediaKey(content);
  if (!jsonKey) return [];
  const schema = derefSchema(document, asRecord(asRecord(content[jsonKey])?.schema));
  const props = asRecord(schema?.properties);
  return props ? Object.keys(props).sort() : [];
}

function pickSuccessResponseSchema(document: JsonRecord, operation: JsonRecord): JsonRecord | null {
  const responses = asRecord(operation.responses);
  if (!responses) return null;
  const codes = Object.keys(responses)
    .filter((code) => /^2\d\d$/.test(code))
    .sort();
  const preferred = ['200', '201', ...codes];
  for (const code of preferred) {
    const response = derefSchema(document, asRecord(responses[code]));
    const content = asRecord(response?.content);
    if (!content) continue;
    const jsonKey = pickJsonMediaKey(content);
    if (!jsonKey) continue;
    const schema = asRecord(asRecord(content[jsonKey])?.schema);
    if (schema) return schema;
  }
  return null;
}

export type PathParamRef = {
  name: string;
  /** Collection path of the resource that owns this parameter (the segments before it). */
  ownerPath: string;
  /** Resource segment immediately preceding the parameter (for id conventions). */
  ownerSegment: string;
};

function extractPathParams(pathKey: string): PathParamRef[] {
  const segments = pathKey.split('/').filter(Boolean);
  const params: PathParamRef[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    const match = /^\{([^}]+)\}$/.exec(segment);
    if (!match) continue;
    const name = match[1]?.trim();
    if (!name) continue;
    const before = segments.slice(0, index);
    const ownerPath = `/${before.join('/')}`;
    let ownerSegment = '';
    for (let back = before.length - 1; back >= 0; back -= 1) {
      const candidate = before[back] ?? '';
      if (!/^\{[^}]+\}$/.test(candidate)) {
        ownerSegment = candidate;
        break;
      }
    }
    params.push({ name, ownerPath, ownerSegment });
  }
  return params;
}

function toCollectionPath(pathKey: string): { collectionPath: string; isItemPath: boolean } {
  const segments = pathKey.split('/').filter(Boolean);
  let end = segments.length;
  while (end > 0 && /^\{[^}]+\}$/.test(segments[end - 1] ?? '')) {
    end -= 1;
  }
  const isItemPath = end < segments.length;
  const collectionPath = `/${segments.slice(0, end).join('/')}`;
  return { collectionPath: collectionPath === '/' && segments.length > 0 ? `/${segments[0]}` : collectionPath, isItemPath };
}

function fallbackOperationId(method: string, pathKey: string): string {
  const slug = pathKey
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/[{}]/g, ''))
    .join('-')
    .replace(/[^A-Za-z0-9-]/g, '-');
  return `${method.toLowerCase()}-${slug || 'root'}`;
}

export function loadSpecDocument(specPath: string): JsonRecord {
  const resolved = assertPathWithinCwd(specPath, 'spec-path');
  const raw = readFileSync(resolved, 'utf8');
  const document = parse(raw) as JsonRecord | null;
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new ValidationError('spec-path must parse to an OpenAPI document object.');
  }
  return document;
}

export function collectOperations(document: JsonRecord): SpecOperation[] {
  const paths = asRecord(document.paths);
  if (!paths) return [];
  const operations: SpecOperation[] = [];
  const usedOperationIds = new Set<string>();
  let specIndex = 0;
  // Deterministic iteration: equivalent documents that differ only in path or
  // method key insertion order must derive byte-identical flows, including
  // collision-suffixed fallback operationIds.
  for (const pathKey of Object.keys(paths).sort()) {
    // OpenAPI permits Path Item $ref (spec 3.0.3 section 4.7.9).
    const pathItem = derefSchema(document, asRecord(paths[pathKey]));
    if (!pathItem) continue;
    const pathLevelParams = extractPathParams(pathKey);
    for (const method of Object.keys(pathItem).sort()) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const operation = asRecord(pathItem[method]);
      if (!operation) continue;
      const { collectionPath, isItemPath } = toCollectionPath(pathKey);
      let operationId =
        typeof operation.operationId === 'string' && operation.operationId.trim()
          ? operation.operationId.trim()
          : fallbackOperationId(method, pathKey);
      // Collision-safe: paths like /foo/bar and /foo-bar can slug identically.
      if (usedOperationIds.has(operationId)) {
        let suffix = 2;
        while (usedOperationIds.has(`${operationId}-${suffix}`)) suffix += 1;
        operationId = `${operationId}-${suffix}`;
      }
      usedOperationIds.add(operationId);
      operations.push({
        operationId,
        method: method.toUpperCase(),
        path: pathKey,
        collectionPath,
        isItemPath,
        pathParams: pathLevelParams,
        requiredQueryParams: collectRequiredQueryParams(document, pathItem, operation),
        requestBodyProps: collectRequestBodyProps(document, operation),
        responseProps: collectResponseProps(document, pickSuccessResponseSchema(document, operation)),
        specIndex: specIndex++
      });
    }
  }
  return operations;
}

/** CRUD lifecycle rank inside one resource group. Lower runs earlier. */
function lifecycleRank(op: SpecOperation): number {
  if (op.method === 'POST' && !op.isItemPath) return 0; // create
  if (op.method === 'GET' && !op.isItemPath) return 1; // list
  if (op.method === 'GET' && op.isItemPath) return 2; // read
  if ((op.method === 'PUT' || op.method === 'PATCH') && op.isItemPath) return 3; // update
  if (op.method === 'DELETE' && op.isItemPath) return 5; // delete (after everything)
  if (op.method === 'DELETE') return 5;
  return 4; // non-CRUD (actions, RPC-ish POST on item path, HEAD, etc.)
}

function compareOperations(a: SpecOperation, b: SpecOperation): number {
  const rank = lifecycleRank(a) - lifecycleRank(b);
  if (rank !== 0) return rank;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.method !== b.method) return a.method < b.method ? -1 : 1;
  return a.specIndex - b.specIndex;
}

/**
 * Candidate producer property names for one path parameter, most specific
 * first: exact name, then the `id` convention (`{petId}` matches producer
 * property `id` when the producer belongs to the `pet(s)` resource, and plain
 * `id` matches when the parameter itself is `id`).
 */
function parameterCandidates(param: string, resourceSegment: string): string[] {
  const candidates = [param];
  const lowerParam = param.toLowerCase();
  const singular = resourceSegment.endsWith('s') ? resourceSegment.slice(0, -1) : resourceSegment;
  const conventional = `${singular}Id`.toLowerCase();
  if (lowerParam === 'id' || lowerParam === conventional || lowerParam.endsWith('id')) {
    candidates.push('id');
  }
  return candidates;
}

function stepKeyFor(op: SpecOperation, ordinal: number): string {
  const slug = op.operationId
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'step'}-${ordinal}`;
}

export function deriveFlowFromSpec(document: JsonRecord, options: DeriveOptions = {}): DerivedFlowResult {
  const warnings: FlowWarning[] = [];
  const operations = collectOperations(document);

  if (operations.length === 0) {
    warnings.push({ message: 'Flow derivation found no operations in the OpenAPI document; a smoke flow cannot be derived.' });
    return {
      flow: null,
      warnings,
      excludedOperationIds: [],
      trace: {
        resourceCount: 0,
        operationCount: 0,
        derivedStepCount: 0,
        extractCount: 0,
        bindingCount: 0,
        excludedDeleteCount: 0,
        excludedUnresolvedPathParamCount: 0,
        unresolvedParameterCount: 0
      }
    };
  }

  // Group by resource (collectionPath), deterministic resource order.
  const groups = new Map<string, SpecOperation[]>();
  for (const op of operations) {
    const list = groups.get(op.collectionPath) ?? [];
    list.push(op);
    groups.set(op.collectionPath, list);
  }
  const baseOrder = [...groups.keys()].sort((a, b) => {
    const depth = a.split('/').filter(Boolean).length - b.split('/').filter(Boolean).length;
    if (depth !== 0) return depth;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // Producer capability per resource: property names its collection-POST would
  // publish as extracts (id-suffixed response properties).
  const publishable = new Map<string, Set<string>>();
  for (const [resource, list] of groups) {
    const props = new Set<string>();
    for (const op of list) {
      if (op.method !== 'POST' || op.isItemPath) continue;
      for (const prop of op.responseProps.keys()) {
        if (/id$/i.test(prop) || prop === 'id') props.add(prop);
      }
    }
    if (props.size > 0) publishable.set(resource, props);
  }

  // Dependency edges: consumer resource -> producer resource. A parameter's
  // producer is the resource that owns it when that resource publishes a
  // matching property; otherwise the first base-order resource publishing the
  // exact parameter name.
  const dependsOn = new Map<string, Set<string>>();
  const addDependency = (resource: string, producerResource: string | undefined): void => {
    if (!producerResource || producerResource === resource) return;
    const set = dependsOn.get(resource) ?? new Set<string>();
    set.add(producerResource);
    dependsOn.set(resource, set);
  };
  for (const [resource, list] of groups) {
    for (const op of list) {
      for (const param of op.pathParams) {
        const candidates = parameterCandidates(param.name, param.ownerSegment);
        const ownerProps = publishable.get(param.ownerPath);
        let producerResource: string | undefined;
        if (ownerProps && candidates.some((candidate) => ownerProps.has(candidate))) {
          producerResource = param.ownerPath;
        } else {
          producerResource = baseOrder.find(
            (other) =>
              other !== resource &&
              candidates.some((candidate) => publishable.get(other)?.has(candidate))
          );
        }
        addDependency(resource, producerResource);
      }
      // Required query parameters chain from exact-name producers too, so the
      // producing resource must be emitted first for the binding to resolve.
      for (const queryParam of op.requiredQueryParams) {
        addDependency(
          resource,
          baseOrder.find((other) => other !== resource && publishable.get(other)?.has(queryParam))
        );
      }
    }
  }

  // Stable topological order: always emit the earliest base-order resource
  // whose producers are all emitted; a cycle falls back to base order.
  const resourceOrder: string[] = [];
  const emitted = new Set<string>();
  const remaining = [...baseOrder];
  while (remaining.length > 0) {
    const pickIndex = remaining.findIndex((resource) =>
      [...(dependsOn.get(resource) ?? [])].every((dep) => emitted.has(dep) || !groups.has(dep))
    );
    const index = pickIndex === -1 ? 0 : pickIndex;
    const resource = remaining.splice(index, 1)[0]!;
    emitted.add(resource);
    resourceOrder.push(resource);
  }

  // Base order: resources by (depth, lexical); operations by lifecycle rank.
  const ordered: SpecOperation[] = [];
  for (const resource of resourceOrder) {
    const list = [...(groups.get(resource) ?? [])].sort(compareOperations);
    ordered.push(...list);
  }

  // Producer registry: property name -> { stepKey, variable } from earlier steps.
  const producers = new Map<string, { stepKey: string; variable: string; operationId: string }>();
  const steps: FlowStep[] = [];
  const excludedOperationIds: string[] = [];
  let extractTotal = 0;
  let bindingTotal = 0;
  let unresolvedParameterCount = 0;
  let excludedDeleteCount = 0;
  let excludedUnresolvedPathParamCount = 0;

  // Rule 3: an extract exists only to feed a prior_output binding, so a
  // response property is published only when some path parameter in the
  // document can consume it.
  const consumableProps = new Set<string>();
  for (const op of operations) {
    for (const param of op.pathParams) {
      for (const candidate of parameterCandidates(param.name, param.ownerSegment)) {
        consumableProps.add(candidate);
      }
    }
    for (const queryParam of op.requiredQueryParams) {
      consumableProps.add(queryParam);
    }
  }

  let ordinal = 0;
  for (const op of ordered) {
    ordinal += 1;
    const stepKey = stepKeyFor(op, ordinal);
    const bindings: FlowBinding[] = [];
    const extract: FlowExtract[] = [];
    const unresolvedPathParams: string[] = [];

    // Resolve every path parameter against known producers. Each parameter is
    // scoped to the resource that OWNS it (the collection path formed by the
    // segments before it), so a parent {projectId} binds to the /projects
    // create and never to a child resource's id. DELETE provenance requires
    // every parameter to resolve via its owner-scoped producer; the global
    // cross-resource fallback binds for reads/updates but never proves
    // same-run create provenance.
    let sameRunCreateProvenance = op.pathParams.length > 0;
    for (const param of op.pathParams) {
      const candidates = parameterCandidates(param.name, param.ownerSegment);
      let producer: { stepKey: string; variable: string; operationId: string } | undefined;
      let scopedMatch = false;
      for (const candidate of candidates) {
        // Prefer the owner-scoped producer key, then the global property.
        const scoped = producers.get(`${param.ownerPath}::${candidate}`);
        producer = scoped ?? producers.get(candidate);
        if (producer) {
          scopedMatch = Boolean(scoped);
          break;
        }
      }
      if (producer) {
        if (!scopedMatch) sameRunCreateProvenance = false;
        bindings.push({
          fieldKey: param.name,
          source: 'prior_output',
          sourceStepKey: producer.stepKey,
          variable: producer.variable
        });
      } else {
        sameRunCreateProvenance = false;
        unresolvedParameterCount += 1;
        unresolvedPathParams.push(param.name);
        bindings.push({ fieldKey: param.name, source: 'example' });
      }
    }

    // Required query parameters: bind with source example so the transform
    // PRESERVES the generated value instead of pruning the query entry.
    // Optional query parameters stay unbound (pruned), keeping smoke requests
    // minimal. A prior-output producer with the exact name wins over the
    // generated example when available.
    for (const queryParam of op.requiredQueryParams) {
      if (bindings.some((binding) => binding.fieldKey === queryParam)) continue;
      const producer = producers.get(queryParam);
      if (producer) {
        bindings.push({
          fieldKey: queryParam,
          source: 'prior_output',
          sourceStepKey: producer.stepKey,
          variable: producer.variable
        });
      } else {
        bindings.push({ fieldKey: queryParam, source: 'example' });
      }
    }

    // DELETE safety: excluded unless allowed AND id provably from same-run create.
    if (op.method === 'DELETE') {
      const provenanceOk = options.allowDelete === true && sameRunCreateProvenance;
      if (!provenanceOk) {
        excludedOperationIds.push(op.operationId);
        excludedDeleteCount += 1;
        warnings.push({
          message:
            options.allowDelete === true
              ? `Derived flow excluded DELETE ${op.path} (${op.operationId}): its identifier is not proven to originate from this run's create step.`
              : `Derived flow excluded DELETE ${op.path} (${op.operationId}); set flow-allow-delete=true to include DELETE operations whose identifiers come from this run's create steps.`
        });
        continue;
      }
    }

    // Required path parameters must carry a real value. The collection transform
    // substitutes only prior_output bindings, so a path parameter that no producer
    // satisfies ships the literal `:param` segment and the request can only 404.
    // Exclude the step instead of deriving a request that cannot pass.
    if (unresolvedPathParams.length > 0) {
      excludedOperationIds.push(op.operationId);
      excludedUnresolvedPathParamCount += 1;
      const many = unresolvedPathParams.length > 1;
      const names = unresolvedPathParams.map((name) => `{${name}}`).join(', ');
      warnings.push({
        message: `Derived flow excluded ${op.method} ${op.path} (${op.operationId}): path ${many ? 'parameters' : 'parameter'} ${names} ${many ? 'have' : 'has'} no producer in this spec, so the request would be sent with an unsubstituted path segment.`
      });
      continue;
    }
    // Extracts: create (POST on collection path) publishes its response ids.
    if (op.method === 'POST' && !op.isItemPath) {
      for (const [prop, jsonPath] of op.responseProps) {
        if (!/id$/i.test(prop) && prop !== 'id') continue;
        if (!consumableProps.has(prop)) continue;
        const variable = `${op.operationId}.${prop}`;
        extract.push({ variable, jsonPath });
        // Register resource-scoped first (wins for same resource), global second.
        if (!producers.has(`${op.collectionPath}::${prop}`)) {
          producers.set(`${op.collectionPath}::${prop}`, { stepKey, variable, operationId: op.operationId });
        }
        if (!producers.has(prop)) {
          producers.set(prop, { stepKey, variable, operationId: op.operationId });
        }
      }
    }

    extractTotal += extract.length;
    bindingTotal += bindings.length;
    steps.push({
      stepKey,
      operationId: op.operationId,
      bindings,
      extract
    });
  }

  if (steps.length === 0) {
    warnings.push({
      message:
        'Flow derivation excluded every operation, so a smoke flow cannot be derived. Operations are excluded when they are DELETEs that do not meet the allow-and-provenance requirements, or when a required path parameter has no producer in this spec.'
    });
    return {
      flow: null,
      warnings,
      excludedOperationIds,
      trace: {
        resourceCount: groups.size,
        operationCount: operations.length,
        derivedStepCount: 0,
        extractCount: 0,
        bindingCount: 0,
        excludedDeleteCount,
        excludedUnresolvedPathParamCount,
        unresolvedParameterCount
      }
    };
  }

  const info = asRecord(document.info);
  const title = typeof info?.title === 'string' && info.title.trim() ? info.title.trim() : 'API';
  const flow: FlowDefinition = {
    name: options.flowName?.trim() || `${title} derived smoke flow`,
    type: 'smoke',
    steps
  };

  return {
    flow,
    warnings,
    excludedOperationIds,
    trace: {
      resourceCount: groups.size,
      operationCount: operations.length,
      derivedStepCount: steps.length,
      extractCount: extractTotal,
      bindingCount: bindingTotal,
      excludedDeleteCount,
      excludedUnresolvedPathParamCount,
      unresolvedParameterCount
    }
  };
}

export function deriveFlowFromSpecPath(specPath: string, options: DeriveOptions = {}): DerivedFlowResult {
  return deriveFlowFromSpec(loadSpecDocument(specPath), options);
}
