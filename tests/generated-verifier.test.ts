import { describe, expect, it } from 'vitest';

import {
  buildGeneratedSmokeCollection,
  verifyGeneratedSmokeCollection
} from '../src/postman/collection-transform.js';

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

describe('generated smoke collection secrets resolver contract', () => {
  it('adds no resolver by default so non-AWS consumers ship no doomed request', () => {
    const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, {});
    expect(JSON.stringify(built.collection.item)).not.toContain('SecretString');
    const verification = verifyGeneratedSmokeCollection(built.collection, undefined, {});
    expect(verification.ok).toBe(true);
  });

  it('prepends the selected provider helper and verification passes', () => {
    for (const [provider, marker] of [
      ['aws', 'secretsmanager.GetSecretValue'],
      ['azure', 'vault.azure.net'],
      ['gcp', 'secretmanager.googleapis.com']
    ] as const) {
      const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, {
        secretsResolverProvider: provider
      });
      const items = built.collection.item as JsonRecord[];
      expect(JSON.stringify(items[0])).toContain(marker);
      const verification = verifyGeneratedSmokeCollection(built.collection, undefined, {
        secretsResolverProvider: provider
      });
      expect(verification.ok).toBe(true);
    }
  });

  it('build does not duplicate an existing resolver item', () => {
    const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, {
      secretsResolverProvider: 'aws'
    });
    const rebuilt = buildGeneratedSmokeCollection(built.collection, undefined, {
      secretsResolverProvider: 'aws'
    });
    const resolverCount = (rebuilt.collection.item as JsonRecord[]).filter((item) =>
      JSON.stringify(item).includes('SecretString')
    ).length;
    expect(resolverCount).toBe(1);
  });

  it('removes a previously inserted resolver when the provider is cleared', () => {
    const enabled = buildGeneratedSmokeCollection(generatedCollection(), undefined, {
      secretsResolverProvider: 'aws'
    });
    expect(JSON.stringify(enabled.collection.item)).toContain('SecretString');
    const built = buildGeneratedSmokeCollection(enabled.collection, undefined, {
      secretsResolverProvider: 'none'
    });
    expect(JSON.stringify(built.collection.item)).not.toContain('SecretString');
    const verification = verifyGeneratedSmokeCollection(built.collection, undefined, {
      secretsResolverProvider: 'none'
    });
    expect(verification.ok).toBe(true);
  });

  it('applying auth never overwrites the resolver item AWSv4 auth (alias names included)', () => {
    const enabled = buildGeneratedSmokeCollection(generatedCollection(), undefined, {
      secretsResolverProvider: 'aws'
    });
    const resolver = (enabled.collection.item as JsonRecord[]).find((item) =>
      JSON.stringify(item).includes('SecretString')
    ) as JsonRecord;
    resolver.name = 'Resolve Secrets';
    const authed = buildGeneratedSmokeCollection(enabled.collection, {
      enabled: true,
      type: 'apiKey',
      name: 'X-API-Key',
      location: 'header'
    } as never, { secretsResolverProvider: 'aws' });
    const authedResolver = (authed.collection.item as JsonRecord[]).find((item) =>
      JSON.stringify(item).includes('SecretString')
    ) as JsonRecord;
    const auth = (authedResolver.request as JsonRecord).auth as JsonRecord;
    expect(auth?.type).toBe('awsv4');
  });

  it('verification fails when a provider is selected but the resolver is missing', () => {
    const verification = verifyGeneratedSmokeCollection(generatedCollection(), undefined, {
      secretsResolverProvider: 'aws'
    });
    expect(verification.ok).toBe(false);
    expect(verification.summary).toContain('secrets resolver request is missing');
  });

  it('verification fails when no provider is selected but a resolver is still present', () => {
    const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, {
      secretsResolverProvider: 'aws'
    });
    const verification = verifyGeneratedSmokeCollection(built.collection, undefined, {
      secretsResolverProvider: 'none'
    });
    expect(verification.ok).toBe(false);
    expect(verification.summary).toContain('secrets resolver request is still present');
  });

  it('reproduces the historical AWS helper wire shape exactly', () => {
    const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, {
      secretsResolverProvider: 'aws'
    });
    const resolver = (built.collection.item as JsonRecord[])[0];

    expect(resolver).toEqual({
      name: '00 - Resolve Secrets',
      request: {
        auth: {
          type: 'awsv4',
          awsv4: [
            { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}' },
            { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}' },
            { key: 'region', value: '{{AWS_REGION}}' },
            { key: 'service', value: 'secretsmanager' }
          ]
        },
        method: 'POST',
        header: [
          { key: 'X-Amz-Target', value: 'secretsmanager.GetSecretValue' },
          { key: 'Content-Type', value: 'application/x-amz-json-1.1' }
        ],
        body: { mode: 'raw', raw: '{"SecretId": "{{AWS_SECRET_NAME}}"}' },
        url: {
          raw: 'https://secretsmanager.{{AWS_REGION}}.amazonaws.com',
          protocol: 'https',
          host: ['secretsmanager', '{{AWS_REGION}}', 'amazonaws', 'com']
        }
      },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: [
              'if (pm.environment.get("CI") === "true") { return; }',
              'const body = pm.response.json();',
              'if (body.SecretString) {',
              '  const secrets = JSON.parse(body.SecretString);',
              '  Object.entries(secrets).forEach(([k, v]) => pm.collectionVariables.set(k, v));',
              '}'
            ]
          }
        }
      ]
    });
  });

  it('stamps the script type on every provider helper', () => {
    for (const provider of ['aws', 'azure', 'gcp'] as const) {
      const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, {
        secretsResolverProvider: provider
      });
      const resolver = (built.collection.item as JsonRecord[])[0]!;
      const event = (resolver.event as JsonRecord[])[0]!;
      expect((event.script as JsonRecord).type).toBe('text/javascript');
    }
  });
});
