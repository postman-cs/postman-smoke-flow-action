import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const dispatchScript = readFileSync(join(process.cwd(), '.github/scripts/dispatch-e2e-monitor.mjs'), 'utf8');

describe('asynchronous e2e monitor dispatch', () => {
  it('bounds the one-shot dispatch with AbortSignal and forbids poll/wait helpers', () => {
    expect(dispatchScript).toContain("env.E2E_GATE_SUITE ?? 'smoke'");
    expect(dispatchScript).toContain('actions/workflows/');
    expect(dispatchScript).toContain('/dispatches');
    expect(dispatchScript).toContain('AbortSignal.timeout');
    expect(dispatchScript).toContain('DEFAULT_DISPATCH_TIMEOUT_MS');
    expect(dispatchScript).not.toContain('waitForTerminalRun');
    expect(dispatchScript).not.toContain('waitForMatchingRun');
    expect(dispatchScript).not.toContain('DEFAULT_POLL_SECONDS');
    expect(dispatchScript).not.toContain('gate_required');
  });
});
