import { HttpError } from '../http-error.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';
import type { SecretMasker } from '../secrets.js';
import { createSecretMasker } from '../secrets.js';
import type { AccessTokenProvider } from './token-provider.js';
import { fullJitterDelayMs, parseRetryAfterMs } from '../retry.js';
import { getPostmanAppVersionProvider, type PostmanAppVersionProvider } from './app-version.js';

export type GatewayMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface GatewayRequest {
  service: string;
  method: GatewayMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Extra route-specific headers (e.g. x-app-version, X-Entity-Type). */
  headers?: Record<string, string>;
  /**
   * Per-request override for transient retries. Safe GETs use the client
   * default. Mutations default to zero and may opt in only when the caller has
   * proved the operation idempotent.
   */
  maxRetries?: number;
}

export interface AccessTokenGatewayClientOptions {
  tokenProvider: AccessTokenProvider;
  bifrostBaseUrl?: string;
  teamId?: string;
  orgMode?: boolean;
  fetchImpl?: typeof fetch;
  secretMasker?: SecretMasker;
  /** Max transient (5xx / network) retries per request (default 3). */
  maxRetries?: number;
  /** Base backoff in ms; attempt n waits baseDelayMs * 2^(n-1) (default 400). */
  retryBaseDelayMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
  appVersionProvider?: PostmanAppVersionProvider;
}

function isExpiredAuthError(status: number, body: string): boolean {
  return (
    status === 401 ||
    body.includes('UNAUTHENTICATED') ||
    body.includes('authenticationError')
  );
}

/**
 * Transient downstream failures the gateway surfaces intermittently (Bifrost
 * proxy read timeouts, gateway 5xx). Safe reads may retry these with backoff.
 * Unsafe create POSTs must set `maxRetries: 0` and reconcile after ambiguity —
 * a 503 can still mean the server durably accepted the create.
 */
function isTransientGatewayError(status: number, body: string): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504 ||
    (status >= 500 && /ESOCKETTIMEDOUT|ETIMEDOUT|ECONNRESET|serverError|downstream/i.test(body));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractInnerStatus(body: string): number | undefined {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    const error = payload.error;
    const source = error && typeof error === 'object' ? error as Record<string, unknown> : payload;
    const raw = source.status ?? source.statusCode ?? payload.status ?? payload.statusCode;
    const status = typeof raw === 'number' ? raw : Number(raw);
    if (source.success === false || payload.success === false) return Number.isFinite(status) ? status : 500;
    if (Number.isFinite(status) && status >= 400) return status;
    // A proxy can return an HTTP 200 envelope containing only an `error` object.
    // Treat it as an inner 5xx so safe callers use the normal retry policy rather
    // than accepting a failed operation as a successful response.
    if (error !== undefined) {
      return /UNAUTHENTICATED|authenticationError/i.test(body) ? 401 : 500;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Generic access-token gateway client.
 *
 * Sends the app's `POST {bifrost}/ws/proxy` envelope
 * (`{ service, method, path, query?, body? }`) authenticated with
 * `x-access-token` read live from the {@link AccessTokenProvider} (so a
 * re-minted token propagates without reconstruction), plus `x-entity-team-id`
 * only in org-mode. This is the single place token refresh is wired: a 401 /
 * UNAUTHENTICATED / authenticationError triggers one single-flight re-mint and
 * one retry; a second failure surfaces an HttpError with secrets redacted.
 */
export class AccessTokenGatewayClient {
  private readonly tokenProvider: AccessTokenProvider;
  private readonly bifrostBaseUrl: string;
  private teamId: string;
  private orgMode: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly secretMasker: SecretMasker;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly randomImpl: () => number;
  private readonly appVersionProvider: PostmanAppVersionProvider;

  constructor(options: AccessTokenGatewayClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.bifrostBaseUrl = String(
      options.bifrostBaseUrl || POSTMAN_ENDPOINT_PROFILES.prod.bifrostBaseUrl
    ).replace(/\/+$/, '');
    this.teamId = String(options.teamId || '').trim();
    this.orgMode = options.orgMode ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.secretMasker =
      options.secretMasker ?? createSecretMasker([this.tokenProvider.current()]);
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 400;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.randomImpl = options.randomImpl ?? Math.random;
    this.appVersionProvider = options.appVersionProvider ?? getPostmanAppVersionProvider();
  }

  configureTeamContext(teamId: string, orgMode: boolean): void {
    this.teamId = String(teamId || '').trim();
    this.orgMode = orgMode;
  }

  private async buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(extra || {})
    };
    headers['x-access-token'] = this.tokenProvider.current();
    const appVersion = await this.appVersionProvider.resolve();
    if (appVersion) headers['x-app-version'] = appVersion;
    if (this.teamId && this.orgMode) {
      headers['x-entity-team-id'] = this.teamId;
    }
    return headers;
  }

  private async send(request: GatewayRequest): Promise<Response> {
    const url = `${this.bifrostBaseUrl}/ws/proxy`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      return await this.fetchImpl(url, {
      method: 'POST',
      headers: await this.buildHeaders(request.headers),
      signal: controller.signal,
      body: JSON.stringify({
        service: request.service,
        method: request.method,
        path: request.path,
        ...(request.query !== undefined ? { query: request.query } : {}),
        ...(request.body !== undefined ? { body: request.body } : {})
      })
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send a gateway request, refreshing the token once after a definitive auth
   * rejection. Safe GETs retry transient/statusless failures with backoff.
   * Mutations are single-shot unless a caller explicitly opts in after proving
   * its fixed-target operation idempotent.
   */
  async request(request: GatewayRequest): Promise<Response> {
    let attempt = 0;
    const maxRetries = request.maxRetries ?? (request.method === 'get' ? this.maxRetries : 0);
    for (;;) {
      let response: Response;
      try {
        response = await this.send(request);
      } catch (error) {
        if (attempt >= maxRetries) throw error;
        const delay = fullJitterDelayMs(attempt, this.retryBaseDelayMs, 5000, this.randomImpl);
        attempt += 1;
        await this.sleepImpl(delay);
        continue;
      }
      const body = await response.clone().text().catch(() => '');
      const innerStatus = response.ok ? extractInnerStatus(body) : undefined;
      const status = innerStatus ?? response.status;
      if (response.ok && innerStatus === undefined) return response;
      if (isExpiredAuthError(status, body) && this.tokenProvider.canRefresh()) {
        await this.tokenProvider.refresh();
        response = await this.send(request);
        const retryBody = await response.clone().text().catch(() => '');
        const retryInnerStatus = response.ok ? extractInnerStatus(retryBody) : undefined;
        if (response.ok && retryInnerStatus === undefined) return response;
        throw this.toHttpError(request, response, retryBody, retryInnerStatus);
      }

      if (isTransientGatewayError(status, body) && attempt < maxRetries) {
        const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
        const delay = retryAfter === undefined
          ? fullJitterDelayMs(attempt, this.retryBaseDelayMs, 5000, this.randomImpl)
          : Math.min(5000, retryAfter);
        attempt += 1;
        await this.sleepImpl(delay);
        continue;
      }

      throw this.toHttpError(request, response, body, innerStatus);
    }
  }

  /** Send a gateway request and parse the JSON body, or null when empty. */
  async requestJson<T = Record<string, unknown>>(
    request: GatewayRequest
  ): Promise<T | null> {
    const response = await this.request(request);
    const text = await response.text().catch(() => '');
    if (!text.trim()) {
      return null;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private toHttpError(
    request: GatewayRequest,
    response: Response,
    body: string,
    effectiveStatus?: number
  ): HttpError {
    return new HttpError({
      method: request.method.toUpperCase(),
      url: `${this.bifrostBaseUrl}/ws/proxy (${request.service}: ${request.method} ${request.path})`,
      status: effectiveStatus ?? response.status,
      statusText: response.statusText,
      requestHeaders: { 'Content-Type': 'application/json', 'x-access-token': this.tokenProvider.current() },
      responseBody: this.secretMasker(body),
      secretValues: [this.tokenProvider.current()]
    });
  }
}
