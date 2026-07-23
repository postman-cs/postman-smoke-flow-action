import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

function job(name: string): string {
  const start = releaseWorkflow.indexOf(`  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = releaseWorkflow.slice(start + 2);
  const next = rest.search(/\n {2}[a-z0-9-]+:/);
  return next === -1 ? releaseWorkflow.slice(start) : releaseWorkflow.slice(start, start + 2 + next);
}

describe('live e2e tiering contract', () => {
  it('scopes the post-publish smoke monitor off PRs and after immutable publish', () => {
    expect(existsSync(join(process.cwd(), '.github/workflows/live-e2e.yml'))).toBe(false);
    expect(ciWorkflow).not.toContain('dispatch-e2e-monitor.mjs');
    expect(ciWorkflow).not.toContain('E2E_DISPATCH_TOKEN');
    expect(ciWorkflow).not.toContain('dispatch-live-monitor');

    const dispatch = job('dispatch-live-monitor');
    expect(dispatch).toContain('needs: [classify, publish]');
    expect(dispatch).toContain(
      "if: ${{ needs.classify.outputs.release_kind == 'immutable' && needs.publish.result == 'success' }}"
    );
    expect(dispatch).toContain('continue-on-error: true');
    expect(dispatch).toContain('E2E_GATE_SUITE: smoke');
    expect(dispatch).toContain('E2E_GATE_REF: ${{ github.ref_name }}');
    expect(dispatch).toContain('node .github/scripts/dispatch-e2e-monitor.mjs');
    expect(dispatch).not.toContain('live-e2e-gate');
    expect(dispatch).not.toContain('gate_required');
    expect(dispatch).not.toContain('wait-for-e2e-gate.mjs');
  });
});
