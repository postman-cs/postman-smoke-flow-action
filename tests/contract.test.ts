import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type ActionManifest = {
  name: string;
  description: string;
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, { description?: string }>;
};

type PackageJson = {
  scripts: Record<string, string>;
};

function loadManifest(): ActionManifest {
  return parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8')) as ActionManifest;
}

function loadPackageJson(): PackageJson {
  return JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
}

describe('postman-smoke-flow-action contract', () => {
  it('uses the expected action name and required inputs', () => {
    const manifest = loadManifest();
    expect(manifest.name).toBe('Postman Smoke Flow');
    expect(manifest.inputs['flow-path']?.required).toBe(false);
    expect(manifest.inputs['smoke-collection-id']?.required).toBe(true);
    expect(manifest.inputs['secrets-resolver-enabled']?.default).toBe('true');
  });

  it('defines the expected primary outputs', () => {
    const manifest = loadManifest();
    expect(Object.keys(manifest.outputs)).toEqual([
      'smoke-collection-id',
      'flow-apply-status',
      'flow-apply-summary-json',
      'temporary-smoke-collection-id',
      'flow-step-count',
      'resolved-operation-count',
      'applied-binding-count',
      'applied-extract-count',
      'assertion-count'
    ]);
  });

  it('exposes the standard validation scripts used by sibling actions', () => {
    const packageJson = loadPackageJson();
    expect(packageJson.scripts).toMatchObject({
      build: expect.any(String),
      'check:dist': expect.any(String),
      lint: 'eslint .',
      'lint:fix': 'eslint . --fix',
      test: 'vitest run',
      typecheck: 'tsc --noEmit -p tsconfig.json'
    });
  });
});
