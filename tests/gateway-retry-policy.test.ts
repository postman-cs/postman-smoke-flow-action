import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';

function makeGateway(fetchImpl: typeof fetch) {
  const sleep = vi.fn(async () => undefined);
  return {
    client: new AccessTokenGatewayClient({
      tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
      fetchImpl,
      sleepImpl: sleep,
      retryBaseDelayMs: 1
    }),
    sleep
  };
}

describe('gateway retry policy', () => {
  it('retries safe GET envelopes after transient responses', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('unavailable', { status: 503 })
        : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const { client, sleep } = makeGateway(fetchImpl);

    await expect(client.request({ service: 'collection', method: 'get', path: '/safe' })).resolves.toBeDefined();
    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it.each(['post', 'patch', 'delete'] as const)('does not blindly retry unsafe %s envelopes', async (method) => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      return new Response('unavailable', { status: 503 });
    }) as unknown as typeof fetch;
    const { client, sleep } = makeGateway(fetchImpl);

    await expect(client.request({ service: 'collection', method, path: '/unsafe' })).rejects.toThrow('503');
    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('classifies a 200 inner error envelope as a failure instead of returning it as success', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'downstream unavailable' }
    }), { status: 200 })) as unknown as typeof fetch;
    const { client, sleep } = makeGateway(fetchImpl);

    await expect(client.request({ service: 'collection', method: 'get', path: '/safe' })).rejects.toThrow('500');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
