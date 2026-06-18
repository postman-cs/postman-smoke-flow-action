import { randomUUID } from 'node:crypto';

import { HttpError } from '../lib/errors.js';
import type { FlowDefinition, FlowDraftSummary, ResolvedRequest } from '../types.js';

type JsonRecord = Record<string, unknown>;

type NativeFlowModel = {
  nodes: Record<string, JsonRecord>;
  modules: Record<string, JsonRecord>;
  connections: Record<string, JsonRecord>;
  annotations: Record<string, JsonRecord>;
  forms: Record<string, JsonRecord>;
  groups: Record<string, JsonRecord>;
  ports: Record<string, JsonRecord>;
  io: Record<string, JsonRecord>;
  description: string;
  webhook: JsonRecord;
  meta: JsonRecord;
  scenes: Record<string, JsonRecord>;
  scenarios: Record<string, JsonRecord>;
  config: JsonRecord;
};

export type FlowDraftRequest = {
  workspaceId: string;
  flowId?: string;
  flowName: string;
  smokeCollectionId: string;
  flow: FlowDefinition;
  resolvedRequests: ResolvedRequest[];
};

type BifrostProxyPayload = {
  service: 'flow';
  method: string;
  path: string;
  body?: unknown;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function idFor(prefix: string, index: number): string {
  return `${prefix}${String(index + 1).padStart(3, '0')}`;
}

function embeddedReference(id: string, key: string): JsonRecord {
  return {
    id,
    type: 'value/reference@2',
    kind: 'reference',
    value: '',
    key,
    __noIn: true
  };
}

function extractRequestId(item: JsonRecord): string | null {
  return String(item.id ?? item.uid ?? item._postman_id ?? '').trim() || null;
}

function jsonPathToTypeScript(jsonPath: string): string {
  if (!jsonPath.startsWith('$.')) {
    return 'response?.body';
  }
  const accessors = jsonPath
    .slice(2)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .map((segment) => (/^\d+$/.test(segment) ? `[${segment}]` : `?.${segment}`))
    .join('');
  return `response?.body${accessors}`;
}

function createRequestNode(
  nodeId: string,
  resolved: ResolvedRequest,
  collectionId: string,
  x: number,
  y: number
): JsonRecord {
  const variables = resolved.step.bindings.map((binding, bindingIndex) =>
    embeddedReference(idFor(`${nodeId}v`, bindingIndex), binding.fieldKey)
  );
  const requestId = extractRequestId(resolved.item);
  return {
    type: 'task/http-request@1',
    pos: { x, y },
    config: {
      element: {
        id: requestId,
        collection: collectionId
      },
      environment: null,
      parseBody: 'auto',
      requestVariables: variables,
      scriptsModifyEnvVars: false,
      requestVariables__expanded: variables.length > 0
    },
    ui: {
      data: {
        blockTitle: resolved.step.name?.trim() || resolved.step.operationId
      },
      namedInputsExpanded: variables.length > 0
    },
    extend: {
      input: Object.fromEntries(variables.map((variable) => [String(variable.id), { extends: 'requestVariables' }])),
      output: {}
    }
  };
}

function createExtractNode(
  nodeId: string,
  variable: string,
  jsonPath: string,
  x: number,
  y: number
): JsonRecord {
  const responseVariableId = `${nodeId}response`;
  return {
    type: 'logic/manipulate@1',
    pos: { x, y },
    size: { width: 304, height: 104 },
    config: {
      language: 'ts',
      query: '',
      tscript: jsonPathToTypeScript(jsonPath),
      variables: [embeddedReference(responseVariableId, 'response')],
      variables__expanded: true
    },
    ui: {
      data: {
        blockTitle: `Extract ${variable}`
      },
      namedInputsExpanded: true
    },
    extend: {
      input: {
        [responseVariableId]: { extends: 'variables' }
      },
      output: {}
    }
  };
}

export function buildNativeFlowDraftModel(flow: FlowDefinition, resolvedRequests: ResolvedRequest[], smokeCollectionId: string): NativeFlowModel {
  const nodes: Record<string, JsonRecord> = {};
  const connections: Record<string, JsonRecord> = {};
  const extractionNodesByVariable = new Map<string, string>();
  const requestNodeIds: string[] = [];

  resolvedRequests.forEach((resolved, index) => {
    const requestNodeId = idFor('req', index);
    requestNodeIds.push(requestNodeId);
    nodes[requestNodeId] = createRequestNode(requestNodeId, resolved, smokeCollectionId, 320 * index, 0);

    if (index > 0) {
      connections[idFor('seq', index - 1)] = {
        source: requestNodeIds[index - 1],
        sourcePort: 'success',
        target: requestNodeId,
        targetPort: '@'
      };
    }

    resolved.step.extract.forEach((extract, extractIndex) => {
      const extractNodeId = idFor(`ext${index + 1}`, extractIndex);
      nodes[extractNodeId] = createExtractNode(extractNodeId, extract.variable, extract.jsonPath, 320 * index + 160, 180);
      extractionNodesByVariable.set(extract.variable, extractNodeId);
      connections[idFor(`rex${index + 1}`, extractIndex)] = {
        source: requestNodeId,
        sourcePort: 'success',
        target: extractNodeId,
        targetPort: `variables|${extractNodeId}response`
      };
    });
  });

  resolvedRequests.forEach((resolved, index) => {
    const requestNodeId = requestNodeIds[index]!;
    resolved.step.bindings.forEach((binding, bindingIndex) => {
      if (binding.source !== 'prior_output' || !binding.variable) {
        return;
      }
      const sourceNodeId = extractionNodesByVariable.get(binding.variable);
      if (!sourceNodeId) {
        return;
      }
      connections[idFor(`bind${index + 1}`, bindingIndex)] = {
        source: sourceNodeId,
        sourcePort: 'out',
        target: requestNodeId,
        targetPort: `requestVariables|${idFor(`${requestNodeId}v`, bindingIndex)}`
      };
    });
  });

  return {
    nodes,
    modules: {},
    connections,
    annotations: {},
    forms: {},
    groups: {},
    ports: {},
    io: {},
    description: `Generated draft for ${flow.name}. Edit this Flow in Postman to refine the smoke journey.`,
    webhook: {
      payloadContent: 'body-only',
      responseType: 'default'
    },
    meta: {},
    scenes: {
      smokeJourney: {
        name: flow.name,
        slides: [
          {
            id: 'slide001',
            name: 'Smoke journey',
            bounds: {
              left: -80,
              top: -160,
              right: Math.max(640, resolvedRequests.length * 320 + 320),
              bottom: 420
            }
          }
        ]
      }
    },
    scenarios: {},
    config: {
      definitions: {},
      constants: {}
    }
  };
}

function extractCreatedFlowId(response: unknown, tempId: string): string {
  const root = asRecord(response);
  const exchange = asRecord(root?.exchange);
  const exchanged = exchange?.[tempId];
  const exchangedRecord = asRecord(exchanged);
  return String(
    exchangedRecord?.id ??
    exchanged ??
    asRecord(root?.flow)?.id ??
    asRecord(root?.resource)?.id ??
    root?.id ??
    ''
  ).trim();
}

function flowUrl(workspaceId: string, flowId: string): string {
  return `https://www.postman.com/workspace/${workspaceId}/flow/${flowId}`;
}

export class PostmanFlowClient {
  constructor(
    private readonly accessToken: string,
    private readonly teamId = '',
    private readonly bifrostBaseUrl = 'https://bifrost-premium-https-v4.gw.postman.com',
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async proxy(payload: BifrostProxyPayload): Promise<unknown> {
    const response = await this.fetchImpl(`${this.bifrostBaseUrl.replace(/\/+$/g, '')}/ws/proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-access-token': this.accessToken,
        ...(this.teamId ? { 'x-entity-team-id': this.teamId } : {})
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw await HttpError.fromResponse(response, `${this.bifrostBaseUrl}/ws/proxy`, 'POST');
    }
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async createOrUpdateDraft(request: FlowDraftRequest): Promise<FlowDraftSummary> {
    const model = buildNativeFlowDraftModel(request.flow, request.resolvedRequests, request.smokeCollectionId);
    const warnings = request.resolvedRequests
      .filter((resolved) => !extractRequestId(resolved.item))
      .map((resolved) => `Could not find a stable request id for ${resolved.step.operationId}; the draft request block may need manual relinking.`);

    if (!request.flowId) {
      const tempId = `tmp-${randomUUID()}`;
      const response = await this.proxy({
        service: 'flow',
        method: 'post',
        path: `/flows/workspace/${request.workspaceId}/add?v=2`,
        body: {
          ids: [tempId],
          defaults: {
            [tempId]: {
              attributes: {
                name: request.flowName,
                type: 'module'
              },
              ...model
            }
          }
        }
      });
      const flowId = extractCreatedFlowId(response, tempId);
      if (!flowId) {
        throw new Error('Flow creation did not return a Flow ID.');
      }
      return {
        status: 'created',
        flowId,
        flowUrl: flowUrl(request.workspaceId, flowId),
        nodeCount: Object.keys(model.nodes).length,
        connectionCount: Object.keys(model.connections).length,
        warnings
      };
    }

    const clientId = randomUUID();
    const shadowResponse = asRecord(await this.proxy({
      service: 'flow',
      method: 'get',
      path: `/flow/${request.flowId}/shadow?client=${clientId}&v=2`
    }));
    const shadow = asRecord(shadowResponse?.shadow) ?? asRecord(asRecord(shadowResponse?.data)?.shadow);
    const shadowId = String(shadow?.id ?? shadowResponse?.shadowId ?? '').trim();
    if (!shadowId) {
      throw new Error(`Could not acquire Flow shadow for ${request.flowId}.`);
    }

    await this.proxy({
      service: 'flow',
      method: 'patch',
      path: `/flow/${request.flowId}/shadow/${shadowId}`,
      body: {
        cv: Number(shadow?.cv ?? 0),
        sv: Number(shadow?.sv ?? 0),
        patch: Object.entries(model).map(([key, value]) => ({
          op: 'add',
          path: `/${key}`,
          value
        }))
      }
    });

    return {
      status: 'updated',
      flowId: request.flowId,
      flowUrl: flowUrl(request.workspaceId, request.flowId),
      nodeCount: Object.keys(model.nodes).length,
      connectionCount: Object.keys(model.connections).length,
      warnings
    };
  }
}
