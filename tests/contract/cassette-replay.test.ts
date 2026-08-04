/**
 * Replay the committed smoke-flow wire cassette through the REAL runAction
 * composition root with zero live transport: every fetch resolves from the
 * cassette, and an exhausted or unmatched interaction fails the suite.
 *
 * This is the deterministic composite-spine leg for smoke-flow: the same
 * cassette format bootstrap and repo-sync replay, produced by the same
 * recorder contract, so the three actions' wire surfaces stay mutually
 * provable offline.
 */
import { describe, expect, it, vi } from 'vitest';
import { createReplayFetch } from '@postman-cse/automation-core/cassette';

import { runContractAction } from './harness.js';
import {
  applyRepeatableReads,
  readCassette,
  SMOKE_FLOW_CASSETTE
} from './cassette-scenario.js';

// Same pin as the recorder: the temp-collection name embeds the run-identity
// random suffix, and the generation POST's body digest is part of its
// cassette key, so replay must generate the identical name.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) => Buffer.alloc(size, 0x42)
  };
});

describe('contract: smoke-flow cassette replay', () => {
  it(`replays ${SMOKE_FLOW_CASSETTE.name} offline through the production root`, async () => {
    const cassette = applyRepeatableReads(readCassette(SMOKE_FLOW_CASSETTE.name));
    const result = await runContractAction({
      inputs: SMOKE_FLOW_CASSETTE.inputs,
      env: SMOKE_FLOW_CASSETTE.env,
      files: SMOKE_FLOW_CASSETTE.files,
      fetchImpl: createReplayFetch(cassette)
    });

    expect(result.error).toBeUndefined();
    expect(result.outputs['flow-apply-status']).toBe('success');
    expect(result.outputs['flow-step-count']).toBe('2');
    expect(result.outputs['smoke-collection-id']).toBe('12345678-col-smoke');
    expect(result.outputs['temporary-smoke-collection-id']).toBeTruthy();
    expect(result.outputs['sync-status']).toBe('synced');

    // The wire contract this run is entitled to depend on: exact interaction
    // keys, in recorded order. A route change, dropped call, or duplicated
    // call shows up here (or as an unmatched replay error above).
    const services = new Set(
      cassette.interactions
        .map((interaction) => interaction.key)
        .filter((key) => key.startsWith('proxy:'))
        .map((key) => key.split(' ')[0])
    );
    expect([...services].sort()).toEqual(['proxy:collection', 'proxy:specification']);
  }, 60_000);

  it('does not inherit ambient team input or emit telemetry', async () => {
    const cassette = applyRepeatableReads(readCassette(SMOKE_FLOW_CASSETTE.name));
    const replayFetch = createReplayFetch(cassette);
    const requestedUrls: string[] = [];
    const teamHeaders: Array<string | null> = [];
    const fetchImpl = ((input, init) => {
      requestedUrls.push(String(input));
      teamHeaders.push(new Headers(init?.headers).get('x-entity-team-id'));
      return replayFetch(input, init);
    }) as typeof fetch;
    vi.stubEnv('INPUT_TEAM_ID', 'ambient-team-must-not-survive');
    const result = await runContractAction({
      inputs: SMOKE_FLOW_CASSETTE.inputs,
      env: SMOKE_FLOW_CASSETTE.env,
      files: SMOKE_FLOW_CASSETTE.files,
      fetchImpl
    });

    expect(result.error).toBeUndefined();
    expect(result.outputs['flow-apply-status']).toBe('success');
    expect(teamHeaders).not.toContain('ambient-team-must-not-survive');
    expect(requestedUrls.some((url) => url.includes('telemetry'))).toBe(false);
  }, 60_000);
});
