import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DISPATCH_TIMEOUT_MS,
  buildDispatchInputs,
  buildDispatchUrl,
  dispatchE2eMonitor,
  formatDispatchFailureWarning,
  reportDispatchFailure
} from './dispatch-e2e-monitor.mjs';

const baseEnv = {
  E2E_DISPATCH_TOKEN: 'test-token-secret',
  GITHUB_REPOSITORY: 'postman-cs/postman-smoke-flow-action',
  E2E_GATE_REF: 'v2.1.6',
  E2E_GATE_SUITE: 'smoke'
};

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dispatch-e2e-monitor.mjs'), 'utf8');

test('buildDispatchInputs pins the immutable action ref and smoke suite', () => {
  assert.deepEqual(buildDispatchInputs({ action: 'postman-smoke-flow-action', refName: 'v2.1.6', suite: 'smoke' }), {
    action: 'postman-smoke-flow-action',
    ref: 'v2.1.6',
    suite: 'smoke'
  });
  assert.throws(() => buildDispatchInputs({ action: 'x', refName: 'v1', suite: 'fast' }), /smoke or full/);
});

test('buildDispatchUrl validates and encodes owner/repo/workflow segments', () => {
  assert.equal(
    buildDispatchUrl('postman-cs/postman-actions-e2e', 'e2e.yml'),
    'https://api.github.com/repos/postman-cs/postman-actions-e2e/actions/workflows/e2e.yml/dispatches'
  );
  assert.throws(() => buildDispatchUrl('../evil/repo', 'e2e.yml'), /owner\/repo/);
  assert.throws(() => buildDispatchUrl('postman-cs/postman-actions-e2e', '../e2e.yml'), /path segment/);
});

test('dispatchE2eMonitor posts once with exact immutable smoke payload and bounded signal', async () => {
  const calls = [];
  const notices = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 204 };
  };

  await dispatchE2eMonitor({
    env: baseEnv,
    fetchImpl,
    log: (message) => notices.push(message)
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://api.github.com/repos/postman-cs/postman-actions-e2e/actions/workflows/e2e.yml/dispatches'
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token-secret');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.ok(calls[0].init.signal instanceof globalThis.AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ref: 'main',
    inputs: {
      action: 'postman-smoke-flow-action',
      ref: 'v2.1.6',
      suite: 'smoke'
    }
  });
  assert.equal(notices.length, 1);
  assert.equal(notices[0], '::notice::Dispatched asynchronous smoke E2E monitor for v2.1.6');
  assert.equal(DEFAULT_DISPATCH_TIMEOUT_MS, 30_000);
});

test('dispatchE2eMonitor rejects missing required env without leaking a token', async () => {
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: { E2E_DISPATCH_TOKEN: 'secret-token' },
        fetchImpl: async () => ({ ok: true, status: 204 })
      }),
    (error) => {
      assert.match(String(error.message), /E2E_DISPATCH_TOKEN, GITHUB_REPOSITORY, and GITHUB_REF_NAME are required/);
      assert.doesNotMatch(String(error.message), /secret-token/);
      return true;
    }
  );
});

test('dispatchE2eMonitor rejects an invalid suite before fetch', async () => {
  let called = 0;
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: { ...baseEnv, E2E_GATE_SUITE: 'fast' },
        fetchImpl: async () => {
          called += 1;
          return { ok: true, status: 204 };
        }
      }),
    /smoke or full/
  );
  assert.equal(called, 0);
});

test('dispatchE2eMonitor throws status-only errors without disclosing the token', async () => {
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: baseEnv,
        fetchImpl: async () => ({ ok: false, status: 502 })
      }),
    (error) => {
      assert.equal(String(error.message), 'E2E monitor dispatch failed with HTTP 502');
      assert.doesNotMatch(String(error.message), /test-token-secret/);
      return true;
    }
  );
});

test('dispatchE2eMonitor rejects when a tiny injected timeout aborts the request', async () => {
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: baseEnv,
        timeoutMs: 1,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              'abort',
              () => {
                reject(init.signal.reason);
              },
              { once: true }
            );
          })
      }),
    (error) => {
      assert.equal(error.name, 'TimeoutError');
      assert.doesNotMatch(String(error.message ?? error), /test-token-secret/);
      return true;
    }
  );
});

test('failed dispatch warning keeps HTTP status, redacts tokens, and is wired in the CLI catch', () => {
  assert.equal(
    formatDispatchFailureWarning(new Error('E2E monitor dispatch failed with HTTP 502'), ['test-token-secret']),
    '::warning::E2E monitor dispatch failed with HTTP 502'
  );
  assert.equal(
    formatDispatchFailureWarning(new Error('boom test-token-secret HTTP 403'), ['test-token-secret']),
    '::warning::boom [redacted] HTTP 403'
  );

  const warnings = [];
  reportDispatchFailure(new Error('E2E monitor dispatch failed with HTTP 503'), {
    env: { E2E_DISPATCH_TOKEN: 'test-token-secret' },
    log: (message) => warnings.push(message)
  });
  assert.deepEqual(warnings, ['::warning::E2E monitor dispatch failed with HTTP 503']);
  assert.match(source, /reportDispatchFailure\(error\);/);
  assert.match(source, /process\.exit\(1\);/);
  assert.doesNotMatch(source, /console\.error\(error\.message\)/);
});
