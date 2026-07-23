import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const seaWorkflow = readFileSync(join(process.cwd(), '.github/workflows/sea-binary.yml'), 'utf8');

/** Extract one top-level job block: `  <id>:` through the next job header or EOF. */
function jobText(source: string, jobId: string): string {
  const jobsBody = source.match(/^jobs:\n([\s\S]*)$/m)?.[1] ?? '';
  const header = `  ${jobId}:\n`;
  const start = jobsBody.indexOf(header);
  if (start < 0) return '';
  const rest = jobsBody.slice(start + header.length);
  const nextJob = rest.search(/^ {2}[a-zA-Z0-9_-]+:\n/m);
  return header + (nextJob < 0 ? rest : rest.slice(0, nextJob));
}

function namedStep(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

/** Ordered gate names launched via `run <name> ...` (excludes the `run()` helper definition). */
function linuxQueuedGates(runGates: string): string[] {
  return [...runGates.matchAll(/^\s+run ([a-zA-Z0-9_-]+)\s+/gm)].map((m) => m[1]!);
}

const linux = jobText(ciWorkflow, 'gate');
const windows = jobText(ciWorkflow, 'windows');
const sea = jobText(seaWorkflow, 'build-and-smoke');

describe('CI and SEA PR workflow contracts', () => {
  it('groups by PR number or ref and cancels in-progress only on pull_request in both workflows', () => {
    expect(ciWorkflow).toContain(
      'group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");

    expect(seaWorkflow).toContain(
      'group: sea-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(seaWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it('checks out full history on Linux for commitlint and keeps Windows shallow', () => {
    expect(linux).toContain('fetch-depth: 0');
    expect(windows).not.toMatch(/^\s*fetch-depth:\s*/m);
    expect(windows).not.toContain('fetch-depth: 0');
  });

  it('bundles exactly once on Linux before the read-only queue', () => {
    expect(linux.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);
    expect(linux.indexOf('- run: npm run bundle')).toBeLessThan(linux.indexOf('- name: Run gates'));
    expect(windows).not.toContain('npm run bundle');
  });

  it('queues the exact Linux read-only gates with actionlint and PR-only commitlint', () => {
    const runGates = namedStep(linux, 'Run gates');
    expect(runGates.length).toBeGreaterThan(0);

    expect(runGates).toContain('MAX_PARALLEL_GATES=2');
    expect(runGates).toContain('while [ "${#pid[@]}" -ge "$MAX_PARALLEL_GATES" ]; do finish_one; done');
    expect(runGates).toContain('while [ "${#pid[@]}" -gt 0 ]; do finish_one; done');
    expect(runGates).toContain('wait -n -p finished_pid');

    expect(linuxQueuedGates(runGates)).toEqual([
      'lint',
      'test',
      'typecheck',
      'dist',
      'actionlint',
      'commitlint',
    ]);
    expect(runGates).toContain('run lint       npm run lint');
    expect(runGates).toContain('run test       npm test');
    expect(runGates).toContain('run typecheck  npm run typecheck');
    expect(runGates).toContain('run dist       npm run verify:dist:assert');
    expect(runGates).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(runGates).toContain('if [ "${{ github.event_name }}" = "pull_request" ]; then');
    expect(runGates).toContain('run commitlint npx commitlint \\');
    expect(runGates).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(runGates).toContain('--to "${{ github.event.pull_request.head.sha }}"');

    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toContain('npm run bundle');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
    expect(runGates).toContain('exit $fail');
  });

  it('pins actionlint 1.7.11 at $RUNNER_TEMP with zero Go setup or go install', () => {
    const install = namedStep(linux, 'Install actionlint');
    expect(install.length).toBeGreaterThan(0);
    expect(install).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash'
    );
    expect(install).toMatch(/393031adb9afb225ee52ae2ccd7a5af5525e03e8/);
    expect(install.match(/393031adb9afb225ee52ae2ccd7a5af5525e03e8/)?.[0]).toHaveLength(40);
    expect(install).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(install).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(ciWorkflow).not.toContain('/main/scripts/download-actionlint.bash');

    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');
    expect(ciWorkflow).not.toMatch(/\bgo install\b/);
    expect(seaWorkflow).not.toContain('actions/setup-go');
    expect(seaWorkflow).not.toMatch(/\bgo install\b/);
  });

  it('caches Windows node_modules with exact key and guarded prefer-offline npm ci', () => {
    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');

    expect(windows).toContain("node-version: '24'");
    expect(windows).not.toMatch(/^\s*cache:\s*npm\s*$/m);

    expect(windows).toContain('id: windows-node-modules');
    expect(windows).toContain(
      'uses: actions/cache@1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4.2.0',
    );
    expect(windows).toContain('path: node_modules');
    expect(windows).toContain(
      "key: Windows/node-24/exact-${{ hashFiles('package-lock.json') }}",
    );
    expect(windows).not.toContain('restore-keys');
    expect(windows).not.toContain('restore-key');

    expect(windows).toContain("if: steps.windows-node-modules.outputs.cache-hit != 'true'");
    expect(windows).toContain('run: npm ci --prefer-offline --no-audit --no-fund');
    expect(windows.match(/npm ci --prefer-offline --no-audit --no-fund/g) ?? []).toHaveLength(1);
    expect(windows.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(0);
  });

  it('runs sole direct unconditional node test script on Windows with no queue or build gates', () => {
    expect(windows.match(/^\s*- run: node --run test\s*$/gm) ?? []).toHaveLength(1);
    expect(windows).not.toContain('npm test');

    expect(windows).not.toContain('Run Windows gates');
    expect(windows).not.toContain('shell: pwsh');
    expect(windows).not.toContain('$MAX_PARALLEL_GATES');
    expect(windows).not.toContain('Start-Job');
    expect(windows).not.toContain('Wait-Job');
    expect(windows).not.toContain('Receive-Job');
    expect(windows).not.toMatch(/@\{ name = '/);

    expect(windows).not.toContain('npm run bundle');
    expect(windows).not.toContain('npm run build');
    expect(windows).not.toContain('npm run lint');
    expect(windows).not.toContain('npm run typecheck');
    expect(windows).not.toContain('npm run verify:dist');
    expect(windows).not.toContain('actionlint');
    expect(windows).not.toContain('commitlint');
  });

  it('keeps Linux and Windows jobs independent with no needs edges', () => {
    expect(linux).not.toMatch(/^\s*needs:/m);
    expect(windows).not.toMatch(/^\s*needs:/m);
    expect(ciWorkflow).not.toMatch(/^\s*needs:/m);
  });

  it('keeps upload-on-dist-failure on the Linux gate job', () => {
    const upload = namedStep(linux, 'Upload expected dist on mismatch');
    expect(upload.length).toBeGreaterThan(0);
    expect(upload).toContain('if: failure()');
    expect(upload).toContain('uses: actions/upload-artifact@v7');
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
  });

  it('exposes no NPM token in either PR workflow npm-ci path', () => {
    expect(ciWorkflow).not.toMatch(/NODE_AUTH_TOKEN\s*:/);
    expect(ciWorkflow).not.toContain('secrets.NPM_TOKEN');
    expect(ciWorkflow).not.toContain('NPM_TOKEN');

    expect(seaWorkflow).not.toMatch(/NODE_AUTH_TOKEN\s*:/);
    expect(seaWorkflow).not.toContain('secrets.NPM_TOKEN');
    expect(seaWorkflow).not.toContain('NPM_TOKEN');

    expect(linux.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(1);
    expect(windows).toContain('npm ci --prefer-offline --no-audit --no-fund');
    expect(sea.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(1);
  });
});
