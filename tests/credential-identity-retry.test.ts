import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetIdentityMemo,
  getSessionResolutionFailure,
  resolveSessionIdentity,
  runCredentialPreflight
} from '../src/postman/credential-identity.js';

const API_BASE = 'https://api.getpostman.com';
const IAPUB_BASE = 'https://iapub.postman.co';
const passthroughMask = (value: string) => value;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function sessionPayload(team: unknown = 13347347): Record<string, unknown> {
  return {
    identity: { team, domain: 'field-services-v12-demo' },
    data: { user: { id: 999, fullName: 'Svc Account' } },
    consumerType: 'service_account'
  };
}

function sessionSequence(steps: Array<() => Response>) {
  let n = 0;
  return vi.fn<typeof fetch>(async () => {
    const step = steps[Math.min(n, steps.length - 1)];
    n += 1;
    return step();
  });
}

function createLogCapture() {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    infos,
    warnings,
    log: {
      info: (message: string) => {
        infos.push(message);
      },
      warning: (message: string) => {
        warnings.push(message);
      }
    }
  };
}

describe('event-based session retry (smoke-flow)', () => {
  beforeEach(() => {
    __resetIdentityMemo();
  });

  it('retries a transient 5xx and resolves later via full-jitter through the injected clock', async () => {
    const sleeps: number[] = [];
    const fetchImpl = sessionSequence([
      () => new Response('server error', { status: 503 }),
      () => jsonResponse(sessionPayload(13347347))
    ]);

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'retry-5xx',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      randomImpl: () => 0.5
    });

    expect(identity?.teamId).toBe('13347347');
    expect(sleeps).toEqual([250]);
    expect(getSessionResolutionFailure()).toBeUndefined();
  });

  it('honors Retry-After (seconds) on 429 and clamps a rogue value', async () => {
    const afterSecs: number[] = [];
    const fetchAfter = sessionSequence([
      () => new Response('slow', { status: 429, headers: { 'retry-after': '2' } }),
      () => jsonResponse(sessionPayload(13347347))
    ]);
    await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'retry-after',
      fetchImpl: fetchAfter,
      sleepImpl: async (ms) => {
        afterSecs.push(ms);
      },
      randomImpl: () => 0.99
    });
    expect(afterSecs).toEqual([2000]);

    __resetIdentityMemo();
    const clamped: number[] = [];
    const fetchHuge = sessionSequence([
      () => new Response('slow', { status: 503, headers: { 'retry-after': '9999' } }),
      () => jsonResponse(sessionPayload(13347347))
    ]);
    await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'retry-after-huge',
      fetchImpl: fetchHuge,
      sleepImpl: async (ms) => {
        clamped.push(ms);
      },
      randomImpl: () => 0
    });
    expect(clamped).toEqual([8000]);
  });

  it('does NOT retry or sleep on 401 and classifies auth', async () => {
    const sleeps: number[] = [];
    const fetchImpl = sessionSequence([() => new Response('nope', { status: 401 })]);
    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'auth-401',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      }
    });
    expect(identity).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(0);
    expect(getSessionResolutionFailure()).toBe('auth');
  });

  it('runCredentialPreflight enforce FAILS closed when the session stays unresolved (auth)', async () => {
    const capture = createLogCapture();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return jsonResponse({ user: { id: 1, teamId: 10490519, teamName: 'jared-demo' } });
      }
      return new Response('expired', { status: 401 });
    });
    await expect(
      runCredentialPreflight({
        apiBaseUrl: API_BASE,
        iapubBaseUrl: IAPUB_BASE,
        postmanApiKey: 'pmak-enforce-unresolved',
        postmanAccessToken: 'access-token-expired',
        mode: 'enforce',
        mask: passthroughMask,
        log: capture.log,
        fetchImpl,
        sleepImpl: async () => undefined
      })
    ).rejects.toThrow(/enforce requires a resolvable session identity/);
  });

  it('runCredentialPreflight warn continues when the session stays unresolved (unavailable)', async () => {
    const capture = createLogCapture();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return jsonResponse({ user: { id: 1, teamId: 10490519, teamName: 'jared-demo' } });
      }
      return new Response('unavailable', { status: 503 });
    });
    await expect(
      runCredentialPreflight({
        apiBaseUrl: API_BASE,
        iapubBaseUrl: IAPUB_BASE,
        postmanApiKey: 'pmak-warn-unresolved',
        postmanAccessToken: 'access-token-transient',
        mode: 'warn',
        mask: passthroughMask,
        log: capture.log,
        fetchImpl,
        sleepImpl: async () => undefined,
        randomImpl: () => 0
      })
    ).resolves.toBeUndefined();
    expect(
      capture.warnings.some((entry) => entry.includes('iapub was unreachable after retries'))
    ).toBe(true);
  });
});
