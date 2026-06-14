import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { readActionInputs } from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type ActionManifest = {
  name: string;
  description: string;
  inputs: Record<string, { description?: string; required?: boolean; default?: string }>;
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

function loadText(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function markerSection(content: string, startMarker: string, endMarker: string): string {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return content.slice(start, end);
}

describe('postman-smoke-flow-action contract', () => {
  it('uses the expected action name and required inputs', () => {
    const manifest = loadManifest();
    expect(manifest.name).toBe('Postman Onboarding: Smoke Flow');
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

  it('keeps README action tables in sync with action.yml', () => {
    const manifest = loadManifest();
    const readme = loadText('README.md');
    const inputsTable = markerSection(readme, '<!-- inputs-table:start -->', '<!-- inputs-table:end -->');
    const outputsTable = markerSection(readme, '<!-- outputs-table:start -->', '<!-- outputs-table:end -->');

    for (const inputName of Object.keys(manifest.inputs)) {
      const tick = String.fromCharCode(96);
      expect(inputsTable).toContain('| ' + tick + inputName + tick + ' |');
    }

    for (const outputName of Object.keys(manifest.outputs)) {
      const tick = String.fromCharCode(96);
      expect(outputsTable).toContain('| ' + tick + outputName + tick + ' |');
    }
  });

  it('documents and resolves supported Postman regions', () => {
    const manifest = loadManifest();
    const readme = loadText('README.md');
    const cliDocs = loadText('docs/cli.md');

    expect(manifest.inputs['postman-region']?.default).toBe('us');
    expect(manifest.inputs['postman-region']?.description).toMatch(/us.*eu|eu.*us/i);
    expect(readActionInputs({ INPUT_POSTMAN_REGION: 'eu' } as NodeJS.ProcessEnv).postmanApiBaseUrl).toBe(
      'https://api.eu.postman.com'
    );
    expect(readActionInputs({} as NodeJS.ProcessEnv).postmanApiBaseUrl).toBe('https://api.getpostman.com');
    expect(readme).toContain('postman-region: eu');
    expect(cliDocs).toContain('--postman-region eu');
  });

  it('keeps marketplace-facing copy release-ready', () => {
    const marketplaceText = [
      loadText('README.md'),
      loadText('docs/cli.md'),
      loadText('docs/flow-manifest.md'),
      loadText('docs/smoke-oauth.md'),
      loadText('action.yml')
    ].join('\\n');
    const blockedTerms = ['customer ' + 'pre' + 'view', 'customer-' + 'pre' + 'view', 'pre' + 'view', 'inter' + 'nal'];

    expect(marketplaceText).not.toMatch(new RegExp(blockedTerms.join('|'), 'i'));
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
