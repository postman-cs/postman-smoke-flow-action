import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

import { ValidationError } from '../lib/errors.js';
import { assertPathWithinCwd } from '../lib/paths.js';
import type { FlowBinding, FlowDefinition, FlowStep } from '../types.js';

type JsonRecord = Record<string, unknown>;

type Operation = {
  operationId: string;
  method: string;
  path: string;
  pathParams: string[];
  responseProperties: Set<string>;
};

type InferenceResult = {
  flow: FlowDefinition;
  warnings: string[];
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const DESTRUCTIVE_PATTERN = /delete|remove|cancel|void|terminate|deactivate/i;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function operationName(method: string, pathKey: string): string {
  const pathName = pathKey
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/[^A-Za-z0-9]+/g, ' '))
    .flatMap((segment) => segment.split(/\s+/g).filter(Boolean))
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');
  return `${method.toLowerCase()}${pathName || 'Root'}`;
}

function extractPathParams(pathKey: string): string[] {
  return [...pathKey.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!).filter(Boolean);
}

function dereferenceSchema(schema: unknown, document: JsonRecord): JsonRecord | null {
  const record = asRecord(schema);
  const ref = typeof record?.$ref === 'string' ? record.$ref : '';
  if (!ref.startsWith('#/')) {
    return record;
  }

  const segments = ref.slice(2).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cursor: unknown = document;
  for (const segment of segments) {
    cursor = asRecord(cursor)?.[segment];
  }
  return asRecord(cursor);
}

function responseSchemaProperties(operation: JsonRecord, document: JsonRecord): Set<string> {
  const responses = asRecord(operation.responses);
  const candidates = ['201', '200', '202', 'default'];
  const response = candidates
    .map((status) => asRecord(responses?.[status]))
    .find(Boolean) ?? Object.values(responses ?? {}).map(asRecord).find(Boolean);
  const content = asRecord(response?.content);
  const jsonContent = asRecord(content?.['application/json']) ?? asRecord(Object.values(content ?? {}).map(asRecord).find(Boolean));
  const schema = dereferenceSchema(jsonContent?.schema, document);
  const properties = asRecord(schema?.properties);
  return new Set(Object.keys(properties ?? {}));
}

function parseOperations(specPath: string): Operation[] {
  const resolvedPath = assertPathWithinCwd(specPath, 'spec-path');
  const document = parse(readFileSync(resolvedPath, 'utf8')) as JsonRecord | null;
  const paths = asRecord(document?.paths);
  if (!document || !paths) {
    throw new ValidationError('generate-flow-draft requires spec-path to point to an OpenAPI document with paths.');
  }

  const operations: Operation[] = [];
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    const pathRecord = asRecord(pathItem);
    if (!pathRecord) continue;
    for (const [methodKey, operationValue] of Object.entries(pathRecord)) {
      const method = methodKey.toLowerCase();
      if (!HTTP_METHODS.has(method)) continue;
      const operationRecord = asRecord(operationValue);
      if (!operationRecord) continue;
      const operationId = typeof operationRecord.operationId === 'string' && operationRecord.operationId.trim()
        ? operationRecord.operationId.trim()
        : operationName(method, pathKey);
      operations.push({
        operationId,
        method: method.toUpperCase(),
        path: pathKey,
        pathParams: extractPathParams(pathKey),
        responseProperties: responseSchemaProperties(operationRecord, document)
      });
    }
  }
  return operations;
}

function isDestructive(operation: Operation): boolean {
  return operation.method === 'DELETE' || DESTRUCTIVE_PATTERN.test(`${operation.operationId} ${operation.path}`);
}

function singularize(value: string): string {
  return value.endsWith('ies')
    ? `${value.slice(0, -3)}y`
    : value.endsWith('s')
      ? value.slice(0, -1)
      : value;
}

function pathParent(pathKey: string): string {
  return pathKey.replace(/\/\{[^}]+\}$/, '') || '/';
}

function inferExtractJsonPath(createOperation: Operation, pathParam: string): string {
  if (createOperation.responseProperties.has(pathParam)) {
    return `$.${pathParam}`;
  }
  if (createOperation.responseProperties.has('id')) {
    return '$.id';
  }
  const snakeId = pathParam.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  if (createOperation.responseProperties.has(snakeId)) {
    return `$.${snakeId}`;
  }
  return `$.${pathParam}`;
}

function stepForOperation(operation: Operation, index: number, bindings: FlowBinding[] = [], extract: FlowStep['extract'] = []): FlowStep {
  return {
    stepKey: `${operation.operationId}-${index + 1}`,
    operationId: operation.operationId,
    bindings,
    extract
  };
}

function buildSafeChain(operations: Operation[]): InferenceResult | null {
  const safeOperations = operations.filter((operation) => !isDestructive(operation));
  const creates = safeOperations.filter((operation) => operation.method === 'POST' && operation.pathParams.length === 0);
  for (const createOperation of creates) {
    const childOperations = safeOperations.filter(
      (operation) => pathParent(operation.path) === createOperation.path && operation.pathParams.length === 1
    );
    const readOperation = childOperations.find((operation) => operation.method === 'GET');
    if (!readOperation) continue;

    const updateOperation = childOperations.find((operation) => operation.method === 'PATCH' || operation.method === 'PUT');
    const pathParam = readOperation.pathParams[0]!;
    const variable = `${createOperation.operationId}.${pathParam}`;
    const binding: FlowBinding = {
      fieldKey: pathParam,
      source: 'prior_output',
      sourceStepKey: `${createOperation.operationId}-1`,
      variable
    };
    const createStep = stepForOperation(createOperation, 0, [], [
      {
        variable,
        jsonPath: inferExtractJsonPath(createOperation, pathParam)
      }
    ]);
    const steps = [
      createStep,
      stepForOperation(readOperation, 1, [binding], [])
    ];
    if (updateOperation) {
      steps.push(stepForOperation(updateOperation, 2, [binding], []));
      steps.push(stepForOperation(readOperation, 3, [binding], []));
    }

    const resourceName = singularize(createOperation.path.split('/').filter(Boolean).at(-1) ?? 'resource');
    return {
      flow: {
        name: `${resourceName.charAt(0).toUpperCase()}${resourceName.slice(1)} happy path`,
        type: 'smoke',
        steps
      },
      warnings: updateOperation ? [] : [`No safe update operation found for ${readOperation.path}; generated create/read smoke journey.`]
    };
  }
  return null;
}

function buildSafeGetFallback(operations: Operation[]): InferenceResult | null {
  const operation = operations.find(
    (candidate) => candidate.method === 'GET' && candidate.pathParams.length === 0 && !isDestructive(candidate)
  );
  if (!operation) {
    return null;
  }
  return {
    flow: {
      name: `${operation.operationId} smoke check`,
      type: 'smoke',
      steps: [stepForOperation(operation, 0)]
    },
    warnings: ['No create/read happy path could be inferred; generated a single safe GET smoke check.']
  };
}

export function inferSmokeFlowFromOpenApi(specPath: string, flowName?: string): InferenceResult {
  const operations = parseOperations(specPath);
  const inferred = buildSafeChain(operations) ?? buildSafeGetFallback(operations);
  if (!inferred) {
    throw new ValidationError('Could not infer a safe smoke flow from spec-path. Add a non-destructive GET operation or provide flow-path.');
  }
  return {
    ...inferred,
    flow: {
      ...inferred.flow,
      name: flowName?.trim() || inferred.flow.name
    }
  };
}
