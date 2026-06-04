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
  postmanApiKey: string;
  authConfig?: SmokeAuthConfig;
  secretsResolverEnabled: boolean;
  specPath?: string;
  debugDumpPath?: string;
  collectionSyncMode: 'refresh' | 'version';
  postmanAccessToken?: string;
  failOnFlowWarning: boolean;
  keepTempCollectionOnFailure: boolean;
  tempCollectionPrefix: string;
};

export type SmokeAuthConfig = {
  enabled: boolean;
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
  temporaryCollectionId?: string;
  canonicalSmokeCollectionId: string;
  authApplied?: boolean;
  authRequestCount?: number;
  stepCount: number;
  resolvedOperationCount: number;
  appliedBindingCount: number;
  appliedExtractCount: number;
  assertionCount: number;
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
};

export type CoreLike = {
  setOutput: (name: string, value: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  setFailed: (message: string) => void;
};
