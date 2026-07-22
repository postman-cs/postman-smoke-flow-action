import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const monitorScript = readFileSync(
  join(process.cwd(), '.github/scripts/dispatch-e2e-monitor.mjs'),
  'utf8'
);
const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

describe('e2e monitor-dispatch contract', () => {
  it('posts a single native-fetch dispatch with legacy-compatible inputs', () => {
    expect(monitorScript).toContain("method: 'POST'");
    expect(monitorScript).toContain('gate_correlation_id');
    expect(monitorScript).toContain('action');
    expect(monitorScript).toContain('ref: refName');
    expect(monitorScript).toContain('suite');
    expect(monitorScript).toMatch(/fetch\(/);
    expect((monitorScript.match(/method:\s*'POST'/g) ?? []).length).toBe(1);
  });

  it('does not wait, poll, back off, or enforce a gate timeout', () => {
    expect(monitorScript).not.toContain('DEFAULT_TIMEOUT_SECONDS');
    expect(monitorScript).not.toContain('DEFAULT_POLL_SECONDS');
    expect(monitorScript).not.toContain('TRANSIENT_BACKOFF');
    expect(monitorScript).not.toContain('waitForMatchingRun');
    expect(monitorScript).not.toContain('waitForTerminalRun');
    expect(monitorScript).not.toContain('pollGet');
    expect(monitorScript).not.toContain('setTimeout');
    expect(releaseWorkflow).not.toContain('live-e2e-gate:');
    expect(releaseWorkflow).not.toContain('gate_required');
  });
});
