/** Live proof of the wired PostmanGatewaySmokeClient (access-token-only smoke
 * reshape). Exercises the real client methods — generate, getCollection (v3
 * export -> v2 adapter), updateCollection (full-replace reconcile), CLI run,
 * deleteCollection — against the disposable sandbox. PMAK is used ONLY to mint
 * the access token (AccessTokenProvider) and to drive the Postman CLI run.
 *
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" npx tsx scripts/diag-gateway-smoke-client.ts
 */
import { execFileSync } from 'node:child_process';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';
import { PostmanGatewaySmokeClient } from '../src/postman/postman-gateway-smoke-client.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type J = Record<string, unknown>;

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) { console.log('[skip] no api key'); return; }
  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const raw = new AccessTokenGatewayClient({ tokenProvider: provider });
  const client = new PostmanGatewaySmokeClient({ tokenProvider: provider });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const created = new Set<string>();

  try {
    const ws = await raw.requestJson<J>({ service: 'workspaces', method: 'post', path: '/workspaces', body: { name: `gw-smoke-${stamp}`, visibilityStatus: 'personal' } });
    const workspaceId = String((ws?.data as J)?.id ?? '').trim();
    created.add(workspaceId);
    const specContent = [
      'openapi: 3.0.3',
      'info: { title: GW Smoke API, version: 1.0.0 }',
      'servers: [{ url: https://postman-echo.com }]',
      'paths:',
      '  /get:     { get: { operationId: echoGet, summary: Echo Get, responses: { "200": { description: OK } } } }',
      '  /headers: { get: { operationId: echoHdr, summary: Echo Hdr, responses: { "200": { description: OK } } } }'
    ].join('\n');
    const spec = await raw.requestJson<J>({ service: 'specification', method: 'post', path: `/specifications?containerType=workspace&containerId=${workspaceId}`, body: { name: 'GW Smoke API', type: 'OPENAPI:3.0', files: [{ path: 'i.yaml', content: specContent, type: 'ROOT' }] } });
    const specId = String((spec?.data as J)?.id ?? '').trim();

    // 1. generate via the client
    const uid = await client.generateCollection(specId, 'GW Smoke', '[Smoke]');
    console.log(`[1] generateCollection -> ${uid}`);

    // 2. getCollection -> v2 shape
    const v2 = await client.getCollection(uid);
    const leaves = (Array.isArray(v2.item) ? (v2.item as J[]) : []).flatMap(function walk(i: J): J[] {
      return i.request ? [i] : (Array.isArray(i.item) ? (i.item as J[]).flatMap(walk) : []);
    });
    console.log(`[2] getCollection v2 name=${JSON.stringify((v2.info as J)?.name)} leaves=${leaves.map((l) => l.name).join(',')}`);

    // 3. build a curated v2 collection (reorder + per-request scripts + per-request
    //    bearer auth + a POST body + collection-level OAuth pre-request) and reconcile
    const mk = (name: string, method: string, url: string, b: string, a: string, extra: J = {}): J => ({
      name,
      request: { method, url, header: [{ key: 'Accept', value: 'application/json' }], auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }] }, ...extra },
      event: [
        { listen: 'prerequest', script: { exec: [`console.log("${b}");`], type: 'text/javascript' } },
        { listen: 'test', script: { exec: [`pm.test("${a}", function () { pm.response.to.have.status(200); });`], type: 'text/javascript' } }
      ]
    });
    const curated: J = {
      info: { name: '[Smoke] Curated Flow' },
      variable: [{ key: 'access_token', value: '', type: 'string' }],
      event: [{ listen: 'prerequest', script: { exec: ['// OAUTH_PREREQ', 'console.log("oauth-prereq");'], type: 'text/javascript' } }],
      item: [
        mk('Echo Hdr', 'GET', 'https://postman-echo.com/headers', 'BEFORE_HDR', 'AFTER_HDR'),
        mk('Echo Post', 'POST', 'https://postman-echo.com/post', 'BEFORE_POST', 'AFTER_POST', { body: { mode: 'raw', raw: '{"hello":"world"}' } })
      ]
    };
    await client.updateCollection(uid, curated);
    console.log('[3] updateCollection (reconcile) done');

    // 4. readback via client — assert body + per-request auth + collection event round-trip
    const after = await client.getCollection(uid);
    const afterLeaves = (Array.isArray(after.item) ? (after.item as J[]) : []).filter((i) => i.request);
    console.log(`[4] readback name=${JSON.stringify((after.info as J)?.name)} order=${afterLeaves.map((l) => l.name).join(',')}`);
    for (const l of afterLeaves) {
      const rq = l.request as J;
      console.log(`    leaf '${l.name}' method=${rq.method} auth=${JSON.stringify(rq.auth)} body=${JSON.stringify(rq.body)}`);
    }
    console.log(`[4] collection.event=${JSON.stringify(after.event)}`);

    // 5. CLI run -> prove scripts execute
    let runOut = '';
    try {
      runOut = execFileSync('postman', ['collection', 'run', uid, '--postman-api-key', apiKey, '-x'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      runOut = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`;
    }
    const masked = runOut.replace(/PMAK-[A-Za-z0-9-]+/g, 'PMAK-***');
    for (const m of ['BEFORE_HDR', 'AFTER_HDR', 'BEFORE_POST', 'AFTER_POST', 'oauth-prereq']) console.log(`  [exec ${m}] ${new RegExp(m).test(masked)}`);

    // 6. deleteCollection via client
    await client.deleteCollection(uid);
    console.log('[6] deleteCollection done');
  } finally {
    for (const id of created) { const r = await fetch(`${API}/workspaces/${id}`, { method: 'DELETE', headers: { 'X-Api-Key': apiKey } }); console.log(`[teardown] ${id} -> ${r.status}`); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
