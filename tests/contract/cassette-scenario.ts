/**
 * The smoke-flow cassette scenario, declared once and consumed twice: the
 * recorder writes `cassettes/<name>.json` from the platform fake, and the replay
 * suite drives the SAME production composition root offline from that committed
 * file with zero live transport.
 *
 * This is the third leg of the shared cassette transport: bootstrap, repo-sync,
 * and smoke-flow all replay through `@postman-cse/automation-core/cassette`, so
 * one wire-contract format covers the whole composite spine.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Cassette } from '@postman-cse/automation-core/cassette';

import type { PlatformOptions } from './platform-fake.js';

const CASSETTE_DIR = resolve(import.meta.dirname, 'cassettes');

export function cassettePath(name: string): string {
  return resolve(CASSETTE_DIR, `${name}.json`);
}

export function readCassette(name: string): Cassette {
  return JSON.parse(readFileSync(cassettePath(name), 'utf8')) as Cassette;
}

/**
 * Constant reads whose call COUNT is not reproducible: they are issued
 * concurrently with other preflight work and in-flight-deduped, so whether a
 * second caller hits the memo or issues its own request depends on interleaving,
 * and replay resolves faster than the fake. Their responses carry no cursor and
 * no state, so repeating them cannot mask a missing interaction.
 *
 * Everything else stays one-shot: mutations, task polls, and any route whose
 * response advances state must fail closed on a duplicated or dropped call.
 */
const REPEATABLE_READ_PREFIXES = [
  'GET https://api.getpostman.com/me',
  'GET https://iapub.postman.co/api/sessions/current'
] as const;

export function isRepeatableRead(key: string): boolean {
  return REPEATABLE_READ_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function applyRepeatableReads(cassette: Cassette): Cassette {
  for (const interaction of cassette.interactions) {
    if (isRepeatableRead(interaction.key)) interaction.repeatLast = true;
  }
  return cassette;
}

/**
 * `recordedAt` is provenance metadata, not wire contract, and the recorder stamps
 * it from the wall clock. Pinning it keeps a re-record with no behavior change a
 * zero-diff operation, and matches the value the live-capture sanitizer emits.
 */
const NORMALIZED_RECORDED_AT = '2000-01-01T00:00:00.000Z';

export function stableCassetteText(cassette: Cassette): string {
  return `${JSON.stringify({ ...cassette, recordedAt: NORMALIZED_RECORDED_AT }, null, 2)}\n`;
}

export interface SmokeFlowCassetteScenario {
  name: string;
  description: string;
  inputs: Record<string, string>;
  fake: PlatformOptions;
  /** Files written into the run cwd (the curated flow manifest). */
  files: Record<string, string>;
  /** Env beyond the neutralization sweep, applied on record AND replay. */
  env: Record<string, string>;
  /** Secret literals that must never survive into the committed cassette. */
  secrets: string[];
}

const ACCESS_TOKEN = 'access-token-test';
const PMAK = 'pmak-test';

/**
 * Deterministic run-identity parts. buildSmokeRunIdentity appends 4 random
 * bytes from node:crypto; the harness pins those via GITHUB_* env plus a
 * stubbed randomBytes seed is NOT possible across module reset, so the
 * temp-collection name embeds a random hex suffix. The fake therefore echoes
 * the REQUESTED name back on generation, and the cassette key for the
 * generation POST pins the request-body digest -- which is why record and
 * replay share the same pinned GITHUB_* env AND the same crypto stub seed
 * inside the recorder/replay tests.
 */
export const CASSETTE_ENV: Record<string, string> = {
  POSTMAN_GATEWAY_APP_VERSION: 'off',
  POSTMAN_GENERATION_POLL_MODE: 'fixed',
  GITHUB_RUN_ID: '1234567',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_JOB: 'cassette'
};

/** Curated two-step flow over the deterministic generated collection. */
const CURATED_FLOW_YAML = `spec:
  fileName: openapi.yaml
  title: Payments API
  version: 1.0.0
flows:
  - name: Payments happy path
    type: smoke
    steps:
      - stepKey: create-payment-1
        operationId: createPayment
        name: Create a payment
        bindings: []
        extract:
          - variable: createPayment.paymentId
            jsonPath: $.id
      - stepKey: get-payment-2
        operationId: getPayment
        name: Read the payment back
        bindings:
          - fieldKey: paymentId
            source: prior_output
            sourceStepKey: create-payment-1
            variable: createPayment.paymentId
        extract: []
`;

/**
 * A curated PMAK-mint run: the PMAK mints the access token, the curated
 * flow.yaml reshapes the canonical Smoke collection through the gateway, and
 * the temporary generated collection is deleted. It covers the surface
 * smoke-flow is uniquely responsible for: specification-service generation +
 * task poll + reconcile, v3 export -> v2 adaptation, per-item reconcile, and
 * the collection-level patch, all access-token-only.
 */
export const SMOKE_FLOW_CASSETTE: SmokeFlowCassetteScenario = {
  name: 'smoke-flow-wire',
  description:
    'Curated flow, PMAK mint: generation, export, item reconcile, and the collection patch all replay from the cassette.',
  inputs: {
    'project-name': 'payments',
    'workspace-id': 'ws-contract',
    'spec-id': 'spec-contract',
    'smoke-collection-id': '12345678-col-smoke',
    'flow-mode': 'curated',
    'flow-path': 'flow.yaml',
    'postman-api-key': PMAK,
    'collection-sync-mode': 'refresh'
  },
  fake: {
    smokeCollectionId: '12345678-col-smoke',
    smokeCollectionName: '[Smoke] payments',
    workspaceId: 'ws-contract',
    specId: 'spec-contract',
    generatedItems: [
      {
        name: 'createPayment',
        method: 'POST',
        url: 'https://api.example.com/payments',
        requestBody: { type: 'json', content: '{"amount":100}' }
      },
      {
        name: 'getPayment',
        method: 'GET',
        url: 'https://api.example.com/payments/{paymentId}'
      }
    ]
  },
  files: { 'flow.yaml': CURATED_FLOW_YAML },
  env: CASSETTE_ENV,
  secrets: [PMAK, ACCESS_TOKEN]
};
