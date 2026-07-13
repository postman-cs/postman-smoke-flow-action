// Verifies the access-token -> session-identity -> account_type telemetry wiring
// by spying the telemetry context. The collection reshape is not exercised: a
// missing required input makes runSmokeFlow throw, and account_type must still be
// set (from the iapub session consumerType) before the failure emit.
const telemetrySpy = {
  setTeamId: vi.fn(),
  setAccountType: vi.fn(),
  emitCompletion: vi.fn()
};

vi.mock('@postman-cse/automation-telemetry-core', () => ({
  createTelemetryContext: () => telemetrySpy
}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAction } from '../src/index.js';
import { __resetIdentityMemo } from '../src/postman/credential-identity.js';
import type { CoreLike } from '../src/types.js';

function silentCore(): CoreLike {
  return {
    info: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    setSecret: vi.fn()
  };
}

beforeEach(() => {
  telemetrySpy.setTeamId.mockClear();
  telemetrySpy.setAccountType.mockClear();
  telemetrySpy.emitCompletion.mockClear();
  __resetIdentityMemo();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('smoke-flow telemetry account_type', () => {
  it('resolves consumerType from the access-token session and sets account_type before emit', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/api/sessions/current')) {
        return new Response(
          JSON.stringify({ session: { identity: { team: '10490519' }, consumerType: 'service_account' } }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const env: NodeJS.ProcessEnv = {
      INPUT_POSTMAN_API_KEY: 'PMAK-xyz',
      INPUT_POSTMAN_ACCESS_TOKEN: 'pma_at_service',
      INPUT_PROJECT_NAME: 'payments',
      // Required inputs are valid; reshape fails later against stubbed fetch,
      // exercising the failure emit path after validation/side-effect setup.
      INPUT_WORKSPACE_ID: 'ws-1',
      INPUT_SPEC_ID: 'spec-1',
      INPUT_SMOKE_COLLECTION_ID: 'col-1'
    };

    await expect(runAction(silentCore(), env)).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://iapub.postman.co/api/sessions/current',
      expect.objectContaining({ headers: { 'x-access-token': 'pma_at_service' } })
    );
    expect(telemetrySpy.setAccountType).toHaveBeenCalledWith('service_account');
    expect(telemetrySpy.emitCompletion).toHaveBeenCalledWith('failure');
  });

  it('leaves account_type unknown when no access token is present (no session probe)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const env: NodeJS.ProcessEnv = {
      INPUT_POSTMAN_API_KEY: 'PMAK-xyz',
      INPUT_PROJECT_NAME: 'payments',
      INPUT_WORKSPACE_ID: 'ws-1',
      INPUT_SPEC_ID: 'spec-1',
      INPUT_SMOKE_COLLECTION_ID: 'col-1'
    };

    await expect(runAction(silentCore(), env)).rejects.toThrow();

    // no iapub probe fired
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/sessions/current'))).toBe(false);
    expect(telemetrySpy.setAccountType).toHaveBeenCalledWith(undefined);
  });
});
