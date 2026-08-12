import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

import { resolveWorkspaceRegularFile } from '../lib/paths.js';
import type {
  SmokeApiKeyProfile,
  SmokeAuthPlan,
  SmokeAuthProfile,
  SmokeOAuthProfile
} from '../types.js';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid auth plan: ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, field);
}

function parseOAuthProfile(profileName: string, value: JsonRecord): SmokeOAuthProfile {
  if (value.grantType !== 'client_credentials') {
    throw new Error(
      `Invalid auth plan: profiles.${profileName}.grantType must be client_credentials.`
    );
  }
  if (value.clientAuthentication !== 'body') {
    throw new Error(
      `Invalid auth plan: profiles.${profileName}.clientAuthentication must be body.`
    );
  }

  const variables = asRecord(value.variables);
  if (!variables) {
    throw new Error(`Invalid auth plan: profiles.${profileName}.variables must be an object.`);
  }

  const request = value.request === undefined ? undefined : asRecord(value.request);
  if (value.request !== undefined && !request) {
    throw new Error(`Invalid auth plan: profiles.${profileName}.request must be an object.`);
  }
  if (
    request?.contentType !== undefined &&
    request.contentType !== 'application/x-www-form-urlencoded'
  ) {
    throw new Error(
      `Invalid auth plan: profiles.${profileName}.request.contentType must be application/x-www-form-urlencoded.`
    );
  }

  const cache = value.cache === undefined ? undefined : asRecord(value.cache);
  if (value.cache !== undefined && !cache) {
    throw new Error(`Invalid auth plan: profiles.${profileName}.cache must be an object.`);
  }
  const refreshSkewSeconds = cache?.refreshSkewSeconds;
  if (
    refreshSkewSeconds !== undefined &&
    (!Number.isInteger(refreshSkewSeconds) || Number(refreshSkewSeconds) < 0)
  ) {
    throw new Error(
      `Invalid auth plan: profiles.${profileName}.cache.refreshSkewSeconds must be a non-negative integer.`
    );
  }

  return {
    type: 'oauth2',
    grantType: 'client_credentials',
    tokenUrl: requireNonEmptyString(value.tokenUrl, `profiles.${profileName}.tokenUrl`),
    scope: readOptionalNonEmptyString(value.scope, `profiles.${profileName}.scope`),
    clientAuthentication: 'body',
    request: request ? { contentType: request.contentType as 'application/x-www-form-urlencoded' | undefined } : undefined,
    cache: cache ? { refreshSkewSeconds: refreshSkewSeconds as number | undefined } : undefined,
    variables: {
      clientId: requireNonEmptyString(variables.clientId, `profiles.${profileName}.variables.clientId`),
      clientSecret: requireNonEmptyString(
        variables.clientSecret,
        `profiles.${profileName}.variables.clientSecret`
      ),
      accessToken: requireNonEmptyString(
        variables.accessToken,
        `profiles.${profileName}.variables.accessToken`
      ),
      expiresAt: requireNonEmptyString(variables.expiresAt, `profiles.${profileName}.variables.expiresAt`)
    }
  };
}

function parseApiKeyProfile(profileName: string, value: JsonRecord): SmokeApiKeyProfile {
  if (value.in !== 'header' && value.in !== 'query') {
    throw new Error(`Invalid auth plan: profiles.${profileName}.in must be header or query.`);
  }
  const variables = asRecord(value.variables);
  if (!variables) {
    throw new Error(`Invalid auth plan: profiles.${profileName}.variables must be an object.`);
  }
  return {
    type: 'apiKey',
    in: value.in,
    name: requireNonEmptyString(value.name, `profiles.${profileName}.name`),
    variables: {
      apiKey: requireNonEmptyString(variables.apiKey, `profiles.${profileName}.variables.apiKey`)
    }
  };
}

function parseProfile(profileName: string, value: unknown): SmokeAuthProfile {
  const profile = asRecord(value);
  if (!profile) {
    throw new Error(`Invalid auth plan: profiles.${profileName} must be an object.`);
  }
  if (profile.type === 'oauth2') {
    return parseOAuthProfile(profileName, profile);
  }
  if (profile.type === 'apiKey') {
    return parseApiKeyProfile(profileName, profile);
  }
  if (profile.type === 'noauth') {
    return { type: 'noauth' };
  }
  throw new Error(
    `Invalid auth plan: profiles.${profileName}.type must be oauth2, apiKey, or noauth.`
  );
}

export function validateAuthPlan(value: unknown): SmokeAuthPlan {
  const document = asRecord(value);
  if (!document) {
    throw new Error('Invalid auth plan: expected a YAML object.');
  }
  if (document.version !== 1) {
    throw new Error('Invalid auth plan: version must be 1.');
  }

  const rawProfiles = asRecord(document.profiles);
  if (!rawProfiles || Object.keys(rawProfiles).length === 0) {
    throw new Error('Invalid auth plan: profiles must contain at least one profile.');
  }
  const profiles = Object.fromEntries(
    Object.entries(rawProfiles).map(([name, profile]) => [
      requireNonEmptyString(name, 'profile name'),
      parseProfile(name, profile)
    ])
  );

  if (!Array.isArray(document.targets) || document.targets.length === 0) {
    throw new Error('Invalid auth plan: targets must contain at least one operation mapping.');
  }

  const seenOperationIds = new Set<string>();
  const targets = document.targets.map((entry, index) => {
    const target = asRecord(entry);
    if (!target) {
      throw new Error(`Invalid auth plan: targets[${index}] must be an object.`);
    }
    const operationId = requireNonEmptyString(target.operationId, `targets[${index}].operationId`);
    const profile = requireNonEmptyString(target.profile, `targets[${index}].profile`);
    if (seenOperationIds.has(operationId)) {
      throw new Error(`Invalid auth plan: operationId "${operationId}" is mapped more than once.`);
    }
    if (!profiles[profile]) {
      throw new Error(
        `Invalid auth plan: targets[${index}] references unknown profile "${profile}".`
      );
    }
    seenOperationIds.add(operationId);
    return { operationId, profile };
  });

  return { version: 1, profiles, targets };
}

export function loadAuthPlan(authPlanPath: string): SmokeAuthPlan {
  const resolvedPath = resolveWorkspaceRegularFile(authPlanPath, 'auth-plan-path');
  let document: unknown;
  try {
    document = parse(readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid auth plan at ${authPlanPath}: ${message}`, { cause: error });
  }
  return validateAuthPlan(document);
}
