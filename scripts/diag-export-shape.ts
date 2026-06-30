/** Dump the RAW v3 export leaf shape of a spec-generated collection so we can see
 * exactly where url/method live (string vs object, root vs nested). Run-scoped.
 *
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" npx tsx scripts/diag-export-shape.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';
import { PostmanGatewaySmokeClient } from '../src/postman/postman-gateway-smoke-client.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type J = Record<string, unknown>;

function bareModelId(uid: string): string {
  const u = String(uid ?? '').trim();
  return u.includes('-') ? u.slice(u.indexOf('-') + 1) : u;
}

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
    const ws = await raw.requestJson<J>({ service: 'workspaces', method: 'post', path: '/workspaces', body: { name: `gw-exp-${stamp}`, visibilityStatus: 'personal' } });
    const workspaceId = String((ws?.data as J)?.id ?? '').trim();
    created.add(workspaceId);
    const specContent = [
      'openapi: 3.0.3',
      'info: { title: Exp API, version: 1.0.0 }',
      'servers: [{ url: https://postman-echo.com }]',
      'paths:',
      '  /technician-appointments:',
      '    post:',
      '      operationId: scheduleTechnicianAppointment',
      '      summary: Schedule a technician appointment',
      '      responses: { "200": { description: OK } }'
    ].join('\n');
    const spec = await raw.requestJson<J>({ service: 'specification', method: 'post', path: `/specifications?containerType=workspace&containerId=${workspaceId}`, body: { name: 'Exp API', type: 'OPENAPI:3.0', files: [{ path: 'i.yaml', content: specContent, type: 'ROOT' }] } });
    const specId = String((spec?.data as J)?.id ?? '').trim();

    const uid = await client.generateCollection(specId, 'Exp', '[Smoke]');
    const cid = bareModelId(uid);
    console.log(`generated uid=${uid} cid=${cid}`);

    const exported = await raw.requestJson<J>({ service: 'collection', method: 'get', path: `/v3/collections/${cid}/export` });
    const v3 = (exported?.data as J)?.collection ?? exported?.data;
    console.log('=== RAW v3 export (full) ===');
    console.log(JSON.stringify(v3, null, 2));

    console.log('\n=== adapted v2 (what resolver sees) ===');
    const v2 = await client.getCollection(uid);
    console.log(JSON.stringify(v2, null, 2));
  } finally {
    for (const ws of created) {
      if (!ws) continue;
      await raw.request({ service: 'workspaces', method: 'delete', path: `/workspaces/${ws}` }).catch(() => undefined);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
