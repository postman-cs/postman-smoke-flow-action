import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {Buffer|Uint8Array|string} bytes
 * @returns {string}
 */
export function computeNpmSri(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/**
 * @param {string} expected
 * @param {string} actual
 */
export function assertNpmSriMatch(expected, actual) {
  if (expected !== actual) {
    throw new Error('published npm integrity does not match release.tgz');
  }
}

/**
 * @param {string} tag
 * @param {string} packageVersion
 */
export function validateTagVersion(tag, packageVersion) {
  const [major, minor, patch] = String(packageVersion).split('.');
  if (tag !== `v${packageVersion}` && !(patch === '0' && tag === `v${major}.${minor}`)) {
    throw new Error(`tag ${tag} does not match package version ${packageVersion}`);
  }
}

/**
 * @param {string} packageVersion
 * @returns {string[]}
 */
export function expectedArtifactNames(packageVersion) {
  const sea = `postman-smoke-flow-${packageVersion}-linux-x64`;
  return ['release.tgz', sea, `${sea}.sha256`];
}

/**
 * @param {Map<string, Uint8Array|Buffer>} artifacts
 * @param {string} packageVersion
 * @param {Array<{ path: string, sha256: string }>} manifestArtifacts
 */
export function validateSeaSidecar(artifacts, packageVersion, manifestArtifacts) {
  const sea = `postman-smoke-flow-${packageVersion}-linux-x64`;
  const sidecarName = `${sea}.sha256`;
  const seaEntry = manifestArtifacts.find((artifact) => artifact.path === sea);
  const sidecarEntry = manifestArtifacts.find((artifact) => artifact.path === sidecarName);
  const seaBytes = artifacts.get(sea);
  const sidecarBytes = artifacts.get(sidecarName);
  if (!seaEntry || !sidecarEntry || !seaBytes || !sidecarBytes) {
    throw new Error('SEA executable and sidecar are required');
  }
  const sidecarText = Buffer.from(sidecarBytes).toString('utf8').trim();
  const [digest = '', filename = ''] = sidecarText.split(/\s+/);
  if (!SHA256_HEX.test(digest) || filename !== sea) {
    throw new Error(`SEA sidecar text must be "<sha256> ${sea}"`);
  }
  const actual = sha256(seaBytes);
  if (digest !== actual || digest !== seaEntry.sha256 || sidecarEntry.sha256 !== sha256(sidecarBytes)) {
    throw new Error('SEA sidecar digest does not match executable and manifest');
  }
}

/**
 * @param {unknown} manifest
 * @param {{
 *   repository: string,
 *   commitSha: string,
 *   tag: string,
 *   packageName: string,
 *   packageVersion: string,
 *   artifacts: Map<string, Uint8Array|Buffer>
 * }} context
 */
export function validateManifest(manifest, { repository, commitSha, tag, packageName, packageVersion, artifacts }) {
  if (!manifest || typeof manifest !== 'object' || /** @type {{ schema_version?: unknown }} */ (manifest).schema_version !== 1) {
    throw new Error('manifest schema_version must be 1');
  }
  const body = /** @type {Record<string, unknown>} */ (manifest);
  for (const [field, expected] of Object.entries({
    repository,
    commit_sha: commitSha,
    tag,
    package_name: packageName,
    package_version: packageVersion
  })) {
    if (body[field] !== expected) throw new Error(`manifest ${field} mismatch`);
  }
  validateTagVersion(tag, packageVersion);

  if (!Array.isArray(body.artifacts) || body.artifacts.length === 0) {
    throw new Error('manifest artifacts is required');
  }

  const expectedNames = expectedArtifactNames(packageVersion);
  const seen = new Set();
  /** @type {Array<{ path: string, sha256: string }>} */
  const manifestArtifacts = [];
  for (const entry of body.artifacts) {
    if (!entry || typeof entry !== 'object') throw new Error('manifest artifact path and lowercase sha256 are required');
    const artifact = /** @type {Record<string, unknown>} */ (entry);
    if (typeof artifact.path !== 'string' || !SHA256_HEX.test(String(artifact.sha256 ?? ''))) {
      throw new Error('manifest artifact path and lowercase sha256 are required');
    }
    const path = artifact.path;
    if (path === 'release-manifest.json') {
      throw new Error('manifest itself must stay outside artifacts[]');
    }
    if (seen.has(path)) throw new Error(`duplicate artifact path ${path}`);
    seen.add(path);
    manifestArtifacts.push({ path, sha256: String(artifact.sha256) });
  }

  if (manifestArtifacts.length !== expectedNames.length || expectedNames.some((name) => !seen.has(name))) {
    throw new Error(`exact artifact allowlist mismatch; expected ${expectedNames.join(', ')}`);
  }

  for (const name of artifacts.keys()) {
    if (name === 'release-manifest.json') continue;
    if (!seen.has(name)) throw new Error(`unexpected artifact ${name}`);
  }
  for (const name of expectedNames) {
    if (!artifacts.has(name)) throw new Error(`missing artifact ${name}`);
  }

  for (const artifact of manifestArtifacts) {
    const bytes = artifacts.get(artifact.path);
    if (!bytes) throw new Error(`missing artifact ${artifact.path}`);
    if (sha256(bytes) !== artifact.sha256) throw new Error(`artifact checksum mismatch: ${artifact.path}`);
  }

  validateSeaSidecar(artifacts, packageVersion, manifestArtifacts);
}

/**
 * @param {string} directory
 * @returns {Map<string, Buffer>}
 */
export function readArtifactFiles(directory) {
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'release-manifest.json') continue;
    if (!entry.isFile()) {
      throw new Error(`unexpected non-file entry ${entry.name}`);
    }
    files.set(entry.name, readFileSync(join(directory, entry.name)));
  }
  return files;
}

function packageMetadata(tarball) {
  return JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
}

function main() {
  const directory = process.argv[2] ?? '.';
  const manifestPath = join(directory, 'release-manifest.json');
  if (!existsSync(manifestPath)) throw new Error('release-manifest.json is required');
  const files = readArtifactFiles(directory);
  const tarball = join(directory, 'release.tgz');
  if (!existsSync(tarball)) throw new Error('release.tgz is required');
  const pkg = packageMetadata(tarball);
  validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), {
    repository: process.env.GITHUB_REPOSITORY,
    commitSha: process.env.GITHUB_SHA,
    tag: process.env.GITHUB_REF_NAME,
    packageName: pkg.name,
    packageVersion: pkg.version,
    artifacts: files
  });
  console.log('release artifacts verified');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
