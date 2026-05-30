import { describe, expect, it } from 'vitest';

import { applyArgsToEnv } from '../src/lib/cli-args.js';

describe('CLI argument parsing', () => {
  it('accepts both --flag value and --flag=value forms', () => {
    const env: NodeJS.ProcessEnv = {};

    applyArgsToEnv([
      'node',
      'postman-smoke-flow',
      '--project-name=payments',
      '--workspace-id',
      'ws-123',
      '--postman-api-key=PMAK-123'
    ], env);

    expect(env.INPUT_PROJECT_NAME).toBe('payments');
    expect(env.INPUT_WORKSPACE_ID).toBe('ws-123');
    expect(env.INPUT_POSTMAN_API_KEY).toBe('PMAK-123');
  });
});
