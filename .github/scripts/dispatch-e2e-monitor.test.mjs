import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildCorrelationId,
  buildDispatchInputs,
  normalizeRunDetails,
  normalizeSuite
} from './dispatch-e2e-monitor.mjs';

const scriptSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dispatch-e2e-monitor.mjs'), 'utf8');

test('normalizes smoke/full suite and rejects unknown values', () => {
  assert.equal(normalizeSuite(undefined), 'smoke');
  assert.equal(normalizeSuite(''), 'smoke');
  assert.equal(normalizeSuite(' smoke '), 'smoke');
  assert.equal(normalizeSuite('full'), 'full');
  assert.throws(() => normalizeSuite('fast'), /E2E_GATE_SUITE must be smoke or full/);
});

test('buildDispatchInputs keeps legacy-compatible action/ref/gate_correlation_id/suite', () => {
  assert.deepEqual(
    buildDispatchInputs({
      action: 'postman-smoke-flow-action',
      refName: 'v2.1.6',
      correlationId: 'corr-123',
      failureInjection: '',
      suite: 'smoke'
    }),
    {
      action: 'postman-smoke-flow-action',
      ref: 'v2.1.6',
      gate_correlation_id: 'corr-123',
      failure_injection: '',
      suite: 'smoke'
    }
  );
});

test('buildCorrelationId creates a stable run-scoped identifier', () => {
  assert.equal(
    buildCorrelationId({
      repository: 'postman-cs/postman-smoke-flow-action',
      runId: '12345',
      runAttempt: '2',
      refName: 'v2.1.6'
    }),
    'postman-cs-postman-smoke-flow-action-12345-2-v2.1.6'
  );
});

test('normalizes dispatch response run details when present', () => {
  assert.deepEqual(
    normalizeRunDetails({
      workflow_run_id: 456,
      run_url: 'https://api.github.com/repos/postman-cs/postman-actions-e2e/actions/runs/456',
      html_url: 'https://github.com/postman-cs/postman-actions-e2e/actions/runs/456'
    }),
    {
      id: 456,
      url: 'https://api.github.com/repos/postman-cs/postman-actions-e2e/actions/runs/456',
      htmlUrl: 'https://github.com/postman-cs/postman-actions-e2e/actions/runs/456'
    }
  );

  assert.equal(normalizeRunDetails(null), null);
});

test('monitor script is dispatch-only: one POST, no wait/poll/backoff/timeout', () => {
  assert.match(scriptSource, /method:\s*'POST'/);
  assert.doesNotMatch(scriptSource, /DEFAULT_TIMEOUT_SECONDS/);
  assert.doesNotMatch(scriptSource, /DEFAULT_POLL_SECONDS/);
  assert.doesNotMatch(scriptSource, /TRANSIENT_BACKOFF/);
  assert.doesNotMatch(scriptSource, /waitForMatchingRun|waitForTerminalRun|pollGet|setTimeout/);
  assert.doesNotMatch(scriptSource, /return_run_details/);
  assert.equal((scriptSource.match(/method:\s*'POST'/g) ?? []).length, 1);
});
