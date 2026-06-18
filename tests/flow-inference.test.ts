import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { inferSmokeFlowFromOpenApi } from '../src/flow/infer.js';

function withSpec(content: string, callback: (specPath: string) => void): void {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-infer-'));
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    writeFileSync('openapi.yaml', content);
    callback('openapi.yaml');
  } finally {
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('inferSmokeFlowFromOpenApi', () => {
  it('infers a safe create/read/update/read happy path', () => {
    withSpec([
      'openapi: 3.0.3',
      'info: { title: Payments, version: 1.0.0 }',
      'paths:',
      '  /payments:',
      '    post:',
      '      operationId: createPayment',
      '      responses:',
      "        '201':",
      '          description: created',
      '          content:',
      '            application/json:',
      '              schema:',
      '                type: object',
      '                properties:',
      '                  id: { type: string }',
      '  /payments/{paymentId}:',
      '    get:',
      '      operationId: getPayment',
      '      responses:',
      "        '200': { description: ok }",
      '    patch:',
      '      operationId: updatePayment',
      '      responses:',
      "        '200': { description: ok }"
    ].join('\n'), (specPath) => {
      const result = inferSmokeFlowFromOpenApi(specPath, 'Payments happy path');
      expect(result.flow.name).toBe('Payments happy path');
      expect(result.flow.steps.map((step) => step.operationId)).toEqual([
        'createPayment',
        'getPayment',
        'updatePayment',
        'getPayment'
      ]);
      expect(result.flow.steps[0]?.extract).toEqual([
        {
          variable: 'createPayment.paymentId',
          jsonPath: '$.id'
        }
      ]);
      expect(result.flow.steps[1]?.bindings[0]).toMatchObject({
        fieldKey: 'paymentId',
        source: 'prior_output',
        variable: 'createPayment.paymentId'
      });
    });
  });

  it('skips destructive operations and falls back to safe GET', () => {
    withSpec([
      'openapi: 3.0.3',
      'info: { title: Payments, version: 1.0.0 }',
      'paths:',
      '  /payments:',
      '    get:',
      '      operationId: listPayments',
      '      responses:',
      "        '200': { description: ok }",
      '  /payments/{paymentId}:',
      '    delete:',
      '      operationId: deletePayment',
      '      responses:',
      "        '204': { description: deleted }"
    ].join('\n'), (specPath) => {
      const result = inferSmokeFlowFromOpenApi(specPath);
      expect(result.flow.steps.map((step) => step.operationId)).toEqual(['listPayments']);
      expect(result.warnings[0]).toContain('single safe GET');
    });
  });
});
