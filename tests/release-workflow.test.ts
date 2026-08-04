import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const seaWorkflow = readFileSync(join(process.cwd(), '.github/workflows/sea-binary.yml'), 'utf8');
const seaBuildScript = readFileSync(join(process.cwd(), 'scripts/build-sea.sh'), 'utf8');
const seaProxyScript = readFileSync(join(process.cwd(), 'scripts/assert-sea-proxy.mjs'), 'utf8');
const seaDocs = readFileSync(join(process.cwd(), 'docs/self-contained-binary.md'), 'utf8');

function job(name: string): string {
  return releaseWorkflow.match(new RegExp(`  ${name}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|$)`))?.[0] ?? '';
}

function namedStep(name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = releaseWorkflow.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n  [a-z-]+:|$)`));
  return match?.[0] ?? '';
}

function npmRegistrySetupStep(): string {
  return releaseWorkflow
    .match(/ {6}- uses: actions\/setup-node@v\d+\n(?: {8}[^\n]+\n| {10}[^\n]+\n)*/g)
    ?.find((step) => step.includes("registry-url: 'https://registry.npmjs.org'")) ?? '';
}

// C6: executable confirmation of the notify-composite token-present / token-absent
// branches. The dispatch shell is extracted live from release.yml (not reimplemented),
// GitHub ${{ }} expressions are substituted with deterministic values, and the shell
// is executed through bash with a stub `gh` on PATH.
const DISPATCH_SERVER_URL = 'https://github.com';
const DISPATCH_REPOSITORY = 'postman-cs/postman-smoke-flow-action';
const DISPATCH_RUN_ID = '1';
const EXPECTED_RUN_URL = `${DISPATCH_SERVER_URL}/${DISPATCH_REPOSITORY}/actions/runs/${DISPATCH_RUN_ID}`;

function dispatchRunBody(): string {
  const step = namedStep('Dispatch sibling-release to the composite');
  const lines = step.split('\n');
  const runIdx = lines.findIndex((l) => l.trim() === 'run: |');
  if (runIdx === -1) throw new Error('Dispatch run body not found in release.yml');
  return (
    lines
      .slice(runIdx + 1)
      .map((line) => line.replace(/^ {10}/, ''))
      .join('\n')
      .replace(/\n+$/, '')
  );
}

function substituteGithubExpressions(shell: string): string {
  return shell
    .replace(/\$\{\{\s*github\.server_url\s*\}\}/g, DISPATCH_SERVER_URL)
    .replace(/\$\{\{\s*github\.repository\s*\}\}/g, DISPATCH_REPOSITORY)
    .replace(/\$\{\{\s*github\.run_id\s*\}\}/g, DISPATCH_RUN_ID);
}

interface DispatchRunResult {
  stdout: string;
  status: number;
  ghArgs: string[][];
}

function executeDispatchShell(ghToken: string): DispatchRunResult {
  const workdir = mkdtempSync(join(tmpdir(), 'dispatch-test-'));
  try {
    writeFileSync(join(workdir, 'dispatch.sh'), substituteGithubExpressions(dispatchRunBody()));

    const ghStub = [
      '#!/usr/bin/env sh',
      "printf 'CALL\\n' >> \"$GH_STUB_RECORD\"",
      "printf '%s\\n' \"$@\" >> \"$GH_STUB_RECORD\"",
      'exit 0',
      '',
    ].join('\n');
    const ghPath = join(workdir, 'gh');
    writeFileSync(ghPath, ghStub);
    chmodSync(ghPath, 0o755);

    const recordPath = join(workdir, 'gh-record.txt');
    const stdout = execFileSync('bash', [join(workdir, 'dispatch.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${workdir}:${process.env.PATH || ''}`,
        GH_TOKEN: ghToken,
        GITHUB_REPOSITORY: DISPATCH_REPOSITORY,
        GH_STUB_RECORD: recordPath,
      },
      cwd: workdir,
      timeout: 10000,
    }) as string;

    const ghArgs: string[][] = [];
    if (existsSync(recordPath)) {
      const record = readFileSync(recordPath, 'utf8');
      for (const call of record.split('CALL\n').filter((c) => c.trim())) {
        const args = call.trim().split('\n').filter(Boolean);
        if (args.length > 0) ghArgs.push(args);
      }
    }

    return { stdout, status: 0, ghArgs };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

describe('release workflow publishing contract', () => {
  it('classifies with the exported script before npm and keeps validation unprivileged', () => {
    const classify = job('classify');
    expect(classify).toContain('node scripts/classify-release.mjs');
    expect(classify).not.toContain('npm ci');
    expect(releaseWorkflow.indexOf('node scripts/classify-release.mjs')).toBeLessThan(releaseWorkflow.indexOf('npm ci'));
    expect(job('verify-package')).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");
    expect(job('verify-package')).toMatch(/permissions:\n {6}contents: read/);
    expect(job('verify-package')).not.toContain('id-token: write');
    expect(releaseWorkflow).not.toContain('actions/setup-go');
    expect(releaseWorkflow).not.toContain('go install github.com/rhysd/actionlint');
    expect(releaseWorkflow).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash'
    );
    expect(releaseWorkflow.match(/393031adb9afb225ee52ae2ccd7a5af5525e03e8/)?.[0]).toHaveLength(40);
    expect(releaseWorkflow).not.toContain('/main/scripts/download-actionlint.bash');
    expect(releaseWorkflow).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(releaseWorkflow).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
  });

  it('queues one bundle before max-two read-only gates with no mutator in the queue', () => {
    const verify = job('verify-package');
    const gates = namedStep('Run gates');
    expect(verify.indexOf('npm run bundle')).toBeLessThan(verify.indexOf('Run gates'));
    expect(gates).toContain('MAX_PARALLEL_GATES=2');
    expect(gates).toContain('run lint npm run lint');
    expect(gates).toContain('run test npm test');
    expect(gates).toContain('run typecheck npm run typecheck');
    expect(gates).toContain('run dist npm run verify:dist:assert');
    expect(gates).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(gates).not.toContain('npm run bundle');
    expect(gates).not.toContain('npm run verify:dist\n');
    expect(gates).not.toContain('npm run build');
  });

  it('keeps every downstream job immutable-only', () => {
    expect(job('verify-package')).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");
    expect(job('publish')).toContain(
      "if: ${{ needs.classify.outputs.release_kind == 'immutable' && needs.verify-package.result == 'success' }}"
    );
    expect(job('advance-major-alias')).toContain(
      "if: ${{ needs.classify.outputs.release_kind == 'immutable' && needs.publish.result == 'success' }}"
    );
    expect(job('dispatch-live-monitor')).toContain(
      "if: ${{ needs.classify.outputs.release_kind == 'immutable' && needs.publish.result == 'success' }}"
    );
  });

  it('publishes only verified artifacts in npm-before-GitHub-before-alias order', () => {
    const publish = job('publish');
    const extract = namedStep('Extract artifact-bound verifier');
    expect(publish).toMatch(/permissions:\n {6}contents: write\n {6}id-token: write/);
    expect(publish).not.toContain('actions/checkout');
    expect(publish).not.toContain('npm ci');
    expect(publish).not.toContain('npm run bundle');
    expect(publish).not.toContain('npm test');
    expect(publish).not.toMatch(/^\s*- run: npm pack/m);
    expect(publish).not.toContain('npm pack --');
    expect(publish).not.toMatch(/\n\s+cache:/);
    expect(extract).toContain('"$RUNNER_TEMP/verify-release-artifacts.mjs"');
    expect(extract).not.toContain('mkdir -p scripts');
    expect(publish).toContain('node "$RUNNER_TEMP/verify-release-artifacts.mjs" .');
    expect(publish).not.toContain('node scripts/verify-release-artifacts.mjs');
    expect(publish.indexOf('node "$RUNNER_TEMP/verify-release-artifacts.mjs" .')).toBeLessThan(
      publish.indexOf('Publish npm package or verify existing identity')
    );
    expect(publish.indexOf('npm publish ./release.tgz --provenance --access public')).toBeLessThan(
      publish.indexOf('softprops/action-gh-release')
    );
    expect(publish).toContain('assertNpmSriMatch');
    expect(publish).toContain('computeNpmSri');
    expect(releaseWorkflow.indexOf('  publish:')).toBeLessThan(releaseWorkflow.indexOf('  advance-major-alias:'));
    expect(releaseWorkflow).toContain('group: release-${{ github.repository }}');
    expect(releaseWorkflow).toContain('cancel-in-progress: false');
  });

  it('uses staged artifacts and verifies npm identity before GitHub release', () => {
    const publishSetup = job('publish').match(/uses: actions\/setup-node@v\d+\n(?: {8}[^\n]+\n| {10}[^\n]+\n)*/)?.[0] ?? '';
    expect(publishSetup).not.toMatch(/\n\s+cache:/);
    expect(npmRegistrySetupStep()).not.toMatch(/\n\s+if:/);
    expect(namedStep('Publish npm package or verify existing identity')).toContain('npm view "$PKG_NAME@$PKG_VERSION" dist.integrity');
    expect(namedStep('Publish npm package or verify existing identity')).toContain('npm publish ./release.tgz --provenance --access public');
    expect(namedStep('Publish GitHub release assets')).toContain('release-manifest.json');
    expect(job('verify-package')).toContain('name: release-artifacts-${{ github.run_id }}-${{ github.run_attempt }}');
  });

  it('builds, smoke-tests, and attaches the self-contained SEA binary on release', () => {
    const verify = job('verify-package');
    expect(namedStep('Build self-contained SEA binary')).toContain('bash scripts/build-sea.sh');
    const smoke = namedStep('Smoke test SEA binary with an empty environment');
    expect(smoke).toContain('env -i PATH=/nonexistent');
    expect(smoke).toContain('postman-smoke-flow-${VERSION}-linux-x64');
    expect(smoke).toContain("NODE_OPTIONS='--this-flag-does-not-exist'");
    const proxySmoke = namedStep('Smoke test SEA proxy routing');
    expect(proxySmoke).toContain('scripts/assert-sea-proxy.mjs');
    expect(proxySmoke).toContain('iapub.postman.co:443');
    expect(verify.indexOf('Build self-contained SEA binary')).toBeLessThan(
      verify.indexOf('Smoke test SEA binary with an empty environment')
    );
    expect(verify.indexOf('Smoke test SEA binary with an empty environment')).toBeLessThan(
      verify.indexOf('Smoke test SEA proxy routing')
    );
    expect(verify.indexOf('Smoke test SEA proxy routing')).toBeLessThan(
      verify.indexOf('Stage release artifacts and manifest')
    );
    expect(seaWorkflow).toContain('scripts/assert-sea-proxy.mjs');
    expect(seaProxyScript).toContain("socket.on('error'");
    expect(releaseWorkflow).toContain('release-artifacts/postman-smoke-flow-*-linux-x64');
    expect(seaBuildScript).toContain('shasum -a 256');
    expect(seaBuildScript).toContain('.sha256');
    expect(seaWorkflow).toContain('build/sea/postman-smoke-flow-*-linux-x64.sha256');
    expect(releaseWorkflow).toContain('postman-smoke-flow-*-linux-x64.sha256');
  });

  it('documents proxy activation, telemetry egress, and checksum verification', () => {
    expect(seaDocs).toContain('NODE_USE_ENV_PROXY=1');
    expect(seaDocs).toContain('events.pm-cse.dev');
    expect(seaDocs).toContain('POSTMAN_ACTIONS_TELEMETRY=off');
    expect(seaDocs).toContain('shasum -a 256 -c');
  });

  it('advances the rolling major alias fail-closed with bot identity and shallow targeted fetch', () => {
    const alias = namedStep('Advance rolling major alias monotonically');
    expect(job('advance-major-alias')).toContain('advance-major-alias:');
    expect(alias).toContain("CANDIDATE=$(node -p \"require('./package.json').version\")");
    expect(alias).toContain('MAJOR="v${CANDIDATE%%.*}"');
    expect(alias).not.toContain('${GITHUB_REF_NAME#v}');
    expect(alias).toContain('git ls-remote --exit-code --tags origin "refs/tags/$MAJOR"');
    expect(alias).toContain('git fetch --depth=1 --no-tags origin "refs/tags/$MAJOR:refs/tags/$MAJOR"');
    expect(alias).not.toContain('|| true');
    expect(alias).toContain('failed to probe rolling alias');
    expect(alias).toContain('node scripts/classify-release.mjs alias-can-advance "$CURRENT" "$CANDIDATE"');
    expect(alias).toContain('cmp_status=$?');
    expect(alias).toContain('[ "$cmp_status" -eq 3 ]');
    expect(alias).toContain('candidate is older than current alias; not moving alias');
    expect(alias).toContain('failed to compare alias versions');
    expect(alias).not.toContain('sort -V');
    expect(alias).toContain('git config user.name "github-actions[bot]"');
    expect(alias).toContain('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
    expect(alias).toContain('git tag -fa "$MAJOR"');
    expect(alias).toContain('Rolling $MAJOR alias -> $GITHUB_REF_NAME');
    expect(alias).toContain('git push origin "refs/tags/$MAJOR" --force');
    expect(alias).not.toMatch(/git tag -fa "\$GITHUB_REF_NAME"/);
    expect(job('advance-major-alias')).toMatch(/needs: \[classify, publish\]/);
  });

  it('dispatches sibling-release from release.yml after alias advance because workflow_run cascades never fire for GITHUB_TOKEN-created Release runs', () => {
    const notify = job('notify-composite');
    expect(notify).toContain('needs: [classify, publish, advance-major-alias]');
    expect(notify).toContain(
      "if: ${{ !cancelled() && needs.classify.outputs.release_kind == 'immutable' && needs.publish.result == 'success' && needs['advance-major-alias'].result == 'success' }}"
    );
    expect(notify).toMatch(/permissions:\s*\{\}/);
    expect(notify).toContain('actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0');
    expect(notify).toContain('continue-on-error: true');
    expect(notify).toContain('app-id: ${{ secrets.SUITE_PIN_BOT_APP_ID }}');
    expect(notify).toContain('private-key: ${{ secrets.SUITE_PIN_BOT_PRIVATE_KEY }}');
    expect(notify).toContain('owner: postman-cs');
    expect(notify).toContain('repositories: postman-api-onboarding-action');
    expect(notify).toContain('event_type=sibling-release');
    expect(notify).toContain('client_payload[repository]=${GITHUB_REPOSITORY}');
    expect(notify).toContain(
      'client_payload[run]=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}'
    );
    expect(notify).toContain(
      "App token unavailable (secrets missing or mint failed); the composite's daily cron will pick this release up."
    );
    expect(notify).toContain('exit 0');
    expect(releaseWorkflow).not.toContain('github.event.workflow_run');
  });
});

describe('notification dispatch executable behavior', () => {
  it('token-present: dispatches sibling-release via gh api exactly once with exact endpoint, event_type, repository payload, and run URL', () => {
    const result = executeDispatchShell('app-token-stub');
    expect(result.status).toBe(0);
    expect(result.ghArgs).toHaveLength(1);
    const args = result.ghArgs[0];
    expect(args).toContain('api');
    expect(args).toContain('repos/postman-cs/postman-api-onboarding-action/dispatches');
    expect(args).toContain('event_type=sibling-release');
    expect(args).toContain(`client_payload[repository]=${DISPATCH_REPOSITORY}`);
    expect(args).toContain(`client_payload[run]=${EXPECTED_RUN_URL}`);
  });

  it('token-absent: prints cron-backstop notice, exits 0, and never calls gh', () => {
    const result = executeDispatchShell('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::notice::');
    expect(result.stdout).toContain('App token unavailable');
    expect(result.stdout).toContain("the composite's daily cron will pick this release up");
    expect(result.ghArgs).toHaveLength(0);
  });
});
