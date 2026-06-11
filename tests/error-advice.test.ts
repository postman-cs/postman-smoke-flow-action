import { describe, expect, it } from 'vitest';

import { adviseFromSmokeClientStatus } from '../src/lib/error-advice.js';

describe('adviseFromSmokeClientStatus', () => {
  it('401 on a read operation returns key-rejected guidance naming the collection', () => {
    const result = adviseFromSmokeClientStatus(401, 'col-abc123', 'read');
    expect(result).toBeDefined();
    expect(result).toContain('col-abc123');
    expect(result).toContain('postman-api-key');
  });

  it('403 on a read operation returns key-rejected guidance naming the collection', () => {
    const result = adviseFromSmokeClientStatus(403, 'col-abc123', 'read');
    expect(result).toBeDefined();
    expect(result).toContain('col-abc123');
    expect(result).toContain('postman-api-key');
  });

  it('401 on a write operation returns write-specific guidance', () => {
    const result = adviseFromSmokeClientStatus(401, 'col-write-99', 'write');
    expect(result).toBeDefined();
    expect(result).toContain('col-write-99');
    expect(result).toContain('postman-api-key');
  });

  it('403 on a write operation returns write-specific guidance', () => {
    const result = adviseFromSmokeClientStatus(403, 'col-write-99', 'write');
    expect(result).toBeDefined();
    expect(result).toContain('col-write-99');
    expect(result).toContain('postman-api-key');
  });

  it('404 returns not-found guidance naming the collection', () => {
    const result = adviseFromSmokeClientStatus(404, 'col-xyz', 'read');
    expect(result).toBeDefined();
    expect(result).toContain('col-xyz');
    expect(result).toContain('wrong-team');
  });

  it('404 on write context also returns not-found guidance', () => {
    const result = adviseFromSmokeClientStatus(404, 'col-xyz', 'write');
    expect(result).toBeDefined();
    expect(result).toContain('col-xyz');
  });

  it('500 returns undefined (no known mapping)', () => {
    expect(adviseFromSmokeClientStatus(500, 'col-abc', 'read')).toBeUndefined();
  });

  it('200 returns undefined (no mapping for success)', () => {
    expect(adviseFromSmokeClientStatus(200, 'col-abc', 'read')).toBeUndefined();
  });

  it('429 returns undefined (no mapping)', () => {
    expect(adviseFromSmokeClientStatus(429, 'col-abc', 'write')).toBeUndefined();
  });
});

describe('adviseFromSmokeClientStatus style-ban and safety', () => {
  const allStatuses: Array<[number, string]> = [
    [401, 'read'],
    [401, 'write'],
    [403, 'read'],
    [403, 'write'],
    [404, 'read'],
    [404, 'write'],
  ];

  it.each(allStatuses)('status %i context %s: no Bearer token in advice text', (status, ctx) => {
    const result = adviseFromSmokeClientStatus(status, 'col-test', ctx as 'read' | 'write');
    if (result !== undefined) {
      expect(result).not.toContain('Bearer ');
    }
  });

  it.each(allStatuses)('status %i context %s: no x-access-token header in advice text', (status, ctx) => {
    const result = adviseFromSmokeClientStatus(status, 'col-test', ctx as 'read' | 'write');
    if (result !== undefined) {
      expect(result).not.toContain('x-access-token:');
    }
  });

  it.each(allStatuses)('status %i context %s: no em dash (U+2014) in advice text', (status, ctx) => {
    const result = adviseFromSmokeClientStatus(status, 'col-test', ctx as 'read' | 'write');
    if (result !== undefined) {
      expect(result).not.toContain('\u2014');
    }
  });

  it.each(allStatuses)('status %i context %s: no ", not " antithesis in advice text', (status, ctx) => {
    const result = adviseFromSmokeClientStatus(status, 'col-test', ctx as 'read' | 'write');
    if (result !== undefined) {
      expect(result).not.toContain(', not ');
    }
  });

  it.each(allStatuses)('status %i context %s: no " - not " antithesis in advice text', (status, ctx) => {
    const result = adviseFromSmokeClientStatus(status, 'col-test', ctx as 'read' | 'write');
    if (result !== undefined) {
      expect(result).not.toContain(' - not ');
    }
  });
});
