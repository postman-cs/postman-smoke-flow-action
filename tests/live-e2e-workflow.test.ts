import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

describe('live e2e tiering contract', () => {
  it('keeps live sandbox work off PRs and monitor-dispatches after immutable publishes', () => {
    expect(existsSync(join(process.cwd(), '.github/workflows/live-e2e.yml'))).toBe(false);
    expect(releaseWorkflow).not.toContain('live-e2e-gate:');
    expect(releaseWorkflow).toContain('dispatch-live-monitor:');
    expect(releaseWorkflow).toContain('E2E_GATE_SUITE: smoke');
    expect(releaseWorkflow).toContain('node .github/scripts/dispatch-e2e-monitor.mjs');
    expect(releaseWorkflow).not.toContain('wait-for-e2e-gate.mjs');
  });
});
