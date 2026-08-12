import { describe, expect, it } from 'vitest';

import { validateAuthPlan } from '../src/auth/plan.js';

describe('auth plan validation', () => {
  it('accepts OAuth2, API key, and noauth profiles', () => {
    const plan = validateAuthPlan({
      version: 1,
      profiles: {
        entra: {
          type: 'oauth2',
          grantType: 'client_credentials',
          clientAuthentication: 'body',
          tokenUrl: '{{ENTRA_ID_URL}}',
          scope: '{{SERVICE_CLIENT_ID}}/.default',
          variables: {
            clientId: 'APIM_CLIENT_ID',
            clientSecret: 'APIM_CLIENT_SECRET',
            accessToken: 'SERVICE_TOKEN',
            expiresAt: 'SERVICE_TOKEN_EXPIRES_AT'
          }
        },
        key: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          variables: { apiKey: 'SERVICE_APIKEY' }
        },
        public: { type: 'noauth' }
      },
      targets: [
        { operationId: 'getSecure', profile: 'entra' },
        { operationId: 'getByKey', profile: 'key' },
        { operationId: 'getPublic', profile: 'public' }
      ]
    });

    expect(plan.version).toBe(1);
    expect(plan.targets).toHaveLength(3);
    expect(plan.profiles.entra?.type).toBe('oauth2');
  });

  it('rejects duplicate targets and unknown profile references', () => {
    const base = {
      version: 1,
      profiles: { public: { type: 'noauth' } }
    };

    expect(() =>
      validateAuthPlan({
        ...base,
        targets: [
          { operationId: 'getPublic', profile: 'public' },
          { operationId: 'getPublic', profile: 'public' }
        ]
      })
    ).toThrow('mapped more than once');
    expect(() =>
      validateAuthPlan({
        ...base,
        targets: [{ operationId: 'getPublic', profile: 'missing' }]
      })
    ).toThrow('unknown profile "missing"');
  });

  it('rejects OAuth profiles without explicit runtime variable names', () => {
    expect(() =>
      validateAuthPlan({
        version: 1,
        profiles: {
          entra: {
            type: 'oauth2',
            grantType: 'client_credentials',
            clientAuthentication: 'body',
            tokenUrl: '{{ENTRA_ID_URL}}',
            variables: {
              clientId: 'APIM_CLIENT_ID',
              clientSecret: 'APIM_CLIENT_SECRET',
              accessToken: 'SERVICE_TOKEN'
            }
          }
        },
        targets: [{ operationId: 'getSecure', profile: 'entra' }]
      })
    ).toThrow('variables.expiresAt must be a non-empty string');
  });

  it('rejects OAuth profiles that would share a runtime token cache', () => {
    const profile = {
      type: 'oauth2',
      grantType: 'client_credentials',
      clientAuthentication: 'body',
      tokenUrl: '{{ENTRA_ID_URL}}',
      variables: {
        clientId: 'APIM_CLIENT_ID',
        clientSecret: 'APIM_CLIENT_SECRET',
        accessToken: 'SHARED_TOKEN',
        expiresAt: 'SHARED_TOKEN_EXPIRES_AT'
      }
    };

    expect(() =>
      validateAuthPlan({
        version: 1,
        profiles: { first: profile, second: profile },
        targets: [
          { operationId: 'getFirst', profile: 'first' },
          { operationId: 'getSecond', profile: 'second' }
        ]
      })
    ).toThrow('share runtime cache variable "SHARED_TOKEN"');
  });
});
