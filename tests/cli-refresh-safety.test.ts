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


vi.mock('@postman-cse/automation-telemetry-core', () => ({
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

  it('requires an explicit acknowledgment for CLI no-flow destructive refresh', () => {
    expect(() =>
      assertCliNoFlowRefreshAllowed({
        flowPath: undefined,
        acknowledgeNoFlowRefresh: false
      })
    ).toThrow(/acknowledge-no-flow-refresh/);

    expect(() =>
      assertCliNoFlowRefreshAllowed({
        flowPath: undefined,
        acknowledgeNoFlowRefresh: true
      })
    ).not.toThrow();

    expect(() =>
      assertCliNoFlowRefreshAllowed({
        flowPath: 'flow.yaml',
        acknowledgeNoFlowRefresh: false
      })
    ).not.toThrow();
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
  it('rejects an unreadable flow manifest before side effects', async () => {
    mintSpy.mockClear();
    preflightSpy.mockClear();
    telemetrySpy.emitCompletion.mockClear();

    await expect(
      runAction(silentCore(), {
        INPUT_PROJECT_NAME: 'payments',
        INPUT_WORKSPACE_ID: 'ws-1',
        INPUT_SPEC_ID: 'spec-1',
        INPUT_SMOKE_COLLECTION_ID: 'col-1',
        INPUT_FLOW_PATH: 'definitely-missing-wave1-flow.yaml',
        INPUT_POSTMAN_ACCESS_TOKEN: 'pma_at'
      } as NodeJS.ProcessEnv)
    ).rejects.toThrow();

    expect(mintSpy).not.toHaveBeenCalled();
    expect(preflightSpy).not.toHaveBeenCalled();
    expect(telemetrySpy.emitCompletion).not.toHaveBeenCalled();
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
