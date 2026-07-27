import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG, parseCliArgs } from '../src/lib/cli-args.js';
import { assertCliNoFlowRefreshAllowed, runCli } from '../src/cli.js';
import { readActionInputs, runAction } from '../src/index.js';
import type { CoreLike } from '../src/types.js';

const mintSpy = vi.fn(async () => undefined);
const preflightSpy = vi.fn(async () => undefined);
const telemetrySpy = {
  setTeamId: vi.fn(),
  setAccountType: vi.fn(),
  emitCompletion: vi.fn()
};

vi.mock('../src/lib/postman/token-provider.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/postman/token-provider.js')>(
    '../src/lib/postman/token-provider.js'
  );
  return {
    ...actual,
    mintAccessTokenIfNeeded: ((...args: unknown[]) => mintSpy(...(args as []))) as typeof actual.mintAccessTokenIfNeeded
  };
});

vi.mock('../src/postman/credential-identity.js', async () => {
  const actual = await vi.importActual<typeof import('../src/postman/credential-identity.js')>(
    '../src/postman/credential-identity.js'
  );
  return {
    ...actual,
    runCredentialPreflight: ((...args: unknown[]) =>
      preflightSpy(...(args as []))) as typeof actual.runCredentialPreflight,
    getMemoizedSessionIdentity: () => undefined
  };
});


// Spy on telemetry only. The logger stays real so these tests keep exercising
// the same log path production runs on.
vi.mock('@postman-cse/automation-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@postman-cse/automation-core')>()),
  createTelemetryContext: () => telemetrySpy
}));

function silentCore(): CoreLike {
  return {
    info: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    setSecret: vi.fn()
  };
}

const DERIVABLE_SPEC = [
  'openapi: 3.0.0',
  'info:',
  '  title: Payments API',
  '  version: 1.0.0',
  'paths:',
  '  /payments:',
  '    post:',
  '      operationId: createPayment',
  '      responses:',
  "        '201':",
  '          description: created'
].join('\n');

function createInjectedPostman() {
  let canonicalCollection: Record<string, unknown> = { info: { name: '[Smoke] payments' }, item: [] };
  return {
    generateCollection: vi.fn().mockResolvedValue('temp-123'),
    getCollection: vi.fn(async (collectionId: string) =>
      collectionId === 'temp-123'
        ? {
            info: { name: '[Smoke][Temp] payments' },
            item: [{ name: 'createPayment', request: { method: 'POST', url: 'https://api.example.com/payments' } }]
          }
        : structuredClone(canonicalCollection)
    ),
    updateCollection: vi.fn(async (_collectionId: string, collection: Record<string, unknown>) => {
      canonicalCollection = structuredClone(collection);
    }),
    deleteCollection: vi.fn().mockResolvedValue(undefined)
  };
}

describe('CLI no-flow refresh safety', () => {
  it('rejects --flow-pth before any mutation path can run', async () => {
    await expect(
      runCli(['node', 'postman-smoke-flow', '--flow-pth', 'flows/core/flow.yaml'], silentCore(), {
        INPUT_PROJECT_NAME: 'payments',
        INPUT_WORKSPACE_ID: 'ws-1',
        INPUT_SPEC_ID: 'spec-1',
        INPUT_SMOKE_COLLECTION_ID: 'col-1',
        INPUT_POSTMAN_ACCESS_TOKEN: 'pma_at'
      })
    ).rejects.toThrow(/Unknown option: --flow-pth/);
    expect(mintSpy).not.toHaveBeenCalled();
    expect(preflightSpy).not.toHaveBeenCalled();
    expect(telemetrySpy.emitCompletion).not.toHaveBeenCalled();
  });

  it('requires an explicit acknowledgment only when a run would actually be an uncurated refresh', () => {
    // No flow-path, no spec-path derivation: destructive, ack required.
    expect(() =>
      assertCliNoFlowRefreshAllowed({
        flowPath: undefined,
        flowMode: 'auto',
        specPath: undefined,
        acknowledgeNoFlowRefresh: false
      })
    ).toThrow(/acknowledge-no-flow-refresh/);

    expect(() =>
      assertCliNoFlowRefreshAllowed({
        flowPath: undefined,
        flowMode: 'auto',
        specPath: undefined,
        acknowledgeNoFlowRefresh: true
      })
    ).not.toThrow();

    expect(() =>
      assertCliNoFlowRefreshAllowed({
        flowPath: 'flow.yaml',
        flowMode: 'auto',
        specPath: undefined,
        acknowledgeNoFlowRefresh: false
      })
    ).not.toThrow();

    // flow-mode=auto with spec-path derives a flow: no ack needed.
    expect(() =>
      assertCliNoFlowRefreshAllowed({
        flowPath: undefined,
        flowMode: 'auto',
        specPath: 'openapi.yaml',
        acknowledgeNoFlowRefresh: false
      })
    ).not.toThrow();

    // flow-mode=off is always the uncurated refresh: ack required even with spec-path.
    expect(() =>
      assertCliNoFlowRefreshAllowed({
        flowPath: undefined,
        flowMode: 'off',
        specPath: 'openapi.yaml',
        acknowledgeNoFlowRefresh: false
      })
    ).toThrow(/acknowledge-no-flow-refresh/);
  });

  it('fails hard when auto derivation from a spec produces no flow', async () => {
    const previousCwd = process.cwd();
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-cli-refresh-'));
    writeFileSync(
      path.join(tempDir, 'openapi.yaml'),
      ['openapi: 3.0.3', 'info:', '  title: Empty API', '  version: 1.0.0', 'paths: {}', ''].join('\n')
    );
    mintSpy.mockClear();
    preflightSpy.mockClear();
    telemetrySpy.emitCompletion.mockClear();

    try {
      process.chdir(tempDir);
      const failure = runCli(
        [
          'node',
          'postman-smoke-flow',
          '--flow-mode',
          'auto',
          '--spec-path',
          'openapi.yaml'
        ],
        silentCore(),
        {
          INPUT_PROJECT_NAME: 'payments',
          INPUT_WORKSPACE_ID: 'ws-1',
          INPUT_SPEC_ID: 'spec-1',
          INPUT_SMOKE_COLLECTION_ID: 'col-1',
          INPUT_POSTMAN_ACCESS_TOKEN: 'pma_at'
        } as NodeJS.ProcessEnv
      );

      const rejection = await failure.then(
        () => undefined,
        (error: unknown) => error
      );
      expect(rejection).toBeInstanceOf(Error);
      const failureMessage = (rejection as Error).message;
      expect(failureMessage).toMatch(/no operations/i);
      expect(failureMessage).toMatch(/flow-path/i);
      expect(failureMessage).toMatch(/flow-mode\s*=\s*off/i);
      expect(failureMessage).not.toMatch(/acknowledge-no-flow-refresh/i);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
      vi.clearAllMocks();
    }
  });

  it('preserves GitHub Action no-flow behavior without the CLI acknowledgment flag', async () => {
    mintSpy.mockClear();
    preflightSpy.mockClear();
    telemetrySpy.emitCompletion.mockClear();

    // Action path: omit flow-path. Validation passes, then reshape fails later
    // because credentials/client are incomplete — proving no CLI ack is required.
    await expect(
      runAction(silentCore(), {
        INPUT_PROJECT_NAME: 'payments',
        INPUT_WORKSPACE_ID: 'ws-1',
        INPUT_SPEC_ID: 'spec-1',
        INPUT_SMOKE_COLLECTION_ID: 'col-1',
        INPUT_POSTMAN_ACCESS_TOKEN: 'pma_at'
      } as NodeJS.ProcessEnv)
    ).rejects.toThrow();

    expect(mintSpy).toHaveBeenCalled();
    expect(preflightSpy).toHaveBeenCalled();
    expect(telemetrySpy.emitCompletion).toHaveBeenCalled();
    expect(readActionInputs({} as NodeJS.ProcessEnv).flowPath).toBeUndefined();
  });

  it('parses the acknowledgment flag without inventing an INPUT_ alias', () => {
    const parsed = parseCliArgs(
      [
        'node',
        'postman-smoke-flow',
        '--project-name=payments',
        `--${ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG}=true`
      ],
      {}
    );
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') {
      return;
    }
    expect(parsed.acknowledgeNoFlowRefresh).toBe(true);
    expect(Object.keys(parsed.env).some((key) => key.includes('ACKNOWLEDGE'))).toBe(false);
  });
});

describe('input validation before side effects', () => {
  it('runAction derives and persists an absent custom flow-path, then converges to curated', async () => {
    const previousCwd = process.cwd();
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-flow-action-convergence-'));
    mintSpy.mockClear();
    preflightSpy.mockClear();
    telemetrySpy.emitCompletion.mockClear();
    const actionCore = silentCore();
    const postman = createInjectedPostman();
    const customFlowPath = 'ci/generated-smoke-flow.yaml';

    try {
      writeFileSync(path.join(tempDir, 'openapi.yaml'), DERIVABLE_SPEC);
      process.chdir(tempDir);
      const env = {
        INPUT_PROJECT_NAME: 'payments',
        INPUT_WORKSPACE_ID: 'ws-1',
        INPUT_SPEC_ID: 'spec-1',
        INPUT_SMOKE_COLLECTION_ID: 'col-1',
        INPUT_FLOW_PATH: customFlowPath,
        INPUT_SPEC_PATH: 'openapi.yaml',
        INPUT_POSTMAN_ACCESS_TOKEN: 'pma_at'
      } as NodeJS.ProcessEnv;
      const dependencies = { postman, sleep: vi.fn().mockResolvedValue(undefined) };

      const run1 = await runAction(actionCore, env, undefined, dependencies);
      expect(run1['flow-apply-status']).toBe('success');
      expect(run1['derived-flow-path']).toBe(customFlowPath);
      expect(existsSync(path.join(tempDir, customFlowPath))).toBe(true);
      expect(JSON.parse(run1['flow-apply-summary-json'])).toMatchObject({ flowSource: 'derived' });
      expect(actionCore.setOutput).toHaveBeenCalledWith('derived-flow-path', customFlowPath);
      expect(postman.generateCollection).toHaveBeenCalledTimes(1);
      expect(postman.updateCollection).toHaveBeenCalledTimes(1);

      const run2 = await runAction(actionCore, env, undefined, dependencies);
      expect(run2['flow-apply-status']).toBe('success');
      expect(run2['derived-flow-path']).toBe('');
      expect(JSON.parse(run2['flow-apply-summary-json'])).toMatchObject({ flowSource: 'curated' });
      expect(actionCore.setOutput).toHaveBeenCalledWith('derived-flow-path', '');
      expect(postman.generateCollection).toHaveBeenCalledTimes(2);
      expect(postman.updateCollection).toHaveBeenCalledTimes(2);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects an outside flow-path before mint, preflight, or Postman mutation', async () => {
    mintSpy.mockClear();
    preflightSpy.mockClear();
    telemetrySpy.emitCompletion.mockClear();
    const postman = createInjectedPostman();

    await expect(
      runAction(silentCore(), {
        INPUT_PROJECT_NAME: 'payments',
        INPUT_WORKSPACE_ID: 'ws-1',
        INPUT_SPEC_ID: 'spec-1',
        INPUT_SMOKE_COLLECTION_ID: 'col-1',
        INPUT_FLOW_PATH: '../outside-flow.yaml',
        INPUT_POSTMAN_ACCESS_TOKEN: 'pma_at'
      } as NodeJS.ProcessEnv, undefined, { postman, sleep: vi.fn().mockResolvedValue(undefined) })
    ).rejects.toThrow(/repository root|traversal/i);

    expect(mintSpy).not.toHaveBeenCalled();
    expect(preflightSpy).not.toHaveBeenCalled();
    expect(telemetrySpy.emitCompletion).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(postman.updateCollection).not.toHaveBeenCalled();
  });

  it('rejects invalid syntax before token mint, credential preflight, or telemetry', async () => {
    mintSpy.mockClear();
    preflightSpy.mockClear();
    telemetrySpy.setTeamId.mockClear();
    telemetrySpy.emitCompletion.mockClear();

    await expect(
      runAction(silentCore(), {
        INPUT_PROJECT_NAME: 'payments',
        INPUT_WORKSPACE_ID: 'ws-1',
        INPUT_SPEC_ID: 'spec-1',
        INPUT_SMOKE_COLLECTION_ID: 'col-1',
        INPUT_FAIL_ON_FLOW_WARNING: 'maybe',
        INPUT_POSTMAN_ACCESS_TOKEN: 'pma_at'
      } as NodeJS.ProcessEnv)
    ).rejects.toThrow(/Invalid boolean value for fail-on-flow-warning/);

    expect(mintSpy).not.toHaveBeenCalled();
    expect(preflightSpy).not.toHaveBeenCalled();
    expect(telemetrySpy.setTeamId).not.toHaveBeenCalled();
    expect(telemetrySpy.emitCompletion).not.toHaveBeenCalled();
  });

  it('rejects missing required inputs before side effects', async () => {
    mintSpy.mockClear();
    preflightSpy.mockClear();
    telemetrySpy.emitCompletion.mockClear();

    await expect(
      runAction(silentCore(), {
        INPUT_WORKSPACE_ID: 'ws-1',
        INPUT_SPEC_ID: 'spec-1',
        INPUT_SMOKE_COLLECTION_ID: 'col-1',
        INPUT_POSTMAN_ACCESS_TOKEN: 'pma_at'
      } as NodeJS.ProcessEnv)
    ).rejects.toThrow(/Missing required input: project-name/);

    expect(mintSpy).not.toHaveBeenCalled();
    expect(preflightSpy).not.toHaveBeenCalled();
    expect(telemetrySpy.emitCompletion).not.toHaveBeenCalled();
  });
});

describe('INPUT alias conflict behavior', () => {
  it('accepts runner-form and normalized aliases independently', () => {
    expect(
      readActionInputs({
        'INPUT_PROJECT-NAME': 'from-runner'
      } as NodeJS.ProcessEnv).projectName
    ).toBe('from-runner');

    expect(
      readActionInputs({
        INPUT_PROJECT_NAME: 'from-normalized'
      } as NodeJS.ProcessEnv).projectName
    ).toBe('from-normalized');
  });

  it('rejects conflicting runner-form and normalized INPUT values', () => {
    expect(() =>
      readActionInputs({
        'INPUT_PROJECT-NAME': 'runner',
        INPUT_PROJECT_NAME: 'normalized'
      } as NodeJS.ProcessEnv)
    ).toThrow(/Conflicting values for input project-name/);
  });

  it('lets explicit project-name and flow-path override both inherited aliases', async () => {
    mintSpy.mockClear();
    preflightSpy.mockClear();

    await expect(
      runCli(
        [
          'node',
          'postman-smoke-flow',
          '--project-name',
          'cli-project',
          '--flow-path',
          'examples/flow.yaml'
        ],
        silentCore(),
        {
          'INPUT_PROJECT-NAME': 'runner-project',
          INPUT_PROJECT_NAME: 'normalized-project',
          'INPUT_FLOW-PATH': 'runner-flow.yaml',
          INPUT_FLOW_PATH: 'normalized-flow.yaml',
          INPUT_WORKSPACE_ID: 'ws-1',
          INPUT_SPEC_ID: 'spec-1',
          INPUT_SMOKE_COLLECTION_ID: 'col-1',
          INPUT_POSTMAN_ACCESS_TOKEN: 'pma_at'
        } as NodeJS.ProcessEnv
      )
    ).rejects.not.toThrow(/Conflicting values|acknowledge-no-flow-refresh/);

    expect(mintSpy).toHaveBeenCalled();
    expect(preflightSpy).toHaveBeenCalled();
  });
});
