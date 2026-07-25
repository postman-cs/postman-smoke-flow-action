/**
 * Automatic release-cut contract.
 *
 * Pins the invariants whose absence burned immutable release tags before gates
 * ran: a burnt version must be skipped rather than reused, and the tag must be
 * created only after the committed release bytes pass every gate.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as releaseCut from '../scripts/release-cut.mjs';

const parseConventionalBump = releaseCut.parseConventionalBump as (m: string[]) => string | null;
const applyBump = releaseCut.applyBump as (v: string, b: string) => string;
const selectNextVersion = releaseCut.selectNextVersion as (input: {
  current: string;
  bump: string;
  takenTags: string[];
}) => { version: string; skipped: string[] };

const repoRoot = process.cwd();
const autoReleaseWorkflow = readFileSync(
  join(repoRoot, '.github/workflows/auto-release.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const releaseCutSource = readFileSync(join(repoRoot, 'scripts/release-cut.mjs'), 'utf8');

describe('release version selection', () => {
  it('skips a burnt version instead of reusing it', () => {
    const plan = selectNextVersion({
      current: '2.1.25',
      bump: 'patch',
      takenTags: ['v2.1.25', 'v2.1.26']
    });
    expect(plan.version).toBe('2.1.27');
    expect(plan.skipped).toContain('2.1.26');
  });

  it('never returns a version that is already tagged', () => {
    const taken = ['v3.0.0', 'v3.0.1', 'v3.0.2', 'v3.0.3'];
    const plan = selectNextVersion({ current: '3.0.0', bump: 'patch', takenTags: taken });
    expect(taken).not.toContain(`v${plan.version}`);
    expect(plan.version).toBe('3.0.4');
  });

  it('maps conventional commits onto semver bumps', () => {
    expect(parseConventionalBump(['feat: add input'])).toBe('minor');
    expect(parseConventionalBump(['fix: correct reshape'])).toBe('patch');
    expect(parseConventionalBump(['feat!: drop legacy input'])).toBe('major');
    expect(parseConventionalBump(['refactor: x\n\nBREAKING CHANGE: removed'])).toBe('major');
    expect(parseConventionalBump(['feat: a', 'fix: b'])).toBe('minor');
    expect(applyBump('2.1.27', 'minor')).toBe('2.2.0');
  });

  it('does not cut a release for release-plumbing commits alone', () => {
    expect(parseConventionalBump(['chore(release): v2.1.27'])).toBeNull();
    expect(parseConventionalBump(['chore: tune gate queue'])).toBeNull();
    expect(parseConventionalBump(['ci: retune gate queue', 'test: add case'])).toBeNull();
    expect(parseConventionalBump([])).toBeNull();
  });
});

describe('release-cut ordering contract', () => {
  it('creates the tag only after the committed release bytes are verified', () => {
    const tagIndex = releaseCutSource.indexOf("'tag', '-a'");
    const commitIndex = releaseCutSource.indexOf("'commit', '-m'");
    const verifyAfterCommit = releaseCutSource.indexOf('const releaseCommit');
    expect(tagIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeLessThan(verifyAfterCommit);
    expect(verifyAfterCommit).toBeLessThan(tagIndex);
  });

  it('reads every sha in-process rather than through shell variables', () => {
    expect(releaseCutSource).not.toContain('PREPARE_SHA');
    expect(releaseCutSource).toContain("git(['rev-parse', 'HEAD'])");
  });

  it('rebuilds dist before committing and verifies committed dist before tagging', () => {
    expect(releaseCutSource).toContain("run('npm', ['run', 'bundle'])");
    const rebuild = releaseCutSource.indexOf('rebuildDist();');
    const commit = releaseCutSource.indexOf("'commit', '-m'");
    const assertDist = releaseCutSource.indexOf('assertCommittedDistMatchesSource();');
    const tag = releaseCutSource.indexOf("'tag', '-a'");
    expect(rebuild).toBeGreaterThan(-1);
    expect(rebuild).toBeLessThan(commit);
    expect(commit).toBeLessThan(assertDist);
    expect(assertDist).toBeLessThan(tag);
  });

  it('stages only release paths in the release commit', () => {
    expect(releaseCutSource).toContain("'add', 'package.json', 'package-lock.json', 'dist'");
    expect(releaseCutSource).toContain('assertReleaseOnlyStagedPaths');
    expect(releaseCutSource).not.toContain('validation/evidence');
  });
});

describe('auto-release workflow', () => {
  it('cuts from main pushes instead of hand-pushed tags', () => {
    expect(autoReleaseWorkflow).toContain('branches: [main]');
    expect(autoReleaseWorkflow).not.toMatch(/on:\n\s+push:\n\s+tags:/);
  });

  it('fetches full history and tags so burnt versions are visible', () => {
    expect(autoReleaseWorkflow).toContain('fetch-depth: 0');
    expect(autoReleaseWorkflow).toContain('fetch-tags: true');
  });

  it('plans before it cuts and cuts before it pushes', () => {
    const plan = autoReleaseWorkflow.indexOf('name: Plan release');
    const cut = autoReleaseWorkflow.indexOf('name: Cut release');
    const push = autoReleaseWorkflow.indexOf('name: Push release tag');
    expect(plan).toBeGreaterThan(-1);
    expect(plan).toBeLessThan(cut);
    expect(cut).toBeLessThan(push);
  });

  it('pushes only the tag, never a commit onto protected main', () => {
    expect(autoReleaseWorkflow).toContain('git push origin "refs/tags/v${VERSION}"');
    expect(autoReleaseWorkflow).not.toContain('HEAD:${GITHUB_REF_NAME}');
    expect(autoReleaseWorkflow).not.toContain('gh pr create');
  });

  it('starts release.yml explicitly after the tag push', () => {
    const push = autoReleaseWorkflow.indexOf('name: Push release tag');
    const dispatch = autoReleaseWorkflow.indexOf('name: Start release workflow for the new tag');
    expect(dispatch).toBeGreaterThan(push);
    expect(autoReleaseWorkflow).toContain('gh workflow run release.yml --ref "v${VERSION}"');
  });

  it('never cancels a cut in flight', () => {
    expect(autoReleaseWorkflow).toContain('cancel-in-progress: false');
  });

  it('writes its plan outside the worktree so the cut sees a clean tree', () => {
    expect(autoReleaseWorkflow).not.toMatch(/tee plan\.json/);
    expect(autoReleaseWorkflow).toContain('PLAN_FILE: ${{ runner.temp }}/plan.json');
  });
});
