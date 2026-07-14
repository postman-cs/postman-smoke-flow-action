import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

describe('CI dist verification contract', () => {
  it('builds once before fan-out and uses only the read-only dist assertion in the gate', () => {
    expect(ciWorkflow.match(/npm run build/g)).toHaveLength(1);
    expect(ciWorkflow.match(/npm run verify:dist:assert/g)).toHaveLength(1);
    expect(ciWorkflow).not.toMatch(/npm run verify:dist(?:\s|$)/m);
    expect(ciWorkflow.indexOf('npm run build')).toBeLessThan(ciWorkflow.indexOf('name: Run gates'));
  });
});
