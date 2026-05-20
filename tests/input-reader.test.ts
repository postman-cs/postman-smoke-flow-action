import { describe, expect, it } from 'vitest';

import { readActionInputs } from '../src/index.js';

describe('readActionInputs', () => {
  it('reads hyphenated GitHub Action inputs from canonical runner env names', () => {
    const inputs = readActionInputs({
      INPUT_PROJECT_NAME: 'oreilly-demo-remote-pos-service',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_SPEC_ID: 'spec-123',
      INPUT_SMOKE_COLLECTION_ID: 'col-123',
      INPUT_FLOW_PATH: '.postman-api-launchpad/flows/remote-pos/flow.yaml',
      INPUT_POSTMAN_API_KEY: 'pmak-test',
      INPUT_COLLECTION_SYNC_MODE: 'refresh',
      INPUT_FAIL_ON_FLOW_WARNING: 'false',
      INPUT_KEEP_TEMP_COLLECTION_ON_FAILURE: 'false',
      INPUT_TEMP_COLLECTION_PREFIX: '[Smoke][Temp]'
    } as NodeJS.ProcessEnv);

    expect(inputs.projectName).toBe('oreilly-demo-remote-pos-service');
    expect(inputs.workspaceId).toBe('ws-123');
    expect(inputs.specId).toBe('spec-123');
    expect(inputs.smokeCollectionId).toBe('col-123');
    expect(inputs.flowPath).toBe('.postman-api-launchpad/flows/remote-pos/flow.yaml');
    expect(inputs.postmanApiKey).toBe('pmak-test');
  });
});
