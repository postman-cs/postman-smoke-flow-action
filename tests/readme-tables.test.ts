import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('README input/output tables', () => {
  it('match action.yml (run `npm run docs:tables` to regenerate)', () => {
    expect(() =>
      execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'render-action-tables.mjs'), '--check'], {
        cwd: repoRoot,
        stdio: 'pipe'
      })
    ).not.toThrow();
  });
});
