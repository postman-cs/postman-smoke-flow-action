/**
 * Deterministic credential × team-id matrix for smoke-flow's actual contract.
 *
 * Smoke-flow does not auto-detect org via ums squads: explicit `team-id` (or
 * POSTMAN_TEAM_ID) turns on org-mode and sets gateway `x-entity-team-id`;
 * absent team-id is non-org (no header). Account type comes from the access-
 * token iapub session after credential preflight.
 *
 * Owning seams only (no network, no new production helpers):
 * - mintAccessTokenIfNeeded — PMAK-only eager mint
 * - runCredentialPreflight + getMemoizedSessionIdentity — account_type source
 * - AccessTokenGatewayClient — emits x-entity-team-id when teamId + orgMode
 * - createSmokeClient wiring in index.ts — teamId present ⇒ orgMode: true
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountTypeFromConsumer,
  type AccountType
} from '@postman-cse/automation-telemetry-core';

import { readActionInputs, resolveGatewayTeamContext } from '../src/index.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { mintAccessTokenIfNeeded, AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { createSecretMasker } from '../src/lib/secrets.js';
import {
  __resetIdentityMemo,
  getMemoizedSessionIdentity,
  runCredentialPreflight
} from '../src/postman/credential-identity.js';

const TEAM_ID = '10490519';
const PMAK = 'PMAK-matrix-test';
const PROVIDED_TOKEN = 'pma_at_provided';
const MINTED_TOKEN = 'pma_at_minted';
const API_BASE = 'https://api.getpostman.com';
const IAPUB_BASE = 'https://iapub.postman.co';
const BIFROST = 'https://bifrost-premium-https-v4.gw.postman.com';

type CredShape = 'pmak-only' | 'token-only' | 'both';
type TeamShape = 'present' | 'absent';

interface MatrixCase {
  cred: CredShape;
  team: TeamShape;
  expectMint: boolean;
  expectAccessToken: string;
  expectAccountType: AccountType;
  expectEntityTeamHeader: string | undefined;
}

const MATRIX: MatrixCase[] = (['pmak-only', 'token-only', 'both'] as const).flatMap((cred) =>
  (['present', 'absent'] as const).map((team) => {
    const expectMint = cred === 'pmak-only';
    const expectAccessToken = cred === 'pmak-only' ? MINTED_TOKEN : PROVIDED_TOKEN;
    return {
      cred,
      team,
      expectMint,
      expectAccessToken,
      expectAccountType: 'service' as const,
      expectEntityTeamHeader: team === 'present' ? TEAM_ID : undefined
    };
  })
);

function credEnv(cred: CredShape, team: TeamShape): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    INPUT_PROJECT_NAME: 'payments',
    INPUT_WORKSPACE_ID: 'ws-1',
    INPUT_SPEC_ID: 'spec-1',
    INPUT_SMOKE_COLLECTION_ID: 'col-1'
  };
  if (cred === 'pmak-only' || cred === 'both') {
    env.INPUT_POSTMAN_API_KEY = PMAK;
  }
  if (cred === 'token-only' || cred === 'both') {
    env.INPUT_POSTMAN_ACCESS_TOKEN = PROVIDED_TOKEN;
  }
  if (team === 'present') {
    env.INPUT_TEAM_ID = TEAM_ID;
  }
  return env;
}

function createFetchSpy(): {
  fetchImpl: typeof fetch;
  mintCount: () => number;
  sessionTokens: () => string[];
  proxyHeaders: () => Array<Record<string, string>>;
} {
  let mintCount = 0;
  const sessionTokens: string[] = [];
  const proxyHeaders: Array<Record<string, string>> = [];

  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (url === `${API_BASE}/service-account-tokens` && method === 'POST') {
      mintCount += 1;
      expect(headers['x-api-key']).toBe(PMAK);
      return new Response(JSON.stringify({ access_token: MINTED_TOKEN }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url === `${API_BASE}/me`) {
      return new Response(JSON.stringify({ user: { id: 1, teamId: Number(TEAM_ID) } }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url === `${IAPUB_BASE}/api/sessions/current`) {
      sessionTokens.push(String(headers['x-access-token'] ?? ''));
      return new Response(
        JSON.stringify({
          session: { identity: { team: TEAM_ID }, consumerType: 'service_account' }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url === `${BIFROST}/ws/proxy`) {
      proxyHeaders.push({ ...headers });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  return {
    fetchImpl,
    mintCount: () => mintCount,
    sessionTokens: () => sessionTokens,
    proxyHeaders: () => proxyHeaders
  };
}

beforeEach(() => __resetIdentityMemo());
afterEach(() => vi.restoreAllMocks());

describe('contract: smoke-flow credential × team-id matrix', () => {
  it.each(MATRIX)(
    '{$cred, team=$team}: mint=$expectMint, account_type=$expectAccountType, x-entity-team-id=$expectEntityTeamHeader',
    async ({
      cred,
      team,
      expectMint,
      expectAccessToken,
      expectAccountType,
      expectEntityTeamHeader
    }) => {
      const spy = createFetchSpy();
      const env = credEnv(cred, team);
      const inputs = readActionInputs(env);

      const mintHolder = {
        postmanAccessToken: inputs.postmanAccessToken,
        postmanApiKey: inputs.postmanApiKey,
        postmanApiBase: inputs.postmanApiBaseUrl
      };
      await mintAccessTokenIfNeeded(
        mintHolder,
        { info: () => {}, warning: () => {} },
        undefined,
        spy.fetchImpl
      );
      inputs.postmanAccessToken = mintHolder.postmanAccessToken;

      expect(spy.mintCount()).toBe(expectMint ? 1 : 0);
      expect(inputs.postmanAccessToken).toBe(expectAccessToken);

      await runCredentialPreflight({
        apiBaseUrl: inputs.postmanApiBaseUrl,
        iapubBaseUrl: inputs.postmanIapubBaseUrl,
        postmanApiKey: inputs.postmanApiKey,
        postmanAccessToken: inputs.postmanAccessToken,
        explicitTeamId: inputs.teamId || undefined,
        mode: 'warn',
        mask: createSecretMasker([inputs.postmanApiKey, inputs.postmanAccessToken]),
        log: { info: () => {}, warning: () => {} },
        fetchImpl: spy.fetchImpl
      });

      const session = getMemoizedSessionIdentity();
      expect(session?.consumerType).toBe('service_account');
      expect(accountTypeFromConsumer(session?.consumerType)).toBe(expectAccountType);
      expect(spy.sessionTokens()).toEqual([expectAccessToken]);

      // createSmokeClient wiring: teamId present ⇒ orgMode true on the gateway.
      const teamId = String(inputs.teamId ?? '').trim();
      expect(teamId).toBe(team === 'present' ? TEAM_ID : '');
      const provider = new AccessTokenProvider({ accessToken: expectAccessToken });
      const gateway = new AccessTokenGatewayClient({
        tokenProvider: provider,
        fetchImpl: spy.fetchImpl,
        ...resolveGatewayTeamContext(inputs.teamId)
      });
      await gateway.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/col-1' });

      expect(spy.proxyHeaders()).toHaveLength(1);
      const headers = spy.proxyHeaders()[0]!;
      expect(headers['x-access-token']).toBe(expectAccessToken);
      expect(headers['x-entity-team-id']).toBe(expectEntityTeamHeader);
    }
  );
});
