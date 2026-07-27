import { describe, expect, it, vi } from 'vitest';
import { createLogger, type LogSink } from '@postman-cse/automation-core';

import { runAction } from '../src/index.js';
import type { CoreLike } from '../src/types.js';

/**
 * A log line is evidence. These tests pin the properties that make it worth
 * trusting: credentials never survive into it, a failure names the phase it
 * died in, and debug output is opt-in rather than always-on.
 */

function recordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      debug: (message) => lines.push(`debug ${message}`),
      info: (message) => lines.push(`info ${message}`),
      warning: (message) => lines.push(`warning ${message}`),
      error: (message) => lines.push(`error ${message}`)
    }
  };
}

const PMAK = 'PMAK-smokeflowtestkey-0123456789';

function silentCore(): CoreLike & { secrets: string[] } {
  const secrets: string[] = [];
  return {
    secrets,
    setOutput: () => {},
    setSecret: (secret: string) => {
      secrets.push(secret);
    },
    info: () => {},
    warning: () => {},
    setFailed: () => {}
  };
}

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    INPUT_PROJECT_NAME: 'payments',
    INPUT_WORKSPACE_ID: 'ws-1',
    INPUT_SPEC_ID: 'spec-1',
    INPUT_SMOKE_COLLECTION_ID: 'col-1',
    INPUT_POSTMAN_API_KEY: PMAK,
    ...overrides
  };
}

describe('smoke-flow logging', () => {
  it('never emits the credential it was handed, even when upstream echoes it back', async () => {
    // The mint call fails with the key quoted back in the body: an upstream
    // that reflects a credential must not turn a diagnostic into a leak.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`{"message":"rejected ${PMAK}"}`, { status: 401 }))
    );
    const { sink, lines } = recordingSink();
    const core = silentCore();

    await expect(runAction(core, env(), createLogger({ sink, level: 'debug' }))).rejects.toThrow();

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(PMAK);
    vi.unstubAllGlobals();
  });

  it('names the phase that failed instead of leaving only a stack', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const { sink, lines } = recordingSink();

    await expect(
      runAction(silentCore(), env(), createLogger({ sink, level: 'debug' }))
    ).rejects.toThrow();

    const all = lines.join('\n');
    expect(all).toContain('phase=');
    expect(all).toContain('phase failed');
    vi.unstubAllGlobals();
  });

  it('keeps debug chatter out of a default run and opens it under RUNNER_DEBUG', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    async function run(runnerEnv: NodeJS.ProcessEnv): Promise<string[]> {
      const { sink, lines } = recordingSink();
      await runAction(
        silentCore(),
        env(runnerEnv),
        createLogger({ sink, env: runnerEnv })
      ).catch(() => undefined);
      return lines;
    }

    expect((await run({})).filter((line) => line.startsWith('debug'))).toHaveLength(0);
    expect(
      (await run({ RUNNER_DEBUG: '1' })).filter((line) => line.startsWith('debug')).length
    ).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});
