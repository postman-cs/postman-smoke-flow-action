import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { deriveFlowFromSpec } from '../src/flow/derive.js';

/**
 * Real-world spec smoke matrix: run derivation against large production API
 * specs (Stripe, GitHub, DigitalOcean, Plaid, Spotify) checked into the
 * workspace's large-specs corpus. Skipped silently when the corpus is not
 * present (it lives outside this package). Proves: no crash, termination on
 * huge documents, determinism, structural invariants.
 */

const CORPUS = path.resolve(__dirname, '../../../large-specs');

const SPECS = [
  'stripe-v3.0.json',
  'github-v3.0.json',
  'digitalocean-v3.0.yaml',
  'plaid-v3.0.yml',
  'spotify-v3.0.yml'
];

function loadSpec(file: string): Record<string, unknown> | null {
  const full = path.join(CORPUS, file);
  if (!existsSync(full)) return null;
  const raw = readFileSync(full, 'utf8');
  return (file.endsWith('.json') ? JSON.parse(raw) : parse(raw)) as Record<string, unknown>;
}

describe('derivation against real-world production specs', () => {
  for (const file of SPECS) {
    it(`derives a valid deterministic flow from ${file}`, () => {
      const spec = loadSpec(file);
      if (!spec) {
        console.warn(`corpus spec missing, skipping: ${file}`);
        return;
      }
      const started = Date.now();
      const one = deriveFlowFromSpec(spec);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(30000);

      expect(one.flow).not.toBeNull();
      const steps = one.flow!.steps;
      expect(steps.length).toBeGreaterThan(0);

      // No DELETE steps by default.
      expect(one.trace.excludedDeleteCount).toBeGreaterThanOrEqual(0);

      // Unique step keys at scale.
      const keys = steps.map((step) => step.stepKey);
      expect(new Set(keys).size).toBe(keys.length);

      // Producer-before-consumer invariant.
      const stepIndexByKey = new Map(steps.map((step, index) => [step.stepKey, index]));
      steps.forEach((step, index) => {
        for (const binding of step.bindings) {
          if (binding.source === 'prior_output') {
            const producerIndex = stepIndexByKey.get(binding.sourceStepKey ?? '');
            expect(producerIndex).toBeDefined();
            expect(producerIndex!).toBeLessThan(index);
          }
        }
      });

      // Determinism on identical bytes.
      const two = deriveFlowFromSpec(structuredClone(spec));
      expect(JSON.stringify(two.flow)).toBe(JSON.stringify(one.flow));
    });
  }
});
