/**
 * Shared scaffolding for the smoke-flow contract lane: drives the REAL runAction
 * composition root (input resolution -> mint -> preflight -> createSmokeClient ->
 * runSmokeFlow) with a stubbed global fetch, a disposable cwd, and neutralized
 * ambient credentials.
 *
 * The only fake is the transport. No production seam is mocked, so the Bifrost
 * /ws/proxy envelope and the access-token-only reshape are exercised for real.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

import { NEUTRALIZED_ENV_VARS } from './platform-fake.js';

export interface ContractCoreLike {
  getInput(name: string, options?: { required?: boolean }): string;
  info(message: string): void;
  warning(message: string): void;
  setFailed(message: string): void;
  setOutput(name: string, value: string): void;
  setSecret(secret: string): void;
}

export interface ContractRunResult {
  outputs: Record<string, string>;
  infos: string[];
  warnings: string[];
  error?: unknown;
}

export interface ContractRunOptions {
  inputs: Record<string, string>;
  fetchImpl: typeof fetch;
  /** Env applied after the neutralization sweep. */
  env?: Record<string, string>;
  /** Files written into the disposable cwd before the run (path -> content). */
  files?: Record<string, string>;
}

/**
 * Run the real smoke-flow Action root against the supplied transport inside a
 * disposable working directory. Env-derived inputs flow through the same
 * `INPUT_*` names the GitHub runner uses, so `readActionInputs` is exercised
 * unmodified (including the endpoint override seam).
 */
export async function runContractAction(options: ContractRunOptions): Promise<ContractRunResult> {
  vi.resetModules();
  const { runAction } = await import('../../src/index.js');
  const { __resetIdentityMemo } = await import('../../src/postman/credential-identity.js');

  const testDir = mkdtempSync(join(tmpdir(), 'smoke-flow-cassette-'));
  const previousCwd = process.cwd();

  __resetIdentityMemo();
  for (const name of NEUTRALIZED_ENV_VARS) {
    vi.stubEnv(name, '');
  }
  for (const name of Object.keys(process.env).filter((name) => name.startsWith('INPUT_'))) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('POSTMAN_ACTIONS_TELEMETRY', 'off');
  vi.stubEnv('DO_NOT_TRACK', '1');
  // Deterministic run identity: buildSmokeRunIdentity appends 4 random bytes,
  // so GITHUB_* parts alone do not pin the temp-collection name. The random
  // suffix comes from node:crypto randomBytes, which respects this stub when
  // the module is reset.
  for (const [name, value] of Object.entries(options.env ?? {})) {
    vi.stubEnv(name, value);
  }
  for (const [name, value] of Object.entries(options.inputs)) {
    vi.stubEnv(`INPUT_${name.replace(/ /g, '_').toUpperCase()}`, value);
  }
  vi.stubGlobal('fetch', options.fetchImpl);
  process.chdir(testDir);
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    writeFileSync(join(testDir, relative), content);
  }

  const outputs: Record<string, string> = {};
  const infos: string[] = [];
  const warnings: string[] = [];
  const core: ContractCoreLike = {
    getInput: (name: string, opts?: { required?: boolean }) => {
      const value = options.inputs[name] ?? '';
      if (opts?.required && !value) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value;
    },
    info: (message: string) => {
      infos.push(message);
    },
    warning: (message: string) => {
      warnings.push(message);
    },
    setFailed: () => {},
    setOutput: (name: string, value: string) => {
      outputs[name] = value;
    },
    setSecret: () => {}
  };

  let error: unknown;
  try {
    await runAction(core, process.env);
  } catch (caught) {
    error = caught;
  } finally {
    process.chdir(previousCwd);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    __resetIdentityMemo();
    rmSync(testDir, { recursive: true, force: true });
  }

  return { outputs, infos, warnings, error };
}
