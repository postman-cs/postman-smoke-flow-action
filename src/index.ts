import * as core from '@actions/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { customerPreviewActionContract } from './contracts.js';
import { loadFlowManifest } from './flow/parser.js';
import { resolveFlowRequests } from './flow/resolver.js';
import { validateFlowManifest } from './flow/validator.js';
import { summarizeError } from './lib/logging.js';
import type { ActionInputs, ActionOutputs, CoreLike, FlowApplySummary, SmokeAuthConfig } from './types.js';
import { buildCuratedSmokeCollection } from './postman/collection-transform.js';
import { PostmanSmokeClient } from './postman/postman-smoke-client.js';

type SmokeFlowDependencies = {
  core: CoreLike;
  postman: Pick<PostmanSmokeClient, 'generateCollection' | 'getCollection' | 'updateCollection' | 'deleteCollection'>;
};

function parseBooleanInput(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function getInput(name: string, env: NodeJS.ProcessEnv): string {
  const canonicalEnvName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const legacyEnvName = `INPUT_${name.replace(/ /g, '_').replace(/-/g, '_').toUpperCase()}`;
  return String(env[canonicalEnvName] ?? env[legacyEnvName] ?? '').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseAuthConfig(value: string): SmokeAuthConfig | undefined {
  if (!value.trim()) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid auth-config-json: ${summarizeError(error)}`, { cause: error });
  }

  if (!isRecord(parsed)) {
    throw new Error('Invalid auth-config-json: expected a JSON object.');
  }

  if (parsed.enabled !== true) {
    return undefined;
  }
  if (parsed.type !== 'oauth2') {
    throw new Error('Invalid auth-config-json: only type=oauth2 is supported.');
  }
  if (parsed.grantType !== 'client_credentials') {
    throw new Error('Invalid auth-config-json: only grantType=client_credentials is supported.');
  }
  if (parsed.clientAuthentication !== 'body') {
    throw new Error('Invalid auth-config-json: only clientAuthentication=body is supported.');
  }
  if (typeof parsed.tokenUrl !== 'string' || !parsed.tokenUrl.trim()) {
    throw new Error('Invalid auth-config-json: tokenUrl is required.');
  }

  return parsed as SmokeAuthConfig;
}

export function readActionInputs(env: NodeJS.ProcessEnv = process.env): ActionInputs {
  return {
    projectName: getInput('project-name', env),
    workspaceId: getInput('workspace-id', env),
    specId: getInput('spec-id', env),
    smokeCollectionId: getInput('smoke-collection-id', env),
    flowPath: getInput('flow-path', env),
    postmanApiKey: getInput('postman-api-key', env),
    authConfig: parseAuthConfig(getInput('auth-config-json', env)),
    secretsResolverEnabled: parseBooleanInput(getInput('secrets-resolver-enabled', env), true),
    specPath: getInput('spec-path', env) || undefined,
    debugDumpPath: getInput('debug-dump-path', env) || undefined,
    collectionSyncMode: (getInput('collection-sync-mode', env) || 'refresh') as 'refresh' | 'version',
    postmanAccessToken: getInput('postman-access-token', env) || undefined,
    failOnFlowWarning: parseBooleanInput(getInput('fail-on-flow-warning', env), false),
    keepTempCollectionOnFailure: parseBooleanInput(getInput('keep-temp-collection-on-failure', env), false),
    tempCollectionPrefix: getInput('temp-collection-prefix', env) || '[Smoke][Temp]'
  };
}

function writeDebugDump(debugDumpPath: string | undefined, collection: unknown, actionCore: CoreLike): void {
  if (!debugDumpPath) {
    return;
  }

  const resolvedPath = path.isAbsolute(debugDumpPath)
    ? debugDumpPath
    : path.resolve(process.cwd(), debugDumpPath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
  actionCore.info(`Wrote transformed collection debug dump to ${resolvedPath}`);
}

function ensureRequiredInputs(inputs: ActionInputs): void {
  for (const [name, details] of Object.entries(customerPreviewActionContract.inputs)) {
    if (details.required) {
      const camel = name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      const value = inputs[camel as keyof ActionInputs];
      if (!value) {
        throw new Error(`Missing required input: ${name}`);
      }
    }
  }
}

function createOutputs(summary: FlowApplySummary): ActionOutputs {
  return {
    'smoke-collection-id': summary.canonicalSmokeCollectionId,
    'flow-apply-status': summary.status,
    'flow-apply-summary-json': JSON.stringify(summary),
    'temporary-smoke-collection-id': summary.temporaryCollectionId ?? '',
    'flow-step-count': String(summary.stepCount),
    'resolved-operation-count': String(summary.resolvedOperationCount),
    'applied-binding-count': String(summary.appliedBindingCount),
    'applied-extract-count': String(summary.appliedExtractCount),
    'assertion-count': String(summary.assertionCount)
  };
}

export async function runSmokeFlow(
  inputs: ActionInputs,
  dependencies: SmokeFlowDependencies
): Promise<ActionOutputs> {
  ensureRequiredInputs(inputs);
  if (inputs.collectionSyncMode !== 'refresh') {
    throw new Error(`collection-sync-mode=refresh is the only supported mode for postman-smoke-flow-action; received ${inputs.collectionSyncMode}.`);
  }

  const manifest = loadFlowManifest(inputs.flowPath);
  const { flow, warnings } = validateFlowManifest(manifest);
  const flowName = flow.name;
  warnings.forEach((warning) => dependencies.core.warning(warning.message));
  if (warnings.length > 0 && inputs.failOnFlowWarning) {
    throw new Error(`Flow validation produced ${warnings.length} warning(s) and fail-on-flow-warning=true.`);
  }

  let tempCollectionId = '';
  let tempCollectionDeleted = false;
  let runFailed = false;
  try {
    tempCollectionId = await dependencies.postman.generateCollection(inputs.specId, inputs.projectName, inputs.tempCollectionPrefix);
    dependencies.core.info(`Generated temporary Smoke collection ${tempCollectionId}`);

    const generatedCollection = await dependencies.postman.getCollection(tempCollectionId);
    const resolvedRequests = resolveFlowRequests(flow, generatedCollection, inputs.specPath);
    const transformed = buildCuratedSmokeCollection(
      generatedCollection,
      flow,
      resolvedRequests,
      inputs.authConfig,
      inputs.secretsResolverEnabled
    );
    writeDebugDump(inputs.debugDumpPath, transformed.collection, dependencies.core);
    await dependencies.postman.updateCollection(inputs.smokeCollectionId, transformed.collection);
    dependencies.core.info(`Updated canonical Smoke collection ${inputs.smokeCollectionId} from curated flow.`);

    const summary: FlowApplySummary = {
      flowName: flow.name,
      status: 'success',
      temporaryCollectionId: tempCollectionId,
      canonicalSmokeCollectionId: inputs.smokeCollectionId,
      stepCount: flow.steps.length,
      resolvedOperationCount: resolvedRequests.length,
      appliedBindingCount: transformed.bindingCount,
      appliedExtractCount: transformed.extractCount,
      assertionCount: transformed.assertionCount,
      warnings: warnings.map((warning) => warning.message)
    };

    return createOutputs(summary);
  } catch (error) {
    runFailed = true;
    const summary: FlowApplySummary = {
      flowName,
      status: 'failed',
      temporaryCollectionId: tempCollectionId || undefined,
      canonicalSmokeCollectionId: inputs.smokeCollectionId,
      stepCount: 0,
      resolvedOperationCount: 0,
      appliedBindingCount: 0,
      appliedExtractCount: 0,
      assertionCount: 0,
      warnings: [...warnings.map((warning) => warning.message), summarizeError(error)]
    };
    if (tempCollectionId && !inputs.keepTempCollectionOnFailure) {
      try {
        await dependencies.postman.deleteCollection(tempCollectionId);
        tempCollectionDeleted = true;
      } catch (cleanupError) {
        dependencies.core.warning(`Failed to delete temporary Smoke collection ${tempCollectionId}: ${summarizeError(cleanupError)}`);
      }
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      summary
    });
  } finally {
    const shouldDeleteInFinally =
      tempCollectionId &&
      !tempCollectionDeleted &&
      !(runFailed && inputs.keepTempCollectionOnFailure);
    if (shouldDeleteInFinally) {
      try {
        await dependencies.postman.deleteCollection(tempCollectionId);
        dependencies.core.info(`Deleted temporary Smoke collection ${tempCollectionId}`);
      } catch (cleanupError) {
        if (!inputs.keepTempCollectionOnFailure) {
          dependencies.core.warning(`Failed to delete temporary Smoke collection ${tempCollectionId}: ${summarizeError(cleanupError)}`);
        }
      }
    }
  }
}

export async function runAction(actionCore: CoreLike = core, env: NodeJS.ProcessEnv = process.env): Promise<ActionOutputs> {
  const inputs = readActionInputs(env);
  const postman = new PostmanSmokeClient(inputs.postmanApiKey);
  const outputs = await runSmokeFlow(inputs, {
    core: actionCore,
    postman
  });
  for (const [name, value] of Object.entries(outputs)) {
    actionCore.setOutput(name, value);
  }
  return outputs;
}
