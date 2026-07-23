import { describe, expect, it, vi } from 'vitest';

import { PostmanAppVersionProvider, __resetPostmanAppVersionMemo } from '../src/lib/postman/app-version.js';

describe('PostmanAppVersionProvider', () => {
  it('memoizes one valid update lookup for concurrent callers', async () => {
    __resetPostmanAppVersionMemo();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: '12.21.1-rc1' })));
    const provider = new PostmanAppVersionProvider({ fetchImpl: fetchImpl as typeof fetch });

    await expect(Promise.all([provider.resolve(), provider.resolve()])).resolves.toEqual([
      '12.21.1-rc1',
      '12.21.1-rc1'
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
