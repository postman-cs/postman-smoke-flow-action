import * as core from '@actions/core';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { smokeFlowActionContract } from './contracts.js';
import { loadFlowManifest } from './flow/parser.js';
import { resolveFlowRequests } from './flow/resolver.js';
import { validateFlowManifest } from './flow/validator.js';
import { stringifyFlowManifest } from './flow/serializer.js';
import { deriveFlowFromSpecPath, type DerivedFlowResult } from './flow/derive.js';
import { summarizeError } from './lib/logging.js';
import { createMutableSecretMasker, createSecretMasker, type SecretMasker } from './lib/secrets.js';
import { workspaceFileExists, writeWorkspaceFileExclusive } from './lib/paths.js';
import type { ActionInputs, ActionOutputs, CoreLike, FlowApplySummary, FlowDefinition, SmokeAuthConfig } from './types.js';
import {
  buildCuratedSmokeCollection,
  buildGeneratedSmokeCollection,
  verifyCuratedSmokeCollection,
  verifyGeneratedSmokeCollection,
  type CollectionVerification
} from './postman/collection-transform.js';
import type { SmokeCollectionClient } from './postman/smoke-client-contract.js';
import { PostmanGatewaySmokeClient } from './postman/postman-gateway-smoke-client.js';
import { AccessTokenProvider, mintAccessTokenIfNeeded } from './lib/postman/token-provider.js';
import { applyEndpointOverrides } from './lib/postman/base-urls.js';
import {
  getMemoizedSessionIdentity,
  runCredentialPreflight
} from './postman/credential-identity.js';
import {
  BRANCH_DECISION_ENV,
  parseChannelRules,
  resolveBranchIdentity,
  resolveEffectiveBranchDecision,
  serializeBranchDecision,
  type BranchDecision,
  type BranchStrategy
} from './lib/repo-branch-decision.js';
import {
  actionSink,
  createLogger,
  createTelemetryContext,
  parseSecretsResolverProvider,
  type Logger
} from '@postman-cse/automation-core';
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

function createInputSecretMasker(inputs: ActionInputs): SecretMasker {
  return createSecretMasker([inputs.postmanApiKey, inputs.postmanAccessToken]);
}

function formatTemporaryCollectionCleanupWarning(
  tempCollectionId: string,
  cleanupError: unknown,
  mask: SecretMasker
): string {
  const cause = mask(summarizeError(cleanupError));
  return (
    `Failed to delete temporary Smoke collection ${tempCollectionId}: ${cause}. ` +
    `The temporary collection remains; delete collection ${tempCollectionId} after verifying collection-delete permission, or rerun cleanup after permissions recover.`
  );
}

function parseBooleanInput(
  name: string,
  value: string | undefined,
  defaultValue: boolean
): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value for ${name}: ${value}`);
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
  // GitHub runner form preserves hyphens: INPUT_PROJECT-NAME
  const runnerEnvName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  // Normalized/CLI form replaces hyphens: INPUT_PROJECT_NAME
  const normalizedEnvName = `INPUT_${name.replace(/ /g, '_').replace(/-/g, '_').toUpperCase()}`;
  const hasRunner = Object.prototype.hasOwnProperty.call(env, runnerEnvName);
  const hasNormalized = Object.prototype.hasOwnProperty.call(env, normalizedEnvName);

  if (runnerEnvName !== normalizedEnvName && hasRunner && hasNormalized) {
    const runnerValue = String(env[runnerEnvName] ?? '').trim();
    const normalizedValue = String(env[normalizedEnvName] ?? '').trim();
    if (runnerValue !== normalizedValue) {
      throw new Error(
        `Conflicting values for input ${name}: both ${runnerEnvName} and ${normalizedEnvName} are set differently.`
      );
    }
  }

  const raw = hasRunner ? env[runnerEnvName] : hasNormalized ? env[normalizedEnvName] : undefined;
  return String(raw ?? '').trim();
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
  const endpoints = applyEndpointOverrides(
    {
      apiBaseUrl: resolvePostmanApiBaseUrl(getInput('postman-region', env)),
      iapubBaseUrl: resolvePostmanIapubBaseUrl(getInput('postman-region', env))
    },
    env
  );
  return {
    projectName: getInput('project-name', env),
    workspaceId: getInput('workspace-id', env),
    specId: getInput('spec-id', env),
    smokeCollectionId: getInput('smoke-collection-id', env),
    flowPath: getInput('flow-path', env) || undefined,
    flowMode: parseFlowMode(getInput('flow-mode', env)),
    flowAllowDelete: parseBooleanInput(
      'flow-allow-delete',
      getInput('flow-allow-delete', env),
      false
    ),
    postmanApiKey: getInput('postman-api-key', env) || env.POSTMAN_API_KEY || '',
    postmanApiBaseUrl: endpoints.apiBaseUrl,
    postmanIapubBaseUrl: endpoints.iapubBaseUrl,
    authConfig: parseAuthConfig(getInput('auth-config-json', env)),
    // Opt-in provider selection. The legacy boolean input is still honoured
    // (`true` -> the historical AWS helper) so existing callers keep working.
    secretsResolverProvider: parseSecretsResolverProvider(
      getInput('secrets-resolver', env) || getInput('secrets-resolver-enabled', env)
    ),
    specPath: getInput('spec-path', env) || undefined,
    debugDumpPath: getInput('debug-dump-path', env) || undefined,
    collectionSyncMode: (getInput('collection-sync-mode', env) || 'refresh') as 'refresh' | 'version',
    postmanAccessToken: getInput('postman-access-token', env) || env.POSTMAN_ACCESS_TOKEN || undefined,
    failOnFlowWarning: parseBooleanInput(
      'fail-on-flow-warning',
      getInput('fail-on-flow-warning', env),
      false
    ),
    keepTempCollectionOnFailure: parseBooleanInput(
      'keep-temp-collection-on-failure',
      getInput('keep-temp-collection-on-failure', env),
      false
    ),
    tempCollectionPrefix: getInput('temp-collection-prefix', env) || '[Smoke][Temp]',
    persistDerivedFlow: parseBooleanInput(
      'persist-derived-flow',
      getInput('persist-derived-flow', env),
      true
    ),
    teamId: getInput('team-id', env) || env.POSTMAN_TEAM_ID || undefined,
    branchStrategy: getInput('branch-strategy', env) || 'legacy',
    canonicalBranch: getInput('canonical-branch', env) || undefined,
    channels: getInput('channels', env) || undefined
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
          `Canonical Smoke collection update for ${options.inputs.smokeCollectionId} persisted after ${attempt} attempt(s): ${latestVerification.summary}.`
        );
      }
      return transformed;
    }

    sourceCollection = options.refreshSourceFromLatest === false ? options.initialSourceCollection : stability.latestCollection;
    if (attempt < STABLE_COLLECTION_UPDATE_MAX_ATTEMPTS) {
      options.dependencies.core.warning(
        `Canonical Smoke collection update for ${options.inputs.smokeCollectionId} was not stable after attempt ${attempt}: ${latestVerification.summary}. Automatically reapplying the update.`
      );
    }
  }

  throw new Error(
    `Canonical Smoke collection update for ${options.inputs.smokeCollectionId} did not persist after ${STABLE_COLLECTION_UPDATE_MAX_ATTEMPTS} attempt(s): ${latestVerification.summary}. Fix the reported verification mismatch; if another sync is overwriting collection ${options.inputs.smokeCollectionId}, stop or serialize that sync before rerunning.`
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

export function validateInputsBeforeSideEffects(inputs: ActionInputs): void {
  ensureRequiredInputs(inputs);
  if (inputs.collectionSyncMode !== 'refresh') {
    throw new Error(
      `collection-sync-mode=refresh is the only supported mode for postman-smoke-flow-action; received ${inputs.collectionSyncMode}.`
    );
  }

  const flowPath = inputs.flowPath?.trim();
  if (inputs.flowMode === 'off') {
    if (flowPath) {
      throw new Error('flow-mode=off cannot be combined with flow-path; remove one of them.');
    }
    return;
  }
  if (inputs.flowMode === 'curated' && !flowPath) {
    throw new Error('flow-mode=curated requires flow-path to point at a flow.yaml manifest.');
  }

  const effectiveFlowPath = flowPath || DEFAULT_FLOW_PATH;
  const manifestExists = workspaceFileExists(effectiveFlowPath, 'flow-path');
  if (!manifestExists) {
    if (inputs.flowMode === 'curated') {
      throw new Error(`flow-mode=curated requires flow-path to reference an existing flow.yaml manifest; received ${effectiveFlowPath}.`);
    }
    return;
  }
  const { warnings } = validateFlowManifest(loadFlowManifest(effectiveFlowPath));
  if (warnings.length > 0 && inputs.failOnFlowWarning) {
    throw new Error(`Flow validation produced ${warnings.length} warning(s) and fail-on-flow-warning=true.`);
  }
}

function createOutputs(summary: FlowApplySummary, derivedFlowPath?: string): ActionOutputs {
  const envDecision = process.env[BRANCH_DECISION_ENV];
  return {
    'smoke-collection-id': summary.canonicalSmokeCollectionId,
    'flow-apply-status': summary.status,
    'flow-apply-summary-json': JSON.stringify(summary),
    'temporary-smoke-collection-id': summary.temporaryCollectionId ?? '',
    'flow-step-count': String(summary.stepCount),
    'resolved-operation-count': String(summary.resolvedOperationCount),
    'applied-binding-count': String(summary.appliedBindingCount),
    'applied-extract-count': String(summary.appliedExtractCount),
    'assertion-count': String(summary.assertionCount),
    'derived-flow-path': derivedFlowPath ?? '',
    'sync-status': summary.status === 'skipped' ? 'skipped-branch-gate' : 'synced',
    'branch-decision': envDecision ?? ''
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
  dependencies: SmokeFlowDependencies,
  extraWarnings: string[] = []
): Promise<ActionOutputs> {
  extraWarnings.forEach((message) => dependencies.core.warning(message));
  // fail-on-flow-warning gates BEFORE any Postman mutation: a derivation
  // fallback warning must never be followed by a destructive uncurated refresh.
  if (extraWarnings.length > 0 && inputs.failOnFlowWarning) {
    throw new Error(
      `Flow derivation produced ${extraWarnings.length} warning(s) and fail-on-flow-warning=true; refusing the uncurated canonical Smoke refresh.`
    );
  }
  const authApplied = Boolean(inputs.authConfig?.enabled);
  const secretMasker = createInputSecretMasker(inputs);
  let tempCollectionId = '';
  let tempCollectionDeleted = false;
  let runFailed = false;
  const warnings = [
    ...extraWarnings,
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
          secretsResolverProvider: inputs.secretsResolverProvider,
          collectionName: canonicalCollectionName,
          scriptSourceCollection: existingCollection,
          canonicalCollection: existingCollection
        }),
      verifyCollection: (collection) =>
        verifyGeneratedSmokeCollection(collection, inputs.authConfig, {
          secretsResolverProvider: inputs.secretsResolverProvider
        })
    });

    const authDescription = authApplied ? ` with Smoke ${describeAuthConfig(inputs.authConfig!)} auth on ${transformed.authRequestCount} request(s)` : '';
    dependencies.core.info(
      `Updated canonical Smoke collection ${inputs.smokeCollectionId} from generated spec collection${authDescription}.`
    );

    return createOutputs({
      flowName: '',
      status: 'success',
      flowSource: 'none',
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
      flowSource: 'none',
      temporaryCollectionId: tempCollectionId || undefined,
      canonicalSmokeCollectionId: inputs.smokeCollectionId,
      authApplied,
      authRequestCount: 0,
      stepCount: 0,
      resolvedOperationCount: 0,
      appliedBindingCount: 0,
      appliedExtractCount: 0,
      assertionCount: 0,
      warnings: [...warnings, secretMasker(summarizeError(error))]
    };
    if (tempCollectionId && !inputs.keepTempCollectionOnFailure) {
      try {
        await dependencies.postman.deleteCollection(tempCollectionId);
        tempCollectionDeleted = true;
      } catch (cleanupError) {
        dependencies.core.warning(
          formatTemporaryCollectionCleanupWarning(tempCollectionId, cleanupError, secretMasker)
        );
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
          dependencies.core.warning(
            formatTemporaryCollectionCleanupWarning(tempCollectionId, cleanupError, secretMasker)
          );
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

  if (inputs.flowMode === 'off') {
    if (flowPath) {
      throw new Error('flow-mode=off cannot be combined with flow-path; remove one of them.');
    }
    return runWithoutFlowManifest(inputs, dependencies);
  }

  if (inputs.flowMode === 'curated' && !flowPath) {
    throw new Error('flow-mode=curated requires flow-path to point at a flow.yaml manifest.');
  }

  // One name, one seam: flow-path when set, else the conventional default.
  // Mode selection keys on FILE EXISTENCE at the effective path, not input
  // presence, so a derived flow persisted by run 1 makes run 2 curated.
  const effectiveFlowPath = flowPath || DEFAULT_FLOW_PATH;
  const manifestExists = workspaceFileExists(effectiveFlowPath, 'flow-path');

  if (inputs.flowMode === 'curated' || manifestExists) {
    const manifest = loadFlowManifest(effectiveFlowPath);
    const { flow, warnings } = validateFlowManifest(manifest);
    return runWithFlowDefinition(
      inputs,
      dependencies,
      flow,
      warnings.map((warning) => warning.message),
      'curated'
    );
  }

  // flow-mode=auto without a manifest at the effective path: derive from the
  // spec, then persist the result AS that manifest (unless opted out).
  const derived = deriveAutoFlow(inputs, dependencies);
  if (!derived.flow) {
    const specPath = inputs.specPath?.trim();
    if (specPath) {
      const causes = derived.warnings.map((warning) => warning.message).join(' ');
      throw new Error(
        `Flow derivation from spec-path "${specPath}" produced no flow: ${causes} ` +
          'Fix the spec/exclusions, pass flow-path, or explicitly choose flow-mode=off.'
      );
    }
    return runWithoutFlowManifest(inputs, dependencies, derived.warnings.map((warning) => warning.message));
  }
  return runWithFlowDefinition(
    inputs,
    dependencies,
    derived.flow,
    derived.warnings.map((warning) => warning.message),
    'derived',
    {
      ...derived.trace,
      excludedOperationIds: derived.excludedOperationIds
    },
    inputs.persistDerivedFlow ? effectiveFlowPath : undefined
  );
}

/** Conventional manifest location when flow-path is not supplied. */
export const DEFAULT_FLOW_PATH = 'postman/flow.yaml';

export function parseFlowMode(raw: string | undefined): 'auto' | 'curated' | 'off' {
  const normalized = String(raw ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') return 'auto';
  if (normalized === 'curated') return 'curated';
  if (normalized === 'off') return 'off';
  throw new Error(`Invalid flow-mode: ${raw}. Expected auto, curated, or off.`);
}

function deriveAutoFlow(inputs: ActionInputs, dependencies: SmokeFlowDependencies): DerivedFlowResult {
  const specPath = inputs.specPath?.trim();
  if (!specPath) {
    return {
      flow: null,
      warnings: [
        {
          message:
            'flow-mode=auto without flow-path requires spec-path to derive a flow; falling back to uncurated refresh. ' +
            'Provide spec-path to enable derived flows or set flow-mode=off to silence this warning.'
        }
      ],
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
  const derived = deriveFlowFromSpecPath(specPath, { allowDelete: inputs.flowAllowDelete });
  if (derived.flow) {
    dependencies.core.info(
      `Derived smoke flow "${derived.flow.name}" from ${specPath}: ${derived.trace.derivedStepCount} step(s), ` +
        `${derived.trace.bindingCount} binding(s), ${derived.trace.extractCount} extract(s), ` +
        `${derived.trace.excludedDeleteCount} DELETE operation(s) excluded.`
    );
  }
  return derived;
}

async function runWithFlowDefinition(
  inputs: ActionInputs,
  dependencies: SmokeFlowDependencies,
  flow: FlowDefinition,
  warningMessages: string[],
  flowSource: 'curated' | 'derived',
  derivation?: NonNullable<FlowApplySummary['derivation']>,
  persistTo?: string
): Promise<ActionOutputs> {
  const flowName = flow.name;
  const secretMasker = createInputSecretMasker(inputs);
  warningMessages.forEach((message) => dependencies.core.warning(message));
  if (warningMessages.length > 0 && inputs.failOnFlowWarning) {
    throw new Error(`Flow validation produced ${warningMessages.length} warning(s) and fail-on-flow-warning=true.`);
  }

  let tempCollectionId = '';
  let tempCollectionDeleted = false;
  let runFailed = false;
  try {
    // Bootstrap re-elects the canonical Smoke final by exact info.name. Read the
    // canonical collection before the rebuild so its name survives the refresh;
    // renaming it via the /name PATCH breaks election and triggers a fresh
    // import/orphan cascade for this collection and its bound monitor.
    const canonicalCollection = await dependencies.postman.getCollection(inputs.smokeCollectionId);
    tempCollectionId = await dependencies.postman.generateCollection(inputs.specId, inputs.projectName, inputs.tempCollectionPrefix);
    dependencies.core.info(`Generated temporary Smoke collection ${tempCollectionId}`);

    const generatedCollection = await dependencies.postman.getCollection(tempCollectionId);

    // Pre-resolve against the generated collection BEFORE any canonical
    // mutation so weak-tier resolution warnings pass through the same
    // fail-on-flow-warning gate as manifest/derivation warnings. Deduped:
    // buildCollection re-resolves on every stabilization iteration.
    const resolutionWarnings = new Set<string>();
    resolveFlowRequests(flow, generatedCollection, inputs.specPath, (message) => {
      resolutionWarnings.add(message);
    });
    for (const message of resolutionWarnings) {
      dependencies.core.warning(message);
      warningMessages.push(message);
    }
    if (resolutionWarnings.size > 0 && inputs.failOnFlowWarning) {
      throw new Error(
        `Flow request resolution produced ${resolutionWarnings.size} warning(s) and fail-on-flow-warning=true; refusing the canonical Smoke mutation.`
      );
    }

    const transformed = await updateCanonicalCollectionUntilStable({
      inputs,
      dependencies,
      initialSourceCollection: generatedCollection,
      buildCollection: (sourceCollection) => {
        // Retry iterations resolve against a refreshed source; collect into
        // the same dedupe set so a retry-only weak-tier match is still
        // surfaced and gated after stabilization.
        const resolvedRequests = resolveFlowRequests(flow, sourceCollection, inputs.specPath, (message) => {
          resolutionWarnings.add(message);
        });
        return buildCuratedSmokeCollection(
          sourceCollection,
          flow,
          resolvedRequests,
          inputs.authConfig,
          inputs.secretsResolverProvider,
          { canonicalCollection }
        );
      },
      verifyCollection: (collection) =>
        verifyCuratedSmokeCollection(collection, flow, inputs.authConfig, {
          secretsResolverProvider: inputs.secretsResolverProvider
        })
    });
    dependencies.core.info(`Updated canonical Smoke collection ${inputs.smokeCollectionId} from ${flowSource} flow.`);

    // Retry-only weak-tier warnings (source refreshed mid-stabilization)
    // surface and gate here; the mutation already happened, so failing now is
    // an honest post-mutation failure rather than a silent success.
    for (const message of resolutionWarnings) {
      if (warningMessages.includes(message)) continue;
      dependencies.core.warning(message);
      warningMessages.push(message);
    }
    if (inputs.failOnFlowWarning && warningMessages.length > 0) {
      throw new Error(
        `Flow request resolution produced ${warningMessages.length} warning(s) and fail-on-flow-warning=true.`
      );
    }

    const resolvedRequests = resolveFlowRequests(flow, generatedCollection, inputs.specPath);

    const summary: FlowApplySummary = {
      flowName: flow.name,
      status: 'success',
      flowSource,
      derivation,
      temporaryCollectionId: tempCollectionId,
      canonicalSmokeCollectionId: inputs.smokeCollectionId,
      authApplied: Boolean(inputs.authConfig?.enabled),
      stepCount: flow.steps.length,
      resolvedOperationCount: resolvedRequests.length,
      appliedBindingCount: transformed.bindingCount,
      appliedExtractCount: transformed.extractCount,
      assertionCount: transformed.assertionCount,
      warnings: warningMessages
    };

    // Persist the derived flow as the curated manifest AFTER the apply
    // succeeded: run 2 finds flow.yaml at the same effective path and takes
    // the curated branch with zero caller plumbing. Create-only: a manifest
    // that appeared mid-run (human curation, concurrent job) is never
    // overwritten - the write fails loudly instead.
    let derivedFlowPath = '';
    if (flowSource === 'derived' && persistTo) {
      writeWorkspaceFileExclusive(persistTo, stringifyFlowManifest(flow), 'flow-path');
      derivedFlowPath = persistTo;
      dependencies.core.info(`Persisted the derived flow as ${persistTo}; the next run uses it as the curated manifest.`);
    }

    return createOutputs(summary, derivedFlowPath);
  } catch (error) {
    runFailed = true;
    const summary: FlowApplySummary = {
      flowName,
      status: 'failed',
      flowSource,
      derivation,
      temporaryCollectionId: tempCollectionId || undefined,
      canonicalSmokeCollectionId: inputs.smokeCollectionId,
      authApplied: Boolean(inputs.authConfig?.enabled),
      stepCount: 0,
      resolvedOperationCount: 0,
      appliedBindingCount: 0,
      appliedExtractCount: 0,
      assertionCount: 0,
      warnings: [...warningMessages, secretMasker(summarizeError(error))]
    };
    if (tempCollectionId && !inputs.keepTempCollectionOnFailure) {
      try {
        await dependencies.postman.deleteCollection(tempCollectionId);
        tempCollectionDeleted = true;
      } catch (cleanupError) {
        dependencies.core.warning(
          formatTemporaryCollectionCleanupWarning(tempCollectionId, cleanupError, secretMasker)
        );
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
          dependencies.core.warning(
            formatTemporaryCollectionCleanupWarning(tempCollectionId, cleanupError, secretMasker)
          );
        }
      }
    }
  }
}

/**
 * Per-process identity embedded in temporary collection names so ambiguous
 * generation responses can be reconciled without adopting a peer run's temp.
 */
export function buildSmokeRunIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const parts = [
    env.GITHUB_RUN_ID,
    env.GITHUB_RUN_ATTEMPT,
    env.GITHUB_JOB,
    randomBytes(4).toString('hex')
  ]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean);
  return parts.join('-');
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
export function resolveGatewayTeamContext(
  teamId: string | undefined
): { teamId: string; orgMode: true } | Record<string, never> {
  const normalized = String(teamId ?? '').trim();
  return normalized ? { teamId: normalized, orgMode: true } : {};
}

function createSmokeClient(
  inputs: ActionInputs,
  actionCore: CoreLike,
  env: NodeJS.ProcessEnv = process.env
): SmokeCollectionClient {
  const accessToken = String(inputs.postmanAccessToken ?? '').trim();
  if (!accessToken) {
    throw new Error(
      'postman-access-token is required and could not be minted from postman-api-key (see the warning above for the diagnosis): ' +
        'the Smoke collection reshape runs access-token-only through the Postman gateway. Provide a valid ' +
        'service-account postman-api-key so the action can mint one, or mint it with ' +
        'postman-resolve-service-token-action and pass it as postman-access-token ' +
        '(postman-api-key alone never drives the reshape).'
    );
  }
  const mutableMasker = createMutableSecretMasker([
    inputs.postmanApiKey,
    inputs.postmanAccessToken,
    accessToken
  ]);
  const provider = new AccessTokenProvider({
    accessToken,
    apiKey: inputs.postmanApiKey || undefined,
    apiBaseUrl: inputs.postmanApiBaseUrl,
    onToken: (token) => {
      actionCore.setSecret?.(token);
      mutableMasker.add(token);
    }
  });
  const workspaceId = String(inputs.workspaceId ?? '').trim();
  return new PostmanGatewaySmokeClient({
    tokenProvider: provider,
    ...resolveGatewayTeamContext(inputs.teamId),
    ...(workspaceId ? { workspaceId } : {}),
    runIdentity: buildSmokeRunIdentity(env),
    secretMasker: mutableMasker.mask,
    warning: (message) => actionCore.warning(message)
  });
}

export function decideBranchTier(
  inputs: Pick<ActionInputs, 'branchStrategy' | 'canonicalBranch' | 'channels'>,
  env: NodeJS.ProcessEnv = process.env
): BranchDecision {
  return resolveEffectiveBranchDecision(
    {
      strategy: (inputs.branchStrategy as BranchStrategy) ?? 'legacy',
      identity: resolveBranchIdentity(env, { defaultBranch: inputs.canonicalBranch }),
      canonicalBranch: inputs.canonicalBranch,
      channels: parseChannelRules(inputs.channels)
    },
    env
  );
}

async function runGatedSkip(
  inputs: ActionInputs,
  decision: BranchDecision,
  actionCore: CoreLike
): Promise<ActionOutputs> {
  actionCore.info(`branch-aware sync: gated run (${decision.reason}) — skipping smoke-flow reshape, zero workspace writes`);
  const outputs: ActionOutputs = {
    'smoke-collection-id': inputs.smokeCollectionId,
    'flow-apply-status': 'skipped',
    'flow-apply-summary-json': JSON.stringify({ status: 'skipped-branch-gate', reason: decision.reason }),
    'temporary-smoke-collection-id': '',
    'flow-step-count': '0',
    'resolved-operation-count': '0',
    'applied-binding-count': '0',
    'applied-extract-count': '0',
    'assertion-count': '0',
    'derived-flow-path': '',
    'sync-status': 'skipped-branch-gate',
    'branch-decision': serializeBranchDecision(decision)
  };
  for (const [name, value] of Object.entries(outputs)) {
    actionCore.setOutput(name, value);
  }
  process.env[BRANCH_DECISION_ENV] = serializeBranchDecision(decision);
  return outputs;
}

export async function runAction(
  actionCore: CoreLike = core,
  env: NodeJS.ProcessEnv = process.env,
  injectedLogger?: Logger,
  injectedDependencies?: Omit<SmokeFlowDependencies, 'core'>
): Promise<ActionOutputs> {
  const logger =
    injectedLogger ??
    createLogger({
      sink: actionSink(actionCore),
      env,
      fields: { action: 'postman-smoke-flow-action', action_version: resolveActionVersion() }
    });
  // Branch-aware sync: decide BEFORE any credential validation or mint.
  const inputs = readActionInputs(env);
  // Register before anything can print: a credential that reaches the logger
  // after the first line is a credential that already leaked once.
  logger.addSecret(inputs.postmanApiKey);
  logger.addSecret(inputs.postmanAccessToken);
  logger.debug('resolved inputs', {
    team_id: inputs.teamId || undefined,
    smoke_collection_id: inputs.smokeCollectionId || undefined,
    api_base: inputs.postmanApiBaseUrl
  });
  const branchDecision = decideBranchTier(inputs, env);
  if (branchDecision.tier === 'gated') {
    return runGatedSkip(inputs, branchDecision, actionCore);
  }
  validateInputsBeforeSideEffects(inputs);
  if (branchDecision.tier !== 'legacy') {
    actionCore.info(`branch-aware sync: tier=${branchDecision.tier} (${branchDecision.reason})`);
    process.env[BRANCH_DECISION_ENV] = serializeBranchDecision(branchDecision);
  }

  // PMAK-only runs: eagerly mint the short-lived access token from the service
  // -account PMAK so the access-token-only gateway reshape works exactly as
  // when postman-access-token is supplied. Mirrors bootstrap's runAction. A
  // failed mint warns with a live-probed diagnosis (personal key vs permission
  // gap vs invalid key) and falls through to createSmokeClient's guard.
  const mintHolder = {
    postmanAccessToken: inputs.postmanAccessToken,
    postmanApiKey: inputs.postmanApiKey,
    postmanApiBase: inputs.postmanApiBaseUrl
  };
  await logger.phase('mint-access-token', async () =>
    mintAccessTokenIfNeeded(
      mintHolder,
      { info: (m) => actionCore.info(m), warning: (m) => actionCore.warning?.(m ?? '') },
      (secret) => {
        logger.addSecret(secret);
        actionCore.setSecret?.(secret);
      }
    )
  );
  inputs.postmanAccessToken = mintHolder.postmanAccessToken;

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
    // Client construction is inside the phase because its credential guard is
    // one of the likeliest failures here; leaving it outside would report the
    // most common failure with no phase at all.
    const outputs = await logger.phase('smoke-flow', async () => {
      const postman = injectedDependencies?.postman ?? createSmokeClient(inputs, actionCore, env);
      return runSmokeFlow(inputs, {
        core: actionCore,
        postman,
        sleep: injectedDependencies?.sleep
      });
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
