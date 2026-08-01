/**
 * Deterministic cassette generator for smoke-flow, not a gate.
 *
 *   npm run record:cassettes
 *
 * Skipped unless RECORD_FAKE_CASSETTES=1 so `npm test` never rewrites committed
 * fixtures. Emits the same cassette format as bootstrap and repo-sync and as a
 * live `record-live` capture, so a sanitized sandbox recording can replace this
 * file without touching the replay suite.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyCassette,
  createRecordingFetch
} from '@postman-cse/automation-core/cassette';

import { createSecretMasker } from '../../src/lib/secrets.js';
import { createPlatform } from './platform-fake.js';
import { runContractAction } from './harness.js';
import {
  applyRepeatableReads,
  cassettePath,
  SMOKE_FLOW_CASSETTE,
  stableCassetteText
} from './cassette-scenario.js';

// Pin the 4-byte random run-identity suffix so the temp-collection name (and
// with it the generation POST body digest in the cassette key) is stable
// across record and replay. Everything else in node:crypto stays real.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) => Buffer.alloc(size, 0x42)
  };
});

const ENABLED = process.env.RECORD_FAKE_CASSETTES === '1';

describe.skipIf(!ENABLED)('record: smoke-flow wire cassette', () => {
  it(`records ${SMOKE_FLOW_CASSETTE.name}`, async () => {
    const cassette = createEmptyCassette();
    const platform = createPlatform(SMOKE_FLOW_CASSETTE.fake);
    const recording = createRecordingFetch(
      platform.fetch,
      cassette,
      createSecretMasker(SMOKE_FLOW_CASSETTE.secrets)
    );

    const result = await runContractAction({
      inputs: SMOKE_FLOW_CASSETTE.inputs,
      env: SMOKE_FLOW_CASSETTE.env,
      files: SMOKE_FLOW_CASSETTE.files,
      fetchImpl: recording
    });

    // Only commit a cassette whose captured run was correct.
    expect(result.error).toBeUndefined();
    expect(platform.state.canonicalPatched).toBe(true);
    expect(platform.state.tempCollectionDeleted).toBe(true);
    expect(result.outputs['flow-apply-status']).toBe('success');
    expect(cassette.interactions.length).toBeGreaterThan(5);

    const target = cassettePath(SMOKE_FLOW_CASSETTE.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, stableCassetteText(applyRepeatableReads(cassette)));
  }, 120_000);
});
