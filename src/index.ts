import * as core from '@actions/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { smokeFlowActionContract } from './contracts.js';
import { loadFlowManifest } from './flow/parser.js';
import { resolveFlowRequests } from './flow/resolver.js';
import { validateFlowManifest } from './flow/validator.js';
import { summarizeError } from './lib/logging.js';
import { createSecretMasker } from './lib/secrets.js';
import type { ActionInputs, ActionOutputs, CoreLike, FlowApplySummary, SmokeAuthConfig } from './types.js';
import {
  buildCuratedSmokeCollection,
  buildGeneratedSmokeCollection,
  verifyCuratedSmokeCollection,
  verifyGeneratedSmokeCollection,
  type CollectionVerification
} from './postman/collection-transform.js';
import type { SmokeCollectionClient } from './postman/smoke-client-contract.js';
import { PostmanGatewaySmokeClient } from './postman/postman-gateway-smoke-client.js';
import { AccessTokenProvider } from './lib/postman/token-provider.js';
import {
  getMemoizedSessionIdentity,
  runCredentialPreflight
} from './postman/credential-identity.js';
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';
import { resolveActionVersion } from './action-version.js';

type JsonRecord = Record<string, unknown>;

type SmokeFlowDependencies = {
  core: CoreLike;
  postman: SmokeCollectionClient;
  sleep?: (ms: number) => Promise<void>;
};

const STABLE_COLLECTION_UPDATE_MAX_ATTEMPTS = 6;
const STABLE_COLLECTION_UPDATE_VERIFY_COUNT = 3;
const STABLE_COLLECTION_UPDATE_VERIFY_DELAY_MS = 5000;

type CollectionTransformResult = {
  collection: JsonRecord;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseBooleanInput(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function resolvePostmanApiBaseUrl(regionInput: string): string {
  const region = String(regionInput || 'us').trim().toLowerCase();
  if (region === 'us') return 'https://api.getpostman.com';
  if (region === 'eu') return 'https://api.eu.postman.com';
  throw new Error(`postman-region must be one of: us, eu; got: ${region}`);
}

/** iapub serves the session-identity probe globally; it is region-independent. */
function resolvePostmanIapubBaseUrl(regionInput: string): string {
  // Validate the region for parity with the API base resolver, then return the
  // shared identity-pub host used for both us and eu.
  resolvePostmanApiBaseUrl(regionInput);
  return 'https://iapub.postman.co';
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
  if (parsed.type === 'oauth2') {
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

  if (parsed.type === 'apiKey') {
    if (parsed.in !== 'header' && parsed.in !== 'query') {
      throw new Error('Invalid auth-config-json: apiKey in must be one of: header, query.');
    }
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
      throw new Error('Invalid auth-config-json: apiKey name is required.');
    }
    const variables = isRecord(parsed.variables) ? parsed.variables : undefined;
    if (variables?.apiKey !== undefined && (typeof variables.apiKey !== 'string' || !variables.apiKey.trim())) {
      throw new Error('Invalid auth-config-json: apiKey variables.apiKey must be a non-empty string when provided.');
    }
    return parsed as SmokeAuthConfig;
  }

  throw new Error('Invalid auth-config-json: supported auth types are oauth2 and apiKey.');
}

export function readActionInputs(env: NodeJS.ProcessEnv = process.env): ActionInputs {
  return {
    projectName: getInput('project-name', env),
    workspaceId: getInput('workspace-id', env),
    specId: getInput('spec-id', env),
    smokeCollectionId: getInput('smoke-collection-id', env),
    flowPath: getInput('flow-path', env) || undefined,
    postmanApiKey: getInput('postman-api-key', env),
    postmanApiBaseUrl: resolvePostmanApiBaseUrl(getInput('postman-region', env)),
    postmanIapubBaseUrl: resolvePostmanIapubBaseUrl(getInput('postman-region', env)),
    authConfig: parseAuthConfig(getInput('auth-config-json', env)),
    secretsResolverEnabled: parseBooleanInput(getInput('secrets-resolver-enabled', env), true),
    specPath: getInput('spec-path', env) || undefined,
    debugDumpPath: getInput('debug-dump-path', env) || undefined,
    collectionSyncMode: (getInput('collection-sync-mode', env) || 'refresh') as 'refresh' | 'version',
    postmanAccessToken: getInput('postman-access-token', env) || undefined,
    failOnFlowWarning: parseBooleanInput(getInput('fail-on-flow-warning', env), false),
    keepTempCollectionOnFailure: parseBooleanInput(getInput('keep-temp-collection-on-failure', env), false),
    tempCollectionPrefix: getInput('temp-collection-prefix', env) || '[Smoke][Temp]',
    teamId: getInput('team-id', env) || env.POSTMAN_TEAM_ID || undefined
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

async function verifyCanonicalCollectionIsStable(
  collectionId: string,
  dependencies: SmokeFlowDependencies,
  verifyCollection: (collection: JsonRecord) => CollectionVerification
): Promise<{ stable: boolean; latestCollection: JsonRecord; verification: CollectionVerification }> {
  const sleepImpl = dependencies.sleep ?? sleep;
  let latestCollection: JsonRecord | undefined;
  let latestVerification: CollectionVerification = {
    ok: false,
    summary: 'collection was not verified'
  };

  for (let checkIndex = 0; checkIndex < STABLE_COLLECTION_UPDATE_VERIFY_COUNT; checkIndex += 1) {
    await sleepImpl(STABLE_COLLECTION_UPDATE_VERIFY_DELAY_MS);
    latestCollection = await dependencies.postman.getCollection(collectionId);
    latestVerification = verifyCollection(latestCollection);
    if (!latestVerification.ok) {
      return {
        stable: false,
        latestCollection,
        verification: latestVerification
      };
    }
  }

  if (!latestCollection) {
    latestCollection = await dependencies.postman.getCollection(collectionId);
    latestVerification = verifyCollection(latestCollection);
  }

  return {
    stable: latestVerification.ok,
    latestCollection,
    verification: latestVerification
  };
}

async function updateCanonicalCollectionUntilStable<T extends CollectionTransformResult>(options: {
  inputs: ActionInputs;
  dependencies: SmokeFlowDependencies;
  initialSourceCollection: JsonRecord;
  buildCollection: (sourceCollection: JsonRecord) => T;
  verifyCollection: (collection: JsonRecord) => CollectionVerification;
  refreshSourceFromLatest?: boolean;
}): Promise<T> {
  let sourceCollection = options.initialSourceCollection;
  let latestVerification: CollectionVerification = {
    ok: false,
    summary: 'collection was not verified'
  };

  for (let attempt = 1; attempt <= STABLE_COLLECTION_UPDATE_MAX_ATTEMPTS; attempt += 1) {
    const transformed = options.buildCollection(sourceCollection);
    writeDebugDump(options.inputs.debugDumpPath, transformed.collection, options.dependencies.core);
    await options.dependencies.postman.updateCollection(options.inputs.smokeCollectionId, transformed.collection);

    const stability = await verifyCanonicalCollectionIsStable(
      options.inputs.smokeCollectionId,
      options.dependencies,
      options.verifyCollection
    );
    latestVerification = stability.verification;
    if (stability.stable) {
      if (attempt > 1) {
        options.dependencies.core.info(
          `Canonical Smoke collection update persisted after ${attempt} attempt(s): ${latestVerification.summary}.`
        );
      }
      return transformed;
    }

    sourceCollection = options.refreshSourceFromLatest === false ? options.initialSourceCollection : stability.latestCollection;
    if (attempt < STABLE_COLLECTION_UPDATE_MAX_ATTEMPTS) {
      options.dependencies.core.warning(
        `Canonical Smoke collection update was not stable after attempt ${attempt}: ${latestVerification.summary}. Reapplying to the latest collection.`
      );
    }
  }

  throw new Error(
    `Canonical Smoke collection update did not persist after ${STABLE_COLLECTION_UPDATE_MAX_ATTEMPTS} attempt(s): ${latestVerification.summary}.`
  );
}

function ensureRequiredInputs(inputs: ActionInputs): void {
  for (const [name, details] of Object.entries(smokeFlowActionContract.inputs)) {
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

function describeAuthConfig(authConfig: SmokeAuthConfig): string {
  return authConfig.type === 'apiKey' ? 'API key' : 'OAuth';
}

function getCollectionName(collection: JsonRecord): string | undefined {
  const info = isRecord(collection.info) ? collection.info : undefined;
  const name = typeof info?.name === 'string' ? info.name.trim() : '';
  return name || undefined;
}

async function runWithoutFlowManifest(
  inputs: ActionInputs,
  dependencies: SmokeFlowDependencies
): Promise<ActionOutputs> {
  const authApplied = Boolean(inputs.authConfig?.enabled);
  let tempCollectionId = '';
  let tempCollectionDeleted = false;
  let runFailed = false;
  const warnings = [
    authApplied
      ? `flow-path was not provided; refreshed canonical Smoke collection from the generated spec collection and applied ${describeAuthConfig(inputs.authConfig!)} auth without flow curation.`
      : 'flow-path was not provided; refreshed canonical Smoke collection from the generated spec collection without flow curation.'
  ];

  try {
    const existingCollection = await dependencies.postman.getCollection(inputs.smokeCollectionId);
    const canonicalCollectionName = getCollectionName(existingCollection);
    tempCollectionId = await dependencies.postman.generateCollection(inputs.specId, inputs.projectName, inputs.tempCollectionPrefix);
    dependencies.core.info(`Generated temporary Smoke collection ${tempCollectionId}`);

    const generatedCollection = await dependencies.postman.getCollection(tempCollectionId);
    const transformed = await updateCanonicalCollectionUntilStable({
      inputs,
      dependencies,
      initialSourceCollection: generatedCollection,
      refreshSourceFromLatest: false,
      buildCollection: (sourceCollection) =>
        buildGeneratedSmokeCollection(sourceCollection, inputs.authConfig, {
          secretsResolverEnabled: inputs.secretsResolverEnabled,
          collectionName: canonicalCollectionName,
          scriptSourceCollection: existingCollection
        }),
      verifyCollection: (collection) =>
        verifyGeneratedSmokeCollection(collection, inputs.authConfig, {
          secretsResolverEnabled: inputs.secretsResolverEnabled
        })
    });

    const authDescription = authApplied ? ` with Smoke ${describeAuthConfig(inputs.authConfig!)} auth on ${transformed.authRequestCount} request(s)` : '';
    dependencies.core.info(
      `Updated canonical Smoke collection ${inputs.smokeCollectionId} from generated spec collection${authDescription}.`
    );

    return createOutputs({
      flowName: '',
      status: 'success',
      temporaryCollectionId: tempCollectionId,
      canonicalSmokeCollectionId: inputs.smokeCollectionId,
      authApplied,
      authRequestCount: transformed.authRequestCount,
      stepCount: 0,
      resolvedOperationCount: 0,
      appliedBindingCount: 0,
      appliedExtractCount: 0,
      assertionCount: 0,
      warnings
    });
  } catch (error) {
    runFailed = true;
    const summary: FlowApplySummary = {
      flowName: '',
      status: 'failed',
      temporaryCollectionId: tempCollectionId || undefined,
      canonicalSmokeCollectionId: inputs.smokeCollectionId,
      authApplied,
      authRequestCount: 0,
      stepCount: 0,
      resolvedOperationCount: 0,
      appliedBindingCount: 0,
      appliedExtractCount: 0,
      assertionCount: 0,
      warnings: [...warnings, summarizeError(error)]
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

export async function runSmokeFlow(
  inputs: ActionInputs,
  dependencies: SmokeFlowDependencies
): Promise<ActionOutputs> {
  if (inputs.postmanApiKey) {
    dependencies.core.setSecret?.(inputs.postmanApiKey);
  }
  if (inputs.postmanAccessToken) {
    dependencies.core.setSecret?.(inputs.postmanAccessToken);
  }
  ensureRequiredInputs(inputs);
  if (inputs.collectionSyncMode !== 'refresh') {
    throw new Error(`collection-sync-mode=refresh is the only supported mode for postman-smoke-flow-action; received ${inputs.collectionSyncMode}.`);
  }

  const flowPath = inputs.flowPath?.trim();
  if (!flowPath) {
    return runWithoutFlowManifest(inputs, dependencies);
  }

  const manifest = loadFlowManifest(flowPath);
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
    const transformed = await updateCanonicalCollectionUntilStable({
      inputs,
      dependencies,
      initialSourceCollection: generatedCollection,
      buildCollection: (sourceCollection) => {
        const resolvedRequests = resolveFlowRequests(flow, sourceCollection, inputs.specPath);
        return buildCuratedSmokeCollection(
          sourceCollection,
          flow,
          resolvedRequests,
          inputs.authConfig,
          inputs.secretsResolverEnabled
        );
      },
      verifyCollection: (collection) =>
        verifyCuratedSmokeCollection(collection, flow, inputs.authConfig, {
          secretsResolverEnabled: inputs.secretsResolverEnabled
        })
    });
    dependencies.core.info(`Updated canonical Smoke collection ${inputs.smokeCollectionId} from curated flow.`);

    const resolvedRequests = resolveFlowRequests(flow, generatedCollection, inputs.specPath);

    const summary: FlowApplySummary = {
      flowName: flow.name,
      status: 'success',
      temporaryCollectionId: tempCollectionId,
      canonicalSmokeCollectionId: inputs.smokeCollectionId,
      authApplied: Boolean(inputs.authConfig?.enabled),
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
      authApplied: Boolean(inputs.authConfig?.enabled),
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

/**
 * Build the Smoke collection client. The reshape runs access-token-only through
 * the gateway (`PostmanGatewaySmokeClient`): generate via the specification
 * service, read via `GET /v3/collections/:cid/export`, and apply the curated
 * reshape via v3 per-item create/patch + a collection-level patch — no PMAK.
 * A postman-api-key, when present, is only the AccessTokenProvider re-mint
 * credential (service-account access tokens expire); it is never used for the
 * collection mutation itself.
 */
function createSmokeClient(
  inputs: ActionInputs,
  actionCore: CoreLike
): SmokeCollectionClient {
  const accessToken = String(inputs.postmanAccessToken ?? '').trim();
  if (!accessToken) {
    throw new Error(
      'postman-access-token is required: the Smoke collection reshape runs access-token-only through ' +
        'the Postman gateway. Mint one with postman-resolve-service-token-action and pass it as ' +
        'postman-access-token (postman-api-key alone no longer drives the reshape).'
    );
  }
  const provider = new AccessTokenProvider({
    accessToken,
    apiKey: inputs.postmanApiKey || undefined,
    apiBaseUrl: inputs.postmanApiBaseUrl,
    onToken: (token) => actionCore.setSecret?.(token)
  });
  const teamId = String(inputs.teamId ?? '').trim();
  return new PostmanGatewaySmokeClient({
    tokenProvider: provider,
    ...(teamId ? { teamId, orgMode: true } : {})
  });
}

export async function runAction(actionCore: CoreLike = core, env: NodeJS.ProcessEnv = process.env): Promise<ActionOutputs> {
  const inputs = readActionInputs(env);
  const telemetry = createTelemetryContext({ action: 'postman-smoke-flow-action', actionVersion: resolveActionVersion(), logger: actionCore });
  telemetry.setTeamId(inputs.teamId);
  if (inputs.postmanApiKey) {
    actionCore.setSecret?.(inputs.postmanApiKey);
  }
  if (inputs.postmanAccessToken) {
    actionCore.setSecret?.(inputs.postmanAccessToken);
  }
  await runCredentialPreflight({
    apiBaseUrl: inputs.postmanApiBaseUrl,
    iapubBaseUrl: inputs.postmanIapubBaseUrl,
    postmanApiKey: inputs.postmanApiKey,
    postmanAccessToken: inputs.postmanAccessToken,
    explicitTeamId: inputs.teamId || undefined,
    mode: 'warn',
    mask: createSecretMasker([inputs.postmanApiKey, inputs.postmanAccessToken]),
    log: actionCore
  });
  try {
    const postman = createSmokeClient(inputs, actionCore);
    const outputs = await runSmokeFlow(inputs, {
      core: actionCore,
      postman
    });
    for (const [name, value] of Object.entries(outputs)) {
      actionCore.setOutput(name, value);
    }
    telemetry.setAccountType(getMemoizedSessionIdentity()?.consumerType);
    telemetry.emitCompletion('success');
    return outputs;
  } catch (error) {
    telemetry.setAccountType(getMemoizedSessionIdentity()?.consumerType);
    telemetry.emitCompletion('failure');
    throw error;
  }
}
