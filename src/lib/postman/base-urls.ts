export type PostmanStack = 'prod' | 'beta';
export type PostmanRegion = 'us' | 'eu';

export interface PostmanEndpointProfile {
  apiBaseUrl: string;
  bifrostBaseUrl: string;
  cliInstallUrl: string;
  gatewayBaseUrl: string;
  iapubBaseUrl: string;
}

export const POSTMAN_ENDPOINT_PROFILES: Record<PostmanStack, PostmanEndpointProfile> = {
  prod: {
    apiBaseUrl: 'https://api.getpostman.com',
    bifrostBaseUrl: 'https://bifrost-premium-https-v4.gw.postman.com',
    cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh',
    gatewayBaseUrl: 'https://gateway.postman.com',
    iapubBaseUrl: 'https://iapub.postman.co'
  },
  beta: {
    apiBaseUrl: 'https://api.getpostman-beta.com',
    bifrostBaseUrl: 'https://bifrost-https-v4.gw.postman-beta.com',
    cliInstallUrl: 'https://dl-cli.pstmn-beta.io/install/unix.sh',
    gatewayBaseUrl: 'https://gateway.postman-beta.com',
    iapubBaseUrl: 'https://iapub.postman.co'
  }
};

export function parsePostmanRegion(value: string | undefined): PostmanRegion {
  const normalized = String(value || 'us').trim().toLowerCase();
  if (normalized === 'us' || normalized === 'eu') {
    return normalized;
  }
  throw new Error(`Unsupported postman-region "${value}". Supported values: us, eu`);
}

export function parsePostmanStack(value: string | undefined): PostmanStack {
  const normalized = String(value || 'prod').trim().toLowerCase();
  if (normalized === 'prod' || normalized === 'beta') {
    return normalized;
  }
  throw new Error(`Unsupported postman-stack "${value}". Supported values: prod, beta`);
}

export function resolvePostmanEndpointProfile(
  stack: PostmanStack,
  region: PostmanRegion = 'us'
): PostmanEndpointProfile {
  if (stack === 'beta' && region !== 'us') {
    throw new Error('postman-region=eu is only supported with postman-stack=prod');
  }
  const profile = POSTMAN_ENDPOINT_PROFILES[stack];
  if (region === 'eu') {
    return {
      ...profile,
      apiBaseUrl: 'https://api.eu.postman.com'
    };
  }
  return profile;
}

/**
 * Test-only endpoint override seam, mirroring the bootstrap action's contract
 * (see postman-bootstrap-action src/lib/postman/base-urls.ts). Inert without
 * env: absent EMULATOR_PROFILE_ENV preserves live hosts, and any override env
 * set while unarmed throws instead of being silently ignored. When armed,
 * EVERY overridable host must be supplied — the emulator profile never falls
 * back to a live host. Smoke-flow's runtime reaches exactly two backends (the
 * public API and iapub), so those are the two overridable hosts.
 */
export const EMULATOR_PROFILE_ENV = 'POSTMAN_TEST_EMULATOR_PROFILE';
export const EMULATOR_PROFILE_NAME = 'emulator';
export const ENDPOINT_OVERRIDE_ENV = {
  apiBaseUrl: 'POSTMAN_TEST_API_BASE_URL',
  iapubBaseUrl: 'POSTMAN_TEST_IAPUB_BASE_URL'
} as const;

export type EndpointEnvironment = Record<string, string | undefined>;

const OVERRIDE_FIELDS = Object.keys(ENDPOINT_OVERRIDE_ENV) as Array<
  keyof typeof ENDPOINT_OVERRIDE_ENV
>;

function readEndpointEnv(env: EndpointEnvironment, name: string): string {
  return String(env[name] ?? '').trim();
}

function normalizeEndpointOverride(envName: string, raw: string): string {
  const invalid = (reason: string): Error =>
    new Error(`ENDPOINT_PROFILE_OVERRIDE_INVALID: ${envName} ${reason}`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid('must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalid(`must use http or https, got "${parsed.protocol}"`);
  }
  if (parsed.username || parsed.password) {
    throw invalid('must not embed credentials');
  }
  if (parsed.search || parsed.hash) {
    throw invalid('must not carry a query string or fragment');
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

function assertNoUnarmedOverrides(env: EndpointEnvironment): void {
  const set = OVERRIDE_FIELDS.map((field) => ENDPOINT_OVERRIDE_ENV[field]).filter((name) =>
    Object.hasOwn(env, name)
  );
  if (set.length > 0) {
    throw new Error(
      `ENDPOINT_PROFILE_NOT_ARMED: ${set.join(', ')} set without ` +
        `${EMULATOR_PROFILE_ENV}=${EMULATOR_PROFILE_NAME}; endpoint overrides are ignored ` +
        'unless the emulator profile is armed, so this would have hit live hosts.'
    );
  }
}

export interface OverridableEndpoints {
  apiBaseUrl: string;
  iapubBaseUrl: string;
}

/**
 * Resolve the two runtime hosts with the emulator override applied when armed.
 * `live` carries the region-resolved live defaults from the caller.
 */
export function applyEndpointOverrides(
  live: OverridableEndpoints,
  env: EndpointEnvironment = process.env
): OverridableEndpoints {
  const profileName = readEndpointEnv(env, EMULATOR_PROFILE_ENV);
  if (!profileName) {
    assertNoUnarmedOverrides(env);
    return live;
  }
  if (profileName !== EMULATOR_PROFILE_NAME) {
    throw new Error(
      `ENDPOINT_PROFILE_UNKNOWN: ${EMULATOR_PROFILE_ENV}="${profileName}"; ` +
        `supported values: ${EMULATOR_PROFILE_NAME}`
    );
  }
  const resolved = {} as Record<keyof typeof ENDPOINT_OVERRIDE_ENV, string>;
  for (const field of OVERRIDE_FIELDS) {
    const envName = ENDPOINT_OVERRIDE_ENV[field];
    const raw = readEndpointEnv(env, envName);
    if (!raw) {
      throw new Error(
        `ENDPOINT_PROFILE_OVERRIDE_MISSING: ${envName} is required when ` +
          `${EMULATOR_PROFILE_ENV}=${EMULATOR_PROFILE_NAME}; the emulator profile never ` +
          'falls back to a live host.'
      );
    }
    resolved[field] = normalizeEndpointOverride(envName, raw);
  }
  return { ...live, ...resolved };
}
