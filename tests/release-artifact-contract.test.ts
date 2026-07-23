import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyRelease } from '../scripts/classify-release.mjs';
import {
  assertNpmSriMatch,
  computeNpmSri,
  expectedArtifactNames,
  sha256,
  validateManifest
} from '../scripts/verify-release-artifacts.mjs';

const VERIFIER = join(process.cwd(), 'scripts/verify-release-artifacts.mjs');

const PACKAGE_NAME = '@postman-cse/onboarding-smoke-flow';
const PACKAGE_VERSION = '2.1.6';
const REPOSITORY = 'postman-cs/postman-smoke-flow-action';
const COMMIT_SHA = 'abc123';
const TAG = 'v2.1.6';
const SEA = `postman-smoke-flow-${PACKAGE_VERSION}-linux-x64`;
const SIDECAR = `${SEA}.sha256`;

const tarballBytes = Buffer.from('release tarball bytes');
const seaBytes = Buffer.from('sea binary bytes');
const seaDigest = createHash('sha256').update(seaBytes).digest('hex');
const sidecarBytes = Buffer.from(`${seaDigest}  ${SEA}\n`);

function artifactMap(overrides: Record<string, Buffer | undefined> = {}) {
  const base: Record<string, Buffer> = {
    'release.tgz': tarballBytes,
    [SEA]: seaBytes,
    [SIDECAR]: sidecarBytes
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return new Map(Object.entries(base));
}

function manifest(overrides: Record<string, unknown> = {}, artifacts = artifactMap()) {
  const listed = [...artifacts.keys()]
    .filter((path) => path !== 'release-manifest.json')
    .map((path) => ({ path, sha256: sha256(artifacts.get(path)!) }));
  return {
    schema_version: 1,
    repository: REPOSITORY,
    commit_sha: COMMIT_SHA,
    tag: TAG,
    package_name: PACKAGE_NAME,
    package_version: PACKAGE_VERSION,
    artifacts: listed,
    ...overrides
  };
}

function context(artifacts = artifactMap(), overrides: Partial<{
  repository: string;
  commitSha: string;
  tag: string;
  packageName: string;
  packageVersion: string;
}> = {}) {
  return {
    repository: REPOSITORY,
    commitSha: COMMIT_SHA,
    tag: TAG,
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    artifacts,
    ...overrides
  };
}

describe('release classification contract', () => {
  it('classifies exact and zero-patch immutable tags, alias no-ops, and rejects mismatches', () => {
    expect(classifyRelease({
      ref: 'refs/tags/v2.1.6',
      refName: 'v2.1.6',
      packageVersion: '2.1.6'
    })).toEqual({ release_kind: 'immutable', npm_publish: 'true' });
    expect(classifyRelease({
      ref: 'refs/tags/v2.1',
      refName: 'v2.1',
      packageVersion: '2.1.0'
    })).toEqual({ release_kind: 'immutable', npm_publish: 'true' });
    expect(classifyRelease({
      ref: 'refs/tags/v2',
      refName: 'v2',
      packageVersion: '2.1.6'
    })).toEqual({ release_kind: 'alias', npm_publish: 'false' });
    expect(() => classifyRelease({
      ref: 'refs/heads/main',
      refName: 'main',
      packageVersion: '2.1.6'
    })).toThrow(/got refs\/heads\/main.*expected v2\.1\.6/);
    expect(() => classifyRelease({
      ref: 'refs/tags/v2.1',
      refName: 'v2.1',
      packageVersion: '2.1.6'
    })).toThrow(/got v2\.1.*expected v2\.1\.6/);
    expect(() => classifyRelease({
      ref: 'refs/tags/v9.9.9',
      refName: 'v9.9.9',
      packageVersion: '2.1.6'
    })).toThrow(/got v9\.9\.9/);
  });
});

describe('release artifact verifier contract', () => {
  it('accepts a valid full SEA fixture bound to release identity', () => {
    const artifacts = artifactMap();
    expect(expectedArtifactNames(PACKAGE_VERSION)).toEqual(['release.tgz', SEA, SIDECAR]);
    expect(() => validateManifest(manifest({}, artifacts), context(artifacts))).not.toThrow();
  });

  it('rejects wrong repository, SHA, tag, version, and checksum fixtures', () => {
    const artifacts = artifactMap();
    expect(() => validateManifest(manifest({ repository: 'wrong/repo' }, artifacts), context(artifacts))).toThrow(/repository/);
    expect(() => validateManifest(manifest({ commit_sha: 'deadbeef' }, artifacts), context(artifacts))).toThrow(/commit_sha/);
    expect(() => validateManifest(manifest({ tag: 'v9.9.9' }, artifacts), context(artifacts, { tag: 'v9.9.9' }))).toThrow(/tag/);
    expect(() => validateManifest(
      manifest({ package_version: '9.9.9', tag: 'v9.9.9' }, artifacts),
      context(artifacts, { packageVersion: '9.9.9', tag: 'v9.9.9' })
    )).toThrow(/exact artifact allowlist|missing artifact|postman-smoke-flow-9\.9\.9/);
    expect(() => validateManifest(
      manifest({
        artifacts: [
          { path: 'release.tgz', sha256: '0'.repeat(64) },
          { path: SEA, sha256: sha256(seaBytes) },
          { path: SIDECAR, sha256: sha256(sidecarBytes) }
        ]
      }, artifacts),
      context(artifacts)
    )).toThrow(/checksum/);
  });

  it('rejects duplicate, unexpected, and missing artifacts plus malformed hashes', () => {
    const artifacts = artifactMap();
    expect(() => validateManifest(
      manifest({
        artifacts: [
          { path: 'release.tgz', sha256: sha256(tarballBytes) },
          { path: 'release.tgz', sha256: sha256(tarballBytes) },
          { path: SEA, sha256: sha256(seaBytes) },
          { path: SIDECAR, sha256: sha256(sidecarBytes) }
        ]
      }, artifacts),
      context(artifacts)
    )).toThrow(/duplicate/);
    expect(() => validateManifest(manifest({}, artifacts), context(artifactMap({ 'extra.bin': Buffer.from('x') })))).toThrow(/unexpected/);
    expect(() => validateManifest(manifest({}, artifacts), context(artifactMap({ [SIDECAR]: undefined })))).toThrow(/missing/);
    expect(() => validateManifest(
      manifest({
        artifacts: [
          { path: 'release.tgz', sha256: 'NOT-A-HASH' },
          { path: SEA, sha256: sha256(seaBytes) },
          { path: SIDECAR, sha256: sha256(sidecarBytes) }
        ]
      }, artifacts),
      context(artifacts)
    )).toThrow(/sha256/);
  });

  it('rejects SEA sidecar identity mismatches as part of the pure contract', () => {
    const badSidecar = artifactMap({ [SIDECAR]: Buffer.from(`${'1'.repeat(64)}  ${SEA}\n`) });
    expect(() => validateManifest(manifest({}, badSidecar), context(badSidecar))).toThrow(/sidecar|checksum/);
    const wrongName = artifactMap({ [SIDECAR]: Buffer.from(`${seaDigest}  wrong-name\n`) });
    expect(() => validateManifest(manifest({}, wrongName), context(wrongName))).toThrow(/sidecar/);
  });

  it('accepts matching npm SRI and rejects mismatched integrity', () => {
    const integrity = computeNpmSri(tarballBytes);
    expect(integrity).toMatch(/^sha512-/);
    expect(() => assertNpmSriMatch(integrity, computeNpmSri(tarballBytes))).not.toThrow();
    expect(() => assertNpmSriMatch('sha512-not-the-staged-tarball', integrity)).toThrow(/integrity/);
  });
});

describe('release artifact verifier CLI', () => {
  function writeCliFixture(): string {
    const directory = mkdtempSync(join(tmpdir(), 'release-cli-'));
    const packageDir = join(directory, 'package');
    mkdirSync(packageDir);
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION
    }));
    execFileSync('tar', ['-czf', join(directory, 'release.tgz'), '-C', directory, 'package']);
    rmSync(packageDir, { recursive: true, force: true });
    writeFileSync(join(directory, SEA), seaBytes);
    writeFileSync(join(directory, SIDECAR), sidecarBytes);
    const onDisk = new Map<string, Buffer>([
      ['release.tgz', readFileSync(join(directory, 'release.tgz'))],
      [SEA, seaBytes],
      [SIDECAR, sidecarBytes]
    ]);
    writeFileSync(join(directory, 'release-manifest.json'), `${JSON.stringify(manifest({}, onDisk), null, 2)}\n`);
    return directory;
  }

  function runVerifier(directory: string) {
    return execFileSync(process.execPath, [VERIFIER, directory], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_SHA: COMMIT_SHA,
        GITHUB_REF_NAME: TAG
      }
    });
  }

  it('accepts a valid on-disk SEA fixture through the real CLI', () => {
    const directory = writeCliFixture();
    try {
      const output = runVerifier(directory);
      expect(output).toContain('release artifacts verified');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an unexpected directory entry through the real CLI', () => {
    const directory = writeCliFixture();
    try {
      mkdirSync(join(directory, 'unexpected-dir'));
      expect(() => runVerifier(directory)).toThrow(/unexpected non-file entry unexpected-dir/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
