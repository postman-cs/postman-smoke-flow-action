import { describe, expect, it } from 'vitest';

import { PostmanSmokeClient } from '../src/postman/postman-smoke-client.js';

function makeResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

function makeClient(fetchImpl: typeof fetch): PostmanSmokeClient {
  return new PostmanSmokeClient('test-key', 'https://api.getpostman.com', fetchImpl);
}

describe('PostmanSmokeClient error advice surfacing', () => {
  it('getCollection 401 throws with advice naming the collection uid', async () => {
    const client = makeClient(() => Promise.resolve(makeResponse(401, '{"error":"Unauthorized"}')));
    await expect(client.getCollection('col-abc')).rejects.toThrow(/col-abc/);
    await expect(client.getCollection('col-abc')).rejects.toThrow(/postman-api-key/);
  });

  it('getCollection 403 throws with advice naming the collection uid', async () => {
    const client = makeClient(() => Promise.resolve(makeResponse(403, '{"error":"Forbidden"}')));
    await expect(client.getCollection('col-abc')).rejects.toThrow(/col-abc/);
    await expect(client.getCollection('col-abc')).rejects.toThrow(/postman-api-key/);
  });

  it('getCollection 404 throws with not-found advice naming the collection uid', async () => {
    const client = makeClient(() => Promise.resolve(makeResponse(404, '{"error":"Not Found"}')));
    await expect(client.getCollection('col-abc')).rejects.toThrow(/col-abc/);
    await expect(client.getCollection('col-abc')).rejects.toThrow(/wrong-team/);
  });

  it('updateCollection 401 throws with write-context advice', async () => {
    const client = makeClient(() => Promise.resolve(makeResponse(401, '{"error":"Unauthorized"}')));
    await expect(client.updateCollection('col-xyz', {})).rejects.toThrow(/col-xyz/);
    await expect(client.updateCollection('col-xyz', {})).rejects.toThrow(/postman-api-key/);
  });

  it('updateCollection 403 throws with write-context advice', async () => {
    const client = makeClient(() => Promise.resolve(makeResponse(403, '{"error":"Forbidden"}')));
    await expect(client.updateCollection('col-xyz', {})).rejects.toThrow(/col-xyz/);
    await expect(client.updateCollection('col-xyz', {})).rejects.toThrow(/postman-api-key/);
  });

  it('updateCollection 404 throws with not-found advice', async () => {
    const client = makeClient(() => Promise.resolve(makeResponse(404, '{"error":"Not Found"}')));
    await expect(client.updateCollection('col-xyz', {})).rejects.toThrow(/col-xyz/);
  });

  it('getCollection 500 throws the original HttpError without advice text', async () => {
    const client = makeClient(() => Promise.resolve(makeResponse(500, 'Internal Server Error')));
    await expect(client.getCollection('col-abc')).rejects.toThrow(/GET.*failed: 500/);
  });

  it('deleteCollection 404 is silently swallowed (existing behavior preserved)', async () => {
    const client = makeClient(() => Promise.resolve(makeResponse(404, '{"error":"Not Found"}')));
    await expect(client.deleteCollection('col-gone')).resolves.toBeUndefined();
  });

  it('deleteCollection 401 still throws (existing behavior preserved)', async () => {
    const client = makeClient(() => Promise.resolve(makeResponse(401, '{"error":"Unauthorized"}')));
    await expect(client.deleteCollection('col-abc')).rejects.toThrow();
  });
});
