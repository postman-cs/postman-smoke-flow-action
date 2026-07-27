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
  it('build prepends the resolver by default and verification passes', () => {
    const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, {});
    const items = built.collection.item as JsonRecord[];
    expect(JSON.stringify(items[0])).toContain('SecretString');
    const verification = verifyGeneratedSmokeCollection(built.collection, undefined, {});
    expect(verification.ok).toBe(true);
  });

  it('build does not duplicate an existing resolver item', () => {
    const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, {});
    const rebuilt = buildGeneratedSmokeCollection(built.collection, undefined, {});
    const resolverCount = (rebuilt.collection.item as JsonRecord[]).filter((item) =>
      JSON.stringify(item).includes('SecretString')
    ).length;
    expect(resolverCount).toBe(1);
  });

  it('build removes a previously inserted resolver when disabled and verification passes', () => {
    const enabled = buildGeneratedSmokeCollection(generatedCollection(), undefined, {});
    expect(JSON.stringify(enabled.collection.item)).toContain('SecretString');
    const built = buildGeneratedSmokeCollection(enabled.collection, undefined, {
      secretsResolverEnabled: false
    });
    expect(JSON.stringify(built.collection.item)).not.toContain('SecretString');
    const verification = verifyGeneratedSmokeCollection(built.collection, undefined, {
      secretsResolverEnabled: false
    });
    expect(verification.ok).toBe(true);
  });

  it('applying auth never overwrites the resolver item AWSv4 auth (alias names included)', () => {
    const enabled = buildGeneratedSmokeCollection(generatedCollection(), undefined, {});
    const resolver = (enabled.collection.item as JsonRecord[]).find((item) =>
      JSON.stringify(item).includes('SecretString')
    ) as JsonRecord;
    resolver.name = 'Resolve Secrets';
    const authed = buildGeneratedSmokeCollection(enabled.collection, {
      enabled: true,
      type: 'apiKey',
      name: 'X-API-Key',
      location: 'header'
    } as never, {});
    const authedResolver = (authed.collection.item as JsonRecord[]).find((item) =>
      JSON.stringify(item).includes('SecretString')
    ) as JsonRecord;
    const auth = (authedResolver.request as JsonRecord).auth as JsonRecord;
    expect(auth?.type).toBe('awsv4');
  });

  it('verification fails when the resolver is enabled but missing', () => {
    const verification = verifyGeneratedSmokeCollection(generatedCollection(), undefined, {});
    expect(verification.ok).toBe(false);
    expect(verification.summary).toContain('secrets resolver request is missing');
  });

  it('verification fails when the resolver is disabled but still present', () => {
    const built = buildGeneratedSmokeCollection(generatedCollection(), undefined, {});
    const verification = verifyGeneratedSmokeCollection(built.collection, undefined, {
      secretsResolverEnabled: false
    });
    expect(verification.ok).toBe(false);
    expect(verification.summary).toContain('secrets resolver request is still present');
  });
});
