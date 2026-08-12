import { describe, expect, it } from 'vitest';

import { readActionInputs } from '../src/index.js';
import { parseCliArgs } from '../src/lib/cli-args.js';

describe('readActionInputs', () => {
  it('reads hyphenated GitHub Action inputs from canonical runner env names', () => {
    const inputs = readActionInputs({
      INPUT_PROJECT_NAME: 'oreilly-demo-remote-pos-service',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_SPEC_ID: 'spec-123',
      INPUT_SMOKE_COLLECTION_ID: 'col-123',
      INPUT_FLOW_PATH: '.postman-api-launchpad/flows/remote-pos/flow.yaml',
      INPUT_POSTMAN_API_KEY: 'pmak-test',
      INPUT_AUTH_CONFIG_JSON: JSON.stringify({
        enabled: true,
        type: 'oauth2',
        grantType: 'client_credentials',
        tokenUrl: '{{auth_token_url}}',
        clientAuthentication: 'body'
      }),
      INPUT_COLLECTION_SYNC_MODE: 'refresh',
      INPUT_SECRETS_RESOLVER_ENABLED: 'false',
      INPUT_FAIL_ON_FLOW_WARNING: 'false',
      INPUT_KEEP_TEMP_COLLECTION_ON_FAILURE: 'false',
      INPUT_TEMP_COLLECTION_PREFIX: '[Smoke][Temp]'
    } as NodeJS.ProcessEnv);

    expect(inputs.projectName).toBe('oreilly-demo-remote-pos-service');
    expect(inputs.workspaceId).toBe('ws-123');
    expect(inputs.specId).toBe('spec-123');
    expect(inputs.smokeCollectionId).toBe('col-123');
    expect(inputs.flowPath).toBe('.postman-api-launchpad/flows/remote-pos/flow.yaml');
    expect(inputs.postmanApiKey).toBe('pmak-test');
    expect(inputs.authConfig?.enabled).toBe(true);
    expect(inputs.authConfig?.type).toBe('oauth2');
    if (inputs.authConfig?.type === 'oauth2') {
      expect(inputs.authConfig.tokenUrl).toBe('{{auth_token_url}}');
    }
    // legacy boolean spelling still honoured: false -> no provider
    expect(inputs.secretsResolverProvider).toBe('none');
  });

  it('leaves the secrets resolver off by default so non-AWS consumers ship no doomed request', () => {
    const inputs = readActionInputs({} as NodeJS.ProcessEnv);

    expect(inputs.secretsResolverProvider).toBe('none');
  });

  it('maps the legacy boolean input onto the AWS provider for existing callers', () => {
    const inputs = readActionInputs({
      INPUT_SECRETS_RESOLVER_ENABLED: 'true'
    } as NodeJS.ProcessEnv);

    expect(inputs.secretsResolverProvider).toBe('aws');
  });

  it('reads each supported provider and lets the new input win over the legacy one', () => {
    for (const provider of ['aws', 'azure', 'gcp'] as const) {
      const inputs = readActionInputs({
        INPUT_SECRETS_RESOLVER: provider
      } as NodeJS.ProcessEnv);
      expect(inputs.secretsResolverProvider).toBe(provider);
    }

    const both = readActionInputs({
      INPUT_SECRETS_RESOLVER: 'azure',
      INPUT_SECRETS_RESOLVER_ENABLED: 'true'
    } as NodeJS.ProcessEnv);
    expect(both.secretsResolverProvider).toBe('azure');
  });

  it('rejects an unknown provider instead of silently shipping no helper', () => {
    expect(() =>
      readActionInputs({ INPUT_SECRETS_RESOLVER: 'vault' } as NodeJS.ProcessEnv)
    ).toThrow(/SECRETS_RESOLVER_PROVIDER_INVALID/);
  });

  it('resolves credentials from flags, action inputs, then plain environment variables', () => {
    const plain = readActionInputs({
      POSTMAN_API_KEY: 'plain-api-key',
      POSTMAN_ACCESS_TOKEN: 'plain-access-token'
    });
    expect(plain.postmanApiKey).toBe('plain-api-key');
    expect(plain.postmanAccessToken).toBe('plain-access-token');

    const actionInput = readActionInputs({
      INPUT_POSTMAN_API_KEY: 'input-api-key',
      INPUT_POSTMAN_ACCESS_TOKEN: 'input-access-token',
      POSTMAN_API_KEY: 'plain-api-key',
      POSTMAN_ACCESS_TOKEN: 'plain-access-token'
    });
    expect(actionInput.postmanApiKey).toBe('input-api-key');
    expect(actionInput.postmanAccessToken).toBe('input-access-token');

    const parsed = parseCliArgs(
      [
        'node',
        'postman-smoke-flow',
        '--postman-api-key',
        'flag-api-key',
        '--postman-access-token',
        'flag-access-token'
      ],
      {}
    );
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') {
      return;
    }
    const cli = readActionInputs({
      INPUT_POSTMAN_API_KEY: 'input-api-key',
      INPUT_POSTMAN_ACCESS_TOKEN: 'input-access-token',
      POSTMAN_API_KEY: 'plain-api-key',
      POSTMAN_ACCESS_TOKEN: 'plain-access-token',
      ...parsed.env
    });
    expect(cli.postmanApiKey).toBe('flag-api-key');
    expect(cli.postmanAccessToken).toBe('flag-access-token');
  });

  it('treats missing flow-path as undefined for no-flow Smoke refreshes', () => {
    const inputs = readActionInputs({
      INPUT_PROJECT_NAME: 'providers-process-api',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_SPEC_ID: 'spec-123',
      INPUT_SMOKE_COLLECTION_ID: 'col-123',
      INPUT_POSTMAN_API_KEY: 'pmak-test',
      INPUT_AUTH_CONFIG_JSON: JSON.stringify({
        enabled: true,
        type: 'oauth2',
        grantType: 'client_credentials',
        tokenUrl: '{{auth_token_url}}',
        clientAuthentication: 'body'
      })
    } as NodeJS.ProcessEnv);

    expect(inputs.flowPath).toBeUndefined();
    expect(inputs.authConfig?.enabled).toBe(true);
  });

  it('accepts API key auth config for Smoke runtime auth injection', () => {
    const inputs = readActionInputs({
      INPUT_AUTH_CONFIG_JSON: JSON.stringify({
        enabled: true,
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        variables: {
          apiKey: 'service_api_key'
        }
      })
    } as NodeJS.ProcessEnv);

    expect(inputs.authConfig).toEqual({
      enabled: true,
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
      variables: {
        apiKey: 'service_api_key'
      }
    });
  });

  it('rejects API key auth config without a supported location', () => {
    expect(() =>
      readActionInputs({
        INPUT_AUTH_CONFIG_JSON: JSON.stringify({
          enabled: true,
          type: 'apiKey',
          in: 'cookie',
          name: 'X-API-Key'
        })
      } as NodeJS.ProcessEnv)
    ).toThrow('apiKey in must be one of: header, query');
  });

  it('rejects API key auth config without a key name', () => {
    expect(() =>
      readActionInputs({
        INPUT_AUTH_CONFIG_JSON: JSON.stringify({
          enabled: true,
          type: 'apiKey',
          in: 'header',
          name: ' '
        })
      } as NodeJS.ProcessEnv)
    ).toThrow('apiKey name is required');
  });

  it('rejects blank API key variable names', () => {
    expect(() =>
      readActionInputs({
        INPUT_AUTH_CONFIG_JSON: JSON.stringify({
          enabled: true,
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          variables: {
            apiKey: ' '
          }
        })
      } as NodeJS.ProcessEnv)
    ).toThrow('variables.apiKey must be a non-empty string');
  });

  it('loads an auth plan and rejects combining it with legacy auth config', () => {
    const inputs = readActionInputs({
      INPUT_AUTH_PLAN_PATH: 'examples/auth-plan.yaml'
    } as NodeJS.ProcessEnv);

    expect(inputs.authPlanPath).toBe('examples/auth-plan.yaml');
    expect(inputs.authPlan?.profiles['payments-entra']?.type).toBe('oauth2');

    expect(() =>
      readActionInputs({
        INPUT_AUTH_PLAN_PATH: 'examples/auth-plan.yaml',
        INPUT_AUTH_CONFIG_JSON: JSON.stringify({
          enabled: true,
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key'
        })
      } as NodeJS.ProcessEnv)
    ).toThrow('mutually exclusive');
  });
});
