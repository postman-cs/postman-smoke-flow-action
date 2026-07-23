import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BRANCH_DECISION_ENV,
  parseBranchDecision,
  parseChannelRules,
  resolveBranchDecision,
  resolveBranchIdentity,
  resolveEffectiveBranchDecision,
  serializeBranchDecision,
  type BranchDecision,
  type BranchIdentity
} from '../src/lib/repo-branch-decision.js';
import type { CoreLike } from '../src/types.js';

const mintSpy = vi.fn(async () => undefined);
vi.mock('../src/lib/postman/token-provider.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/postman/token-provider.js')>(
    '../src/lib/postman/token-provider.js'
  );
  return { ...actual, mintAccessTokenIfNeeded: mintSpy };
});

const { runAction } = await import('../src/index.js');

const tempDirs: string[] = [];
afterEach(() => {
  mintSpy.mockClear();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function githubEvent(payload: object): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'smoke-branch-decision-'));
  tempDirs.push(directory);
  const eventPath = path.join(directory, 'event.json');
  writeFileSync(eventPath, JSON.stringify(payload));
  return eventPath;
}

describe('provider branch identity', () => {
  it.each([
    ['GitHub push', { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/feature/payments' }, 'feature/payments', false],
    ['GitLab branch', { GITLAB_CI: 'true', CI_COMMIT_BRANCH: 'feature/payments' }, 'feature/payments', false],
    ['GitLab MR', { GITLAB_CI: 'true', CI_COMMIT_BRANCH: '99/merge', CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feature/payments' }, 'feature/payments', true],
    ['Bitbucket', { BITBUCKET_REPO_SLUG: 'svc', BITBUCKET_BRANCH: 'feature/payments' }, 'feature/payments', false],
    ['Azure full ref', { TF_BUILD: 'true', BUILD_SOURCEBRANCH: 'refs/heads/feature/payments', BUILD_SOURCEBRANCHNAME: 'payments' }, 'feature/payments', false]
  ] as const)('%s resolves the full head branch', (_name, env, headBranch, isPrContext) => {
    expect(resolveBranchIdentity(env)).toMatchObject({ headBranch, isPrContext, refKind: 'branch' });
  });

  it('uses the GitHub PR head instead of the merge ref and detects a fork', () => {
    const eventPath = githubEvent({
      repository: { default_branch: 'main', full_name: 'postman/svc' },
      pull_request: {
        head: { ref: 'feature/payments', repo: { full_name: 'fork/svc' } },
        base: { repo: { full_name: 'postman/svc' } }
      }
    });
    expect(resolveBranchIdentity({
      GITHUB_ACTIONS: 'true', GITHUB_HEAD_REF: 'feature/payments',
      GITHUB_REF: 'refs/pull/42/merge', GITHUB_REF_NAME: '42/merge', GITHUB_EVENT_PATH: eventPath
    })).toMatchObject({ headBranch: 'feature/payments', defaultBranch: 'main', isPrContext: true, isForkPr: true });
  });
});

function identity(overrides: Partial<BranchIdentity> = {}): BranchIdentity {
  return {
    provider: 'github', headBranch: 'feature/payments', rawRef: 'refs/heads/feature/payments',
    defaultBranch: 'main', refKind: 'branch', isPrContext: false, isForkPr: false, ...overrides
  };
}

describe('branch decision matrix', () => {
  it.each([
    ['legacy fallback', 'legacy', identity(), undefined, 'legacy'],
    ['canonical', 'publish-gate', identity({ headBranch: 'main', refKind: 'default-branch' }), undefined, 'canonical'],
    ['gated branch', 'publish-gate', identity(), undefined, 'gated'],
    ['preview branch', 'preview', identity(), undefined, 'preview'],
    ['configured channel', 'preview', identity({ headBranch: 'develop' }), 'develop=DEV', 'channel'],
    ['release RC channel', 'publish-gate', identity({ headBranch: 'release/2.0' }), undefined, 'channel'],
    ['fork preview', 'preview', identity({ isPrContext: true, isForkPr: true }), undefined, 'gated'],
    ['tag', 'preview', identity({ headBranch: undefined, refKind: 'tag', rawRef: 'refs/tags/v2' }), undefined, 'gated'],
    ['unknown', 'preview', identity({ headBranch: undefined, refKind: 'unknown', rawRef: undefined }), undefined, 'gated']
  ] as const)('%s resolves to %s', (_name, strategy, branchIdentity, channels, tier) => {
    const decision = resolveBranchDecision({
      strategy, identity: branchIdentity, channels: parseChannelRules(channels)
    });
    expect(decision.tier).toBe(tier);
    if (_name === 'release RC channel') expect(decision.channel).toEqual({ pattern: 'release/*', code: 'RC' });
  });

  it.each(['bitbucket', 'azure-devops'] as const)('%s fails loud without a canonical branch in nonlegacy mode', (provider) => {
    expect(() => resolveBranchDecision({
      strategy: 'publish-gate', identity: identity({ provider, defaultBranch: undefined })
    })).toThrow(/CONTRACT_DEFAULT_BRANCH_UNRESOLVED.*canonical-branch/);
  });
});

describe('immutable inherited decision', () => {
  const inherited: BranchDecision = {
    tier: 'gated', strategy: 'publish-gate', identity: identity(), canonicalBranch: 'main', reason: 'parent decision'
  };

  it.each([
    ['malformed JSON', '{'],
    ['missing identity', JSON.stringify({ tier: 'gated', strategy: 'publish-gate', reason: 'bad' })],
    ['invalid tier', JSON.stringify({ ...inherited, tier: 'wrong' })]
  ])('rejects %s', (_name, raw) => {
    expect(() => parseBranchDecision(raw)).toThrow(/CONTRACT_BRANCH_DECISION_INVALID/);
  });

  it('lets a valid inherited decision win over local classification', () => {
    const raw = serializeBranchDecision(inherited);
    expect(resolveEffectiveBranchDecision(
      { strategy: 'legacy', identity: identity({ headBranch: 'main' }) },
      { [BRANCH_DECISION_ENV]: raw }
    )).toEqual(inherited);
  });

  it('gates before mint/write and emits the serialized skip decision', async () => {
    const outputs = new Map<string, string>();
    const core: CoreLike = {
      info: vi.fn(), warning: vi.fn(), setFailed: vi.fn(), setSecret: vi.fn(),
      setOutput: vi.fn((name: string, value: string) => outputs.set(name, value))
    };
    const raw = serializeBranchDecision(inherited);
    const result = await runAction(core, {
      INPUT_BRANCH_STRATEGY: 'publish-gate',
      [BRANCH_DECISION_ENV]: raw
    });

    expect(mintSpy).not.toHaveBeenCalled();
    expect(result['sync-status']).toBe('skipped-branch-gate');
    expect(outputs.get('sync-status')).toBe('skipped-branch-gate');
    expect(outputs.get('branch-decision')).toBe(raw);
  });
});
