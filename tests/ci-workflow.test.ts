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

  it('bundles exactly once on Linux and Windows before each read-only queue', () => {
    expect(linux.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);
    expect(windows.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);

    expect(linux.indexOf('- run: npm run bundle')).toBeLessThan(linux.indexOf('- name: Run gates'));
    expect(windows.indexOf('- run: npm run bundle')).toBeLessThan(
      windows.indexOf('- name: Run Windows gates'),
    );

    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');
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
    expect(install).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(install).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');

    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');
    expect(ciWorkflow).not.toMatch(/\bgo install\b/);
    expect(seaWorkflow).not.toContain('actions/setup-go');
    expect(seaWorkflow).not.toMatch(/\bgo install\b/);
  });

  it('queues exactly four Windows gates at max-two with terminating throw failure propagation', () => {
    const runGates = namedStep(windows, 'Run Windows gates');
    expect(runGates.length).toBeGreaterThan(0);
    expect(runGates).toContain('shell: pwsh');
    expect(runGates).toContain('$MAX_PARALLEL_GATES = 2');
    expect(runGates).toContain('while ($running.Count -ge $MAX_PARALLEL_GATES)');
    expect(runGates).toContain('Start-Job');

    expect(runGates).toContain("@{ name = 'lint' }");
    expect(runGates).toContain("@{ name = 'test' }");
    expect(runGates).toContain("@{ name = 'typecheck' }");
    expect(runGates).toContain("@{ name = 'dist' }");
    expect(runGates.match(/@\{ name = '[^']+' \}/g) ?? []).toHaveLength(4);

    expect(runGates).toContain("'lint' { npm run lint }");
    expect(runGates).toContain("'test' { npm test }");
    expect(runGates).toContain("'typecheck' { npm run typecheck }");
    expect(runGates).toContain("'dist' { npm run verify:dist:assert }");

    expect(runGates).toContain(
      'if ($LASTEXITCODE -ne 0) { throw "gate $name failed with exit code $LASTEXITCODE" }',
    );
    expect(runGates).not.toMatch(/if \(\$LASTEXITCODE -ne 0\) \{ exit /);
    expect(runGates).toContain("$results[$done.Name] = $done.State -eq 'Completed'");
    expect(runGates).toContain("$results[$job.Name] = $job.State -eq 'Completed'");

    // Under GitHub's $ErrorActionPreference='Stop', Receive-Job on a Failed child
    // would terminate the parent before aggregate status printing unless both drain
    // sites capture all streams with -ErrorAction Continue.
    expect(runGates).toContain(
      'Receive-Job $done -ErrorAction Continue *>&1 | Out-File "$($done.Name).log"',
    );
    expect(runGates).toContain(
      'Receive-Job $job -ErrorAction Continue *>&1 | Out-File "$($job.Name).log"',
    );
    expect(runGates.match(/Receive-Job \$\w+ -ErrorAction Continue \*>&1 \| Out-File/g) ?? []).toHaveLength(
      2,
    );
    expect(runGates).not.toMatch(/Receive-Job \$\w+\s*\|/);

    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toContain('npm run bundle');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).not.toContain('actionlint');
    expect(runGates).not.toContain('commitlint');

    expect(runGates).toContain('gate:$($gate.name)=pass');
    expect(runGates).toContain('gate:$($gate.name)=fail');
    expect(runGates).toContain('if ($failed) { exit 1 }');
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
    expect(windows.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(1);
    expect(sea.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(1);
  });
});
