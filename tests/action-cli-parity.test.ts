import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { smokeFlowActionContract } from '../src/contracts.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * P3 drift gate (.plans/e2e-suite-tuneup.md): the CLI derives its known
 * option set from smokeFlowActionContract.inputs (src/lib/cli-args.ts), so
 * asserting contract inputs == action.yml inputs transitively guarantees
 * action.yml <-> CLI flag parity for this action.
 */

describe('action.yml <-> CLI flag parity (via smokeFlowActionContract)', () => {
  it('contract inputs equal action.yml inputs in both directions', () => {
    const manifest = parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8')) as {
      inputs?: Record<string, unknown>;
    };
    const manifestInputs = Object.keys(manifest.inputs ?? {}).sort();
    const contractInputs = Object.keys(smokeFlowActionContract.inputs).sort();
    expect(contractInputs).toEqual(manifestInputs);
  });
});
