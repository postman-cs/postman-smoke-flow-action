export type PmakDiagnosticKind = 'personal' | 'service-account' | 'invalid' | 'inconclusive';
export type PmakDiagnosticResult = {
  kind: PmakDiagnosticKind;
  status?: number;
  payload?: Record<string, unknown>;
};

export interface InspectPmakIdentityOptions {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  mode?: 'diagnostic' | 'preflight';
}

const memo = new Map<string, Promise<PmakDiagnosticResult>>();

function normalizedBase(apiBaseUrl: string): string {
  return new URL(apiBaseUrl.trim()).toString().replace(/\/+$/, '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function maskPmakDiagnostic(message: string, secrets: readonly (string | undefined)[]): string {
  let masked = String(message);
  for (const secret of secrets) {
    if (secret) masked = masked.split(secret).join('***');
  }
  // eslint-disable-next-line no-control-regex -- errors must not retain control bytes.
  return masked.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function inspectPmakIdentity(options: InspectPmakIdentityOptions): Promise<PmakDiagnosticResult> {
  const base = normalizedBase(options.apiBaseUrl);
  const key = `${base}\u0000${options.apiKey}`;
  let pending = memo.get(key);
  if (!pending) {
    pending = inspect(base, options);
    memo.set(key, pending);
    if (options.mode === 'preflight') {
      void pending.then((result) => {
        if (result.kind === 'inconclusive') memo.delete(key);
      });
    }
  }
  return pending;
}

async function inspect(base: string, options: InspectPmakIdentityOptions): Promise<PmakDiagnosticResult> {
  const timeout = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? 2000));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await (options.fetchImpl ?? fetch)(`${base}/me`, {
      method: 'GET', headers: { 'x-api-key': options.apiKey }, signal
    });
    if (response.status === 401 || response.status === 403) return { kind: 'invalid', status: response.status };
    if (!response.ok) return { kind: 'inconclusive', status: response.status };
    const payload = asRecord(await response.json().catch(() => undefined));
    const user = asRecord(payload?.user);
    if (!user) return { kind: 'inconclusive', status: response.status };
    const username = user.username;
    const email = user.email;
    if ((typeof username === 'string' && username.trim()) || (typeof email === 'string' && email.trim())) {
      return { kind: 'personal', status: response.status, payload };
    }
    if ((username === null || username === '') && (email === null || email === '')) {
      return { kind: 'service-account', status: response.status, payload };
    }
    return { kind: 'inconclusive', status: response.status };
  } catch {
    return { kind: 'inconclusive' };
  }
}

export function formatRejectedMint(originalMintError: string, result: PmakDiagnosticResult): string {
  switch (result.kind) {
    case 'personal':
      return 'Personal API key detected, cannot mint a service-account access token. Create a service-account PMAK or pass a pre-minted postman-access-token.';
    case 'service-account':
      return 'The postman-api-key authenticates (GET /me OK) but was rejected by POST /service-account-tokens and lacks permission to mint access tokens. Check the service account role or pass a pre-minted postman-access-token.';
    case 'invalid':
      return 'The postman-api-key is invalid, disabled, or expired. Generate a fresh service-account PMAK in Team Settings and update the secret.';
    default:
      return originalMintError;
  }
}

export function __resetPmakDiagnosticMemo(): void {
  memo.clear();
}
