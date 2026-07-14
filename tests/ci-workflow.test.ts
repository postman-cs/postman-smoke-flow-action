import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

describe('CI dist verification contract', () => {
  it('bundles once, typechecks once, caps fan-out, and keeps dist read-only', () => {
    expect(ciWorkflow.match(/npm run bundle/g)).toHaveLength(1);
    expect(ciWorkflow).not.toContain('- run: npm run build');
    expect(ciWorkflow.match(/npm run typecheck/g)).toHaveLength(1);
    expect(ciWorkflow.match(/npm run verify:dist:assert/g)).toHaveLength(1);
    expect(ciWorkflow).not.toMatch(/npm run verify:dist(?:\s|$)/m);
    expect(ciWorkflow.indexOf('npm run bundle')).toBeLessThan(ciWorkflow.indexOf('name: Run gates'));
    expect(ciWorkflow).toContain('MAX_PARALLEL_GATES=2');
    expect(ciWorkflow).toContain('wait -n -p finished_pid');
  });
});
