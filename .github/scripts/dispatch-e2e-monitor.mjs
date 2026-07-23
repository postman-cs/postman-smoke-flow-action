import { pathToFileURL } from 'node:url';

export const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

const DEFAULT_E2E_REPOSITORY = 'postman-cs/postman-actions-e2e';
const DEFAULT_E2E_WORKFLOW = 'e2e.yml';
const GITHUB_API_VERSION = '2026-03-10';
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function buildDispatchInputs({ action, refName, suite }) {
  if (suite !== 'smoke' && suite !== 'full') throw new Error(`E2E_GATE_SUITE must be smoke or full; got ${suite}`);
  return { action, ref: refName, suite };
}

export function buildDispatchUrl(targetRepository, workflow) {
  const parts = String(targetRepository).split('/');
  if (parts.length !== 2 || !PATH_SEGMENT.test(parts[0]) || !PATH_SEGMENT.test(parts[1])) {
    throw new Error(`E2E_GATE_REPOSITORY must be owner/repo; got ${targetRepository}`);
  }
  if (!PATH_SEGMENT.test(String(workflow))) {
    throw new Error(`E2E_GATE_WORKFLOW must be a single path segment; got ${workflow}`);
  }
  const [owner, repo] = parts;
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
}

export function formatDispatchFailureWarning(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (!secret) continue;
    message = message.split(secret).join('[redacted]');
  }
  return `::warning::${message}`;
}

export function reportDispatchFailure(
  error,
  { env = globalThis.process.env, log = globalThis.console.log.bind(globalThis.console) } = {}
) {
  log(formatDispatchFailureWarning(error, [env.E2E_DISPATCH_TOKEN]));
}

export async function dispatchE2eMonitor({
  env = globalThis.process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS,
  log = globalThis.console.log.bind(globalThis.console)
} = {}) {
  const token = env.E2E_DISPATCH_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  const refName = env.E2E_GATE_REF ?? env.GITHUB_REF_NAME;
  if (!token || !repository || !refName) {
    throw new Error('E2E_DISPATCH_TOKEN, GITHUB_REPOSITORY, and GITHUB_REF_NAME are required');
  }
  const suite = env.E2E_GATE_SUITE ?? 'smoke';
  const target = env.E2E_GATE_REPOSITORY ?? DEFAULT_E2E_REPOSITORY;
  const workflow = env.E2E_GATE_WORKFLOW ?? DEFAULT_E2E_WORKFLOW;
  const inputs = buildDispatchInputs({
    action: repository.split('/').at(-1),
    refName,
    suite
  });
  const url = buildDispatchUrl(target, workflow);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    },
    body: JSON.stringify({ ref: 'main', inputs }),
    signal: globalThis.AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`E2E monitor dispatch failed with HTTP ${response.status}`);
  log(`::notice::Dispatched asynchronous ${suite} E2E monitor for ${refName}`);
}

async function main() {
  await dispatchE2eMonitor();
}

if (globalThis.process.argv[1] && import.meta.url === pathToFileURL(globalThis.process.argv[1]).href) {
  main().catch((error) => {
    reportDispatchFailure(error);
    globalThis.process.exit(1);
  });
}
