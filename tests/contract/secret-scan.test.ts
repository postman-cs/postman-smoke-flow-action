import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const cassetteDir = join(import.meta.dirname, 'cassettes');
const canonicalPlaceholder = 'cassette-access-token';

function findLeaks(text: string): string[] {
  const normalized = text.replaceAll(canonicalPlaceholder, '');
  const patterns = [
    /\bPMAK-[A-Za-z0-9_-]+\b/i,
    /\b(?:access[_-]?token|api[_-]?key)\s*[:=]\s*["']?(?!cassette-access-token\b)[A-Za-z0-9._~-]{12,}/i,
    /\b(?:authorization|x-access-token)\s*[:=]/i,
    /https?:\/\/[^\s"']*(?:@|token=|access_token=|api_key=)[^\s"']*/i,
    /\b[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    /https?:\/\/(?:github|gitlab)\.com\//i,
    /\b(?:pmak|pma|pmt)_[A-Za-z0-9_-]{12,}\b/i
  ];
  return patterns.filter((pattern) => pattern.test(normalized)).map(String);
}

describe('contract cassette secret hygiene', () => {
  it('keeps committed cassette/source artifacts free of credentials', () => {
    const artifacts = readdirSync(cassetteDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readFileSync(join(cassetteDir, name), 'utf8'));

    expect(artifacts).not.toHaveLength(0);
    expect(artifacts.flatMap(findLeaks)).toEqual([]);
  });

  it.each([
    'PMAK-actual-secret-value',
    'authorization: Bearer actual-secret-value',
    'person@postman.com',
    'https://github.com/postman-eng/private-repo',
    'pmak_actual_secret_value'
  ])('fails for injected credential material', (sample) => {
    expect(findLeaks(sample)).not.toEqual([]);
  });

  it('fails for credential URLs with embedded auth', () => {
    const credentialUrl = ['https://', 'user', ':', 'actual', '-', 'secret', '@example.test/path'].join('');
    expect(findLeaks(credentialUrl)).not.toEqual([]);
  });

  it('allows the canonical cassette token placeholder only', () => {
    expect(findLeaks('{"access_token":"cassette-access-token"}')).toEqual([]);
  });
});
