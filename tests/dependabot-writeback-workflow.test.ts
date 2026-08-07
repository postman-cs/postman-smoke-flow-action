import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const wf = readFileSync('.github/workflows/dependabot-dist-writeback.yml','utf8');
describe('dependabot-writeback-workflow',()=>{
  it('contains workflow_run trigger',()=>{ expect(wf).toContain('workflow_run'); expect(wf).toMatch(/workflows:\s*\["CI"\]/); expect(wf).toContain('workflow_dispatch'); });
  it('no pull_request_target or npm',()=>{ expect(wf).not.toContain('pull_request_target'); expect(wf).not.toMatch(/run:\s*npm /); expect(wf).not.toContain('node scripts/verify-dist'); });
  it('pins checkout and download-artifact SHAs',()=>{ expect(wf).toMatch(/actions\/checkout@[0-9a-f]{40}/); expect(wf).toMatch(/actions\/download-artifact@[0-9a-f]{40}/); });
  it('permission boundaries',()=>{ expect(wf).toMatch(/permissions:\s*\n\s*contents: read/); expect(wf).toContain('contents: write'); expect(wf).toContain('pull-requests: write'); expect(wf).toContain('actions: read'); });
  it('checks author branch PR state allowlist digest git data api',()=>{
    expect(wf).toContain('dependabot[bot]'); expect(wf).toContain('dependabot/npm_and_yarn/'); expect(wf).toContain('/git/blobs'); expect(wf).toContain('/git/trees'); expect(wf).toContain('/git/commits'); expect(wf).toContain('/git/refs/heads'); expect(wf).not.toMatch(/git commit/); expect(wf).not.toMatch(/\bgit push\b/);
  });
});
