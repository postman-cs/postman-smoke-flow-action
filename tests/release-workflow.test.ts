import { readFileSync } from 'node:fs';
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
    expect(alias).toContain('git ls-remote --exit-code --tags origin "refs/tags/$MAJOR"');
    expect(alias).toContain('git fetch --depth=1 --no-tags origin "refs/tags/$MAJOR:refs/tags/$MAJOR"');
    expect(alias).not.toContain('|| true');
    expect(alias).toContain('failed to probe rolling alias');
    expect(alias).toContain('candidate is older than current alias; not moving alias');
    expect(alias).toContain('git config user.name "github-actions[bot]"');
    expect(alias).toContain('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
    expect(alias).toContain('git tag -fa "$MAJOR"');
    expect(alias).toContain('git push origin "refs/tags/$MAJOR" --force');
    expect(alias).not.toMatch(/git tag -fa "\$GITHUB_REF_NAME"/);
    expect(job('advance-major-alias')).toMatch(/needs: \[classify, publish\]/);
  });
});
