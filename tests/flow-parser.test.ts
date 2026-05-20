import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadFlowManifest } from '../src/flow/parser.js';
import { validateFlowManifest } from '../src/flow/validator.js';

describe('flow parser and validator', () => {
  it('loads a valid single smoke flow manifest', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-'));
    const flowPath = path.join(tempDir, 'flow.yaml');
    writeFileSync(
      flowPath,
      [
        'flows:',
        '  - name: Payments API happy path',
        '    type: smoke',
        '    steps:',
        '      - stepKey: create-payment-1',
        '        operationId: createPayment',
        '        bindings: []',
        '        extract: []'
      ].join('\n')
    );

    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const manifest = loadFlowManifest('flow.yaml');
      const { flow } = validateFlowManifest(manifest);
      expect(flow.name).toBe('Payments API happy path');
      expect(flow.steps).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads a Launchpad-generated repo flow path', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-'));
    const flowPath = path.join(tempDir, '.postman-api-launchpad', 'flows', 'payments', 'flow.yaml');
    mkdirSync(path.dirname(flowPath), { recursive: true });
    writeFileSync(
      flowPath,
      [
        'flows:',
        '  - name: Payments API happy path',
        '    type: smoke',
        '    steps:',
        '      - stepKey: create-payment-1',
        '        operationId: createPayment',
        '        bindings: []',
        '        extract: []'
      ].join('\n')
    );

    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const manifest = loadFlowManifest('.postman-api-launchpad/flows/payments/flow.yaml');
      const { flow } = validateFlowManifest(manifest);
      expect(flow.name).toBe('Payments API happy path');
      expect(flow.steps).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('requires literal bindings to provide a value', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-'));
    const flowPath = path.join(tempDir, 'flow.yaml');
    writeFileSync(
      flowPath,
      [
        'flows:',
        '  - name: Payments API happy path',
        '    type: smoke',
        '    steps:',
        '      - stepKey: create-payment-1',
        '        operationId: createPayment',
        '        bindings:',
        '          - fieldKey: amount',
        '            source: literal',
        '        extract: []'
      ].join('\n')
    );

    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const manifest = loadFlowManifest('flow.yaml');
      expect(() => validateFlowManifest(manifest)).toThrow(/must include value when using literal source/);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
