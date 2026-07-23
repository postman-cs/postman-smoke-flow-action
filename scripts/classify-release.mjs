import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NUMERIC_NO_LEADING_ZERO = /^(0|[1-9]\d*)$/;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;

/**
 * @typedef {{ major: bigint, minor: bigint, patch: bigint, prerelease: Array<bigint|string>, build: string }} SemVer
 */

/**
 * Strict SemVer 2.0 parser. Rejects leading-zero numeric components/identifiers.
 * Build metadata is parsed for validity but ignored by compareSemver.
 *
 * @param {string} version
 * @returns {SemVer}
 */
export function parseSemver(version) {
  const raw = String(version ?? '').trim().replace(/^v/i, '');
  if (!raw) throw new Error(`invalid semantic version: ${version}`);

  const plus = raw.indexOf('+');
  const coreAndPre = plus === -1 ? raw : raw.slice(0, plus);
  const build = plus === -1 ? '' : raw.slice(plus + 1);

  const dash = coreAndPre.indexOf('-');
  const core = dash === -1 ? coreAndPre : coreAndPre.slice(0, dash);
  const preRaw = dash === -1 ? '' : coreAndPre.slice(dash + 1);

  const coreParts = core.split('.');
  if (coreParts.length !== 3) throw new Error(`invalid semantic version: ${version}`);
  const [maj, min, pat] = coreParts;
  if (!NUMERIC_NO_LEADING_ZERO.test(maj) || !NUMERIC_NO_LEADING_ZERO.test(min) || !NUMERIC_NO_LEADING_ZERO.test(pat)) {
    throw new Error(`invalid semantic version: ${version}`);
  }

  /** @type {Array<bigint|string>} */
  const prerelease = [];
  if (dash !== -1) {
    if (!preRaw) throw new Error(`invalid semantic version: ${version}`);
    for (const id of preRaw.split('.')) {
      if (!id || !IDENTIFIER.test(id)) throw new Error(`invalid semantic version: ${version}`);
      if (/^\d+$/.test(id)) {
        if (!NUMERIC_NO_LEADING_ZERO.test(id)) throw new Error(`invalid semantic version: ${version}`);
        prerelease.push(BigInt(id));
      } else {
        prerelease.push(id);
      }
    }
  }

  if (plus !== -1) {
    if (!build) throw new Error(`invalid semantic version: ${version}`);
    for (const id of build.split('.')) {
      if (!id || !IDENTIFIER.test(id)) throw new Error(`invalid semantic version: ${version}`);
    }
  }

  return {
    major: BigInt(maj),
    minor: BigInt(min),
    patch: BigInt(pat),
    prerelease,
    build
  };
}

/**
 * SemVer 2.0 precedence compare. Returns -1 / 0 / 1. Build metadata is ignored.
 *
 * @param {string|SemVer} left
 * @param {string|SemVer} right
 * @returns {-1|0|1}
 */
export function compareSemver(left, right) {
  const a = typeof left === 'string' ? parseSemver(left) : left;
  const b = typeof right === 'string' ? parseSemver(right) : right;

  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= a.prerelease.length) return -1;
    if (i >= b.prerelease.length) return 1;
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (typeof x === 'bigint' && typeof y === 'bigint') {
      if (x === y) continue;
      return x < y ? -1 : 1;
    }
    if (typeof x === 'bigint') return -1;
    if (typeof y === 'bigint') return 1;
    if (x === y) continue;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * True when candidate is the same precedence or newer than current (may advance alias).
 *
 * @param {string} current
 * @param {string} candidate
 * @returns {boolean}
 */
export function aliasCanAdvance(current, candidate) {
  return compareSemver(candidate, current) >= 0;
}

/**
 * @param {{ ref: string, refName: string, packageVersion: string }} input
 * @returns {{ release_kind: 'immutable' | 'alias', npm_publish: 'true' | 'false' }}
 */
export function classifyRelease({ ref, refName, packageVersion }) {
  const [major, minor, patch] = String(packageVersion).split('.');
  const accepted = `expected v${packageVersion}, v${major}.${minor} when patch is zero, or v${major}`;
  if (!ref?.startsWith('refs/tags/v')) {
    throw new Error(`Release workflow must run from an accepted immutable tag; got ${ref}; ${accepted}`);
  }
  const tagVersion = String(refName ?? '').startsWith('v') ? String(refName).slice(1) : '';
  if (tagVersion === packageVersion || (patch === '0' && tagVersion === `${major}.${minor}`)) {
    return { release_kind: 'immutable', npm_publish: 'true' };
  }
  if (tagVersion === major) {
    return { release_kind: 'alias', npm_publish: 'false' };
  }
  throw new Error(`Release workflow must run from an accepted immutable tag; got ${refName}; ${accepted}`);
}

function writeOutput(key, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(output, `${key}=${value}\n`);
}

function runClassify() {
  const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const ref = process.env.GITHUB_REF ?? '';
  const refName = process.env.GITHUB_REF_NAME ?? '';
  const result = classifyRelease({ ref, refName, packageVersion });
  writeOutput('release_kind', result.release_kind);
  writeOutput('npm_publish', result.npm_publish);
  if (result.release_kind === 'alias') {
    console.log(`::notice::Rolling alias ${refName} accepted; no package, release, or monitor work will run.`);
  }
}

function runAliasCanAdvance() {
  const current = process.argv[3];
  const candidate = process.argv[4];
  if (current === undefined || candidate === undefined || process.argv.length !== 5) {
    console.error('::error::usage: classify-release.mjs alias-can-advance <current> <candidate>');
    process.exit(1);
  }
  try {
    process.exit(aliasCanAdvance(current, candidate) ? 0 : 3);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exit(1);
  }
}

function main() {
  if (process.argv[2] === 'alias-can-advance') {
    runAliasCanAdvance();
    return;
  }
  runClassify();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exit(1);
  }
}
