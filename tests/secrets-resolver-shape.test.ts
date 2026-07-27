import { describe, expect, it } from 'vitest';

import {
  buildCuratedSmokeCollection,
  buildGeneratedSmokeCollection
} from '../src/postman/collection-transform.js';
import type { FlowDefinition, ResolvedRequest } from '../src/types.js';

type JsonRecord = Record<string, unknown>;

function generatedCollection(): JsonRecord {
  return {
    info: { name: '[Smoke][Temp] Pets API' },
    item: [
      {
        name: 'List pets',
        request: { method: 'GET', url: '{{baseUrl}}/pets' }
      }
    ]
  };
}

function resolveRequestUrl(request: JsonRecord): string {
  return typeof request.url === 'string'
    ? request.url
    : String((request.url as JsonRecord).raw ?? '');
}

function joinedTestExec(item: JsonRecord): string {
  const events = item.event as JsonRecord[];
  const testEvent = events.find((entry) => entry.listen === 'test');
  const script = testEvent?.script as JsonRecord;
  const exec = script?.exec as string[];
  return exec.join('\n');
}

describe('secrets resolver provider request shapes', () => {
  it('injects the live-proven Azure Key Vault shape', () => {
    const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, {
      secretsResolverProvider: 'azure'
    });
    const item = (built.collection.item as JsonRecord[])[0]!;
    const request = item.request as JsonRecord;

    expect(request.method).toBe('GET');
    expect(resolveRequestUrl(request)).toBe(
      'https://{{AZURE_KEY_VAULT_NAME}}.vault.azure.net/secrets/{{AZURE_SECRET_NAME}}?api-version=7.4'
    );
    expect(request.auth).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{AZURE_ACCESS_TOKEN}}' }]
    });
    expect(request.header).toEqual([{ key: 'Accept', value: 'application/json' }]);
    const execText = joinedTestExec(item);
    expect(execText).toContain('body.value');
    expect(execText).not.toContain('SecretString');
    expect(execText).not.toContain('payload');
    expect(request.body).toBeUndefined();
  });

  it('injects the live-proven GCP Secret Manager shape', () => {
    const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, {
      secretsResolverProvider: 'gcp'
    });
    const item = (built.collection.item as JsonRecord[])[0]!;
    const request = item.request as JsonRecord;

    expect(request.method).toBe('GET');
    expect(resolveRequestUrl(request)).toBe(
      'https://secretmanager.googleapis.com/v1/projects/{{GCP_PROJECT_ID}}/secrets/{{GCP_SECRET_NAME}}/versions/latest:access'
    );
    expect(request.auth).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{GCP_ACCESS_TOKEN}}' }]
    });
    const execText = joinedTestExec(item);
    expect(execText).toContain('body.payload');
    expect(execText).toContain('base64');
    expect(execText).not.toContain('SecretString');
    expect(request.body).toBeUndefined();
  });

  it('never leaks another provider credential slot into the chosen helper', () => {
    for (const [provider, forbiddenPrefixes] of [
      ['aws', ['AZURE_', 'GCP_']],
      ['azure', ['AWS_', 'GCP_']],
      ['gcp', ['AWS_', 'AZURE_']]
    ] as const) {
      const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, {
        secretsResolverProvider: provider
      });
      const text = JSON.stringify((built.collection.item as JsonRecord[])[0]);
      for (const prefix of forbiddenPrefixes) {
        expect(text).not.toContain(prefix);
      }
    }
  });

  it('seeds no resolver and no credential slots when the provider is none', () => {
    const forbiddenMarkers = [
      '00 - Resolve Secrets',
      'AWS_ACCESS_KEY_ID',
      'AWS_REGION',
      'AZURE_ACCESS_TOKEN',
      'GCP_ACCESS_TOKEN',
      'SecretString'
    ];

    for (const options of [{}, { secretsResolverProvider: 'none' as const }]) {
      const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, options);
      const text = JSON.stringify(built.collection);
      for (const marker of forbiddenMarkers) {
        expect(text).not.toContain(marker);
      }
      expect((built.collection.item as unknown[]).length).toBe(1);
    }
  });

  it('curated collections carry the same per-provider shape', () => {
    const flow: FlowDefinition = {
      name: 'Pets happy path',
      type: 'smoke',
      steps: [
        {
          stepKey: 'list-pets-1',
          operationId: 'listPets',
          bindings: [],
          extract: [],
          name: 'listPets'
        }
      ]
    };
    const resolvedRequests: ResolvedRequest[] = [
      {
        step: flow.steps[0]!,
        item: { name: 'listPets', request: { method: 'GET', url: 'https://api.example.com/pets' } }
      }
    ];

    for (const [provider, expectedUrl] of [
      [
        'azure',
        'https://{{AZURE_KEY_VAULT_NAME}}.vault.azure.net/secrets/{{AZURE_SECRET_NAME}}?api-version=7.4'
      ],
      [
        'gcp',
        'https://secretmanager.googleapis.com/v1/projects/{{GCP_PROJECT_ID}}/secrets/{{GCP_SECRET_NAME}}/versions/latest:access'
      ]
    ] as const) {
      const built = buildCuratedSmokeCollection(
        generatedCollection(),
        flow,
        resolvedRequests,
        undefined,
        provider
      );
      const item = (built.collection.item as JsonRecord[])[0]!;
      expect(item.name).toBe('00 - Resolve Secrets');
      expect(resolveRequestUrl(item.request as JsonRecord)).toBe(expectedUrl);
    }
  });
});
