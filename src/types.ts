import type { SecretsResolverProvider } from '@postman-cse/automation-core';

export type BindingSource = 'example' | 'literal' | 'prior_output';

export type FlowBinding = {
  fieldKey: string;
  source: BindingSource;
  value?: string;
  sourceStepKey?: string;
  variable?: string;
};

export type FlowExtract = {
  variable: string;
  jsonPath: string;
};

export type FlowStep = {
  stepKey: string;
  operationId: string;
  name?: string;
  description?: string;
  bindings: FlowBinding[];
  extract: FlowExtract[];
};

export type FlowDefinition = {
  name: string;
  type: 'smoke';
  steps: FlowStep[];
};

export type FlowManifest = {
  spec?: {
    fileName?: string;
    title?: string;
    version?: string;
  };
  flows: FlowDefinition[];
};

export type ActionInputs = {
  projectName: string;
  workspaceId: string;
  specId: string;
  smokeCollectionId: string;
  flowPath?: string;
  flowMode: 'auto' | 'curated' | 'off';
  flowAllowDelete: boolean;
  postmanApiKey: string;
  postmanApiBaseUrl: string;
  postmanBifrostBaseUrl: string;
  postmanIapubBaseUrl: string;
  authConfig?: SmokeAuthConfig;
  authPlanPath?: string;
  authPlan?: SmokeAuthPlan;
  secretsResolverProvider: SecretsResolverProvider;
  specPath?: string;
  debugDumpPath?: string;
  collectionSyncMode: 'refresh' | 'version';
  postmanAccessToken?: string;
  failOnFlowWarning: boolean;
  keepTempCollectionOnFailure: boolean;
  tempCollectionPrefix: string;
  persistDerivedFlow: boolean;
  teamId?: string;
  branchStrategy?: string;
  canonicalBranch?: string;
  channels?: string;
};

export type SmokeOAuthSettings = {
  type: 'oauth2';
  grantType: 'client_credentials';
  tokenUrl: string;
  clientAuthentication: 'body';
  request?: {
    contentType?: 'application/x-www-form-urlencoded';
  };
  variables?: {
    tokenUrl?: string;
    scope?: string;
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    expiresAt?: string;
  };
  cache?: {
    refreshSkewSeconds?: number;
  };
  apply?: {
    header?: string;
    value?: string;
  };
};

export type SmokeOAuthConfig = SmokeOAuthSettings & {
  enabled: boolean;
};

export type SmokeApiKeySettings = {
  type: 'apiKey';
  in: 'header' | 'query';
  name: string;
  variables?: {
    apiKey?: string;
  };
};

export type SmokeApiKeyConfig = SmokeApiKeySettings & {
  enabled: boolean;
};

export type SmokeAuthConfig = SmokeOAuthConfig | SmokeApiKeyConfig;

export type SmokeOAuthProfile = SmokeOAuthSettings & {
  scope?: string;
  variables: {
    clientId: string;
    clientSecret: string;
    accessToken: string;
    expiresAt: string;
  };
};

export type SmokeApiKeyProfile = SmokeApiKeySettings & {
  variables: {
    apiKey: string;
  };
};

export type SmokeNoAuthProfile = {
  type: 'noauth';
};

export type SmokeAuthProfile = SmokeOAuthProfile | SmokeApiKeyProfile | SmokeNoAuthProfile;

export type SmokeAuthPlanTarget = {
  operationId: string;
  profile: string;
};

export type SmokeAuthPlan = {
  version: 1;
  profiles: Record<string, SmokeAuthProfile>;
  targets: SmokeAuthPlanTarget[];
};

export type FlowWarning = {
  message: string;
};

export type ResolvedRequest = {
  step: FlowStep;
  item: Record<string, unknown>;
};

export type FlowApplySummary = {
  flowName: string;
  status: 'success' | 'failed' | 'skipped';
  /** Where the applied flow came from: a curated manifest, spec derivation, or none (uncurated refresh). */
  flowSource?: 'curated' | 'derived' | 'none';
  temporaryCollectionId?: string;
  canonicalSmokeCollectionId: string;
  authApplied?: boolean;
  authRequestCount?: number;
  stepCount: number;
  resolvedOperationCount: number;
  appliedBindingCount: number;
  appliedExtractCount: number;
  assertionCount: number;
  /** Present only for derived flows: machine-readable derivation decision record. */
  derivation?: {
    resourceCount: number;
    operationCount: number;
    derivedStepCount: number;
    extractCount: number;
    bindingCount: number;
    excludedDeleteCount: number;
    excludedUnresolvedPathParamCount: number;
    unresolvedParameterCount: number;
    excludedOperationIds: string[];
  };
  warnings: string[];
};

export type ActionOutputs = {
  'smoke-collection-id': string;
  'flow-apply-status': 'success' | 'failed' | 'skipped';
  'flow-apply-summary-json': string;
  'temporary-smoke-collection-id': string;
  'flow-step-count': string;
  'resolved-operation-count': string;
  'applied-binding-count': string;
  'applied-extract-count': string;
  'assertion-count': string;
  /** Repo-relative path where this run persisted a derived flow.yaml ('' when nothing was written). */
  'derived-flow-path': string;
  'sync-status': string;
  'branch-decision': string;
};

export type CoreLike = {
  setOutput: (name: string, value: string) => void;
  setSecret?: (secret: string) => void;
  info: (message: string) => void;
  // Optional so every existing caller keeps compiling; the shared log sink
  // degrades each level to the next channel the host actually implements.
  debug?: (message: string) => void;
  warning: (message: string) => void;
  error?: (message: string) => void;
  setFailed: (message: string) => void;
};
