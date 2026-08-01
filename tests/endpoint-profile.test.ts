import { describe, expect, it } from 'vitest';

import {
  EMULATOR_PROFILE_ENV,
  EMULATOR_PROFILE_NAME,
  ENDPOINT_OVERRIDE_ENV,
  applyEndpointOverrides
} from '../src/lib/postman/base-urls.js';
import { readActionInputs } from '../src/index.js';

function armed(overrides: Record<string, string>): Record<string, string | undefined> {
  return { [EMULATOR_PROFILE_ENV]: EMULATOR_PROFILE_NAME, ...overrides };
}

const COMPLETE_OVERRIDES = {
  [ENDPOINT_OVERRIDE_ENV.apiBaseUrl]: 'http://127.0.0.1:8081/api',
  [ENDPOINT_OVERRIDE_ENV.iapubBaseUrl]: 'http://127.0.0.1:8083/iapub'
};

const LIVE = {
  apiBaseUrl: 'https://api.getpostman.com',
  iapubBaseUrl: 'https://iapub.postman.co'
};

describe('smoke-flow endpoint defaults', () => {
  it('returns the caller-resolved live hosts when the emulator profile is absent', () => {
    expect(applyEndpointOverrides(LIVE, {})).toEqual(LIVE);
  });

  it('threads the live defaults through the input reader untouched', () => {
    expect(readActionInputs({})).toMatchObject({
      postmanApiBaseUrl: 'https://api.getpostman.com',
      postmanIapubBaseUrl: 'https://iapub.postman.co'
    });
    expect(
      readActionInputs({ 'INPUT_POSTMAN-REGION': 'eu' } as NodeJS.ProcessEnv)
    ).toMatchObject({
      postmanApiBaseUrl: 'https://api.eu.postman.com',
      postmanIapubBaseUrl: 'https://iapub.postman.co'
    });
  });
});

describe('smoke-flow emulator endpoint overrides', () => {
  it('atomically redirects both runtime hosts', () => {
    expect(applyEndpointOverrides(LIVE, armed(COMPLETE_OVERRIDES))).toEqual({
      apiBaseUrl: 'http://127.0.0.1:8081/api',
      iapubBaseUrl: 'http://127.0.0.1:8083/iapub'
    });
  });

  it('threads the armed profile through the action input reader', () => {
    expect(readActionInputs(armed(COMPLETE_OVERRIDES) as NodeJS.ProcessEnv)).toMatchObject({
      postmanApiBaseUrl: 'http://127.0.0.1:8081/api',
      postmanIapubBaseUrl: 'http://127.0.0.1:8083/iapub'
    });
  });

  it('normalizes trailing slashes and ignores the selected region', () => {
    const env = armed(
      Object.fromEntries(
        Object.entries(COMPLETE_OVERRIDES).map(([name, value]) => [name, `${value}///`])
      )
    );
    expect(applyEndpointOverrides(LIVE, env)).toEqual({
      apiBaseUrl: 'http://127.0.0.1:8081/api',
      iapubBaseUrl: 'http://127.0.0.1:8083/iapub'
    });
  });
});

describe('smoke-flow emulator override fail-closed validation', () => {
  it('rejects overrides without the arming variable', () => {
    expect(() =>
      applyEndpointOverrides(LIVE, {
        [ENDPOINT_OVERRIDE_ENV.apiBaseUrl]: COMPLETE_OVERRIDES[ENDPOINT_OVERRIDE_ENV.apiBaseUrl]
      })
    ).toThrow('ENDPOINT_PROFILE_NOT_ARMED');
  });

  it.each(['', '   '])('rejects an unarmed %j override before returning live hosts', (value) => {
    expect(() =>
      applyEndpointOverrides(LIVE, { [ENDPOINT_OVERRIDE_ENV.iapubBaseUrl]: value })
    ).toThrow('ENDPOINT_PROFILE_NOT_ARMED');
  });

  it('rejects an empty arming value when an override is present', () => {
    expect(() =>
      applyEndpointOverrides(LIVE, {
        [EMULATOR_PROFILE_ENV]: '  ',
        [ENDPOINT_OVERRIDE_ENV.apiBaseUrl]: COMPLETE_OVERRIDES[ENDPOINT_OVERRIDE_ENV.apiBaseUrl]
      })
    ).toThrow('ENDPOINT_PROFILE_NOT_ARMED');
  });

  it.each(['live', 'prod', 'container', 'Emulator'])('rejects unknown profile %j', (profile) => {
    expect(() => applyEndpointOverrides(LIVE, { [EMULATOR_PROFILE_ENV]: profile })).toThrow(
      'ENDPOINT_PROFILE_UNKNOWN'
    );
  });

  it.each(Object.entries(ENDPOINT_OVERRIDE_ENV))(
    'rejects an armed profile missing %s',
    (_field, omitted) => {
      const env = armed({ ...COMPLETE_OVERRIDES });
      delete env[omitted];
      expect(() => applyEndpointOverrides(LIVE, env)).toThrow('ENDPOINT_PROFILE_OVERRIDE_MISSING');
      expect(() => applyEndpointOverrides(LIVE, env)).toThrow(omitted);
    }
  );

  it.each([
    ['relative URL', 'relative/path'],
    ['non-http scheme', 'ftp://127.0.0.1:8081'],
    ['credentials', 'http://user:pass@127.0.0.1:8081'], // trufflehog:ignore -- placeholder the profile must reject
    ['query string', 'http://127.0.0.1:8081?team=1'],
    ['fragment', 'http://127.0.0.1:8081#fragment'],
    ['whitespace', '   ']
  ])('rejects a malformed %s override', (_label, value) => {
    expect(() =>
      applyEndpointOverrides(
        LIVE,
        armed({ ...COMPLETE_OVERRIDES, [ENDPOINT_OVERRIDE_ENV.apiBaseUrl]: value })
      )
    ).toThrow(/ENDPOINT_PROFILE_OVERRIDE_(INVALID|MISSING)/);
  });

  it.each(Object.entries(ENDPOINT_OVERRIDE_ENV))(
    'names malformed %s override failures',
    (_field, envName) => {
      expect(() =>
        applyEndpointOverrides(
          LIVE,
          armed({ ...COMPLETE_OVERRIDES, [envName]: 'ftp://127.0.0.1:8081' })
        )
      ).toThrow(envName);
    }
  );
});
