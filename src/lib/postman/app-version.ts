const UPDATE_URL = 'https://dl.pstmn.io/update/status?currentVersion=12.0.0&platform=osx_arm64';
const FLOOR_VERSION = '12.0.0';
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface PostmanAppVersionProviderOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export class PostmanAppVersionProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private memo?: Promise<string | undefined>;

  constructor(options: PostmanAppVersionProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 2000);
  }

  resolve(): Promise<string | undefined> {
    if (process.env.POSTMAN_GATEWAY_APP_VERSION === 'off') return Promise.resolve(undefined);
    this.memo ??= this.lookup();
    return this.memo;
  }

  private async lookup(): Promise<string> {
    try {
      const response = await this.fetchImpl(UPDATE_URL, { signal: AbortSignal.timeout(this.requestTimeoutMs) });
      if (!response.ok) return FLOOR_VERSION;
      const body = (await response.json()) as { version?: unknown };
      const version = typeof body?.version === 'string' ? body.version : '';
      // eslint-disable-next-line no-control-regex -- protocol input must reject control bytes.
      return VERSION_RE.test(version) && !/[\u0000-\u001f\u007f-\u009f]/.test(version)
        ? version
        : FLOOR_VERSION;
    } catch {
      return FLOOR_VERSION;
    }
  }
}

let defaultProvider: PostmanAppVersionProvider = new PostmanAppVersionProvider();

export function getPostmanAppVersionProvider(): PostmanAppVersionProvider {
  return defaultProvider;
}

/** Test-only reset for the package singleton. */
export function __resetPostmanAppVersionMemo(): void {
  defaultProvider = new PostmanAppVersionProvider();
}
