import { ProviderError, isAbortError, type ErrorExtras } from '../utils/errors.js';
import { redactSecrets } from '../utils/redact.js';

export interface RequestContext {
  /** Display name, e.g. "OpenAI" */
  name: string;
  /** Base URL used for error messages */
  baseUrl: string;
  /** Secrets to scrub from any error text */
  secrets: string[];
  /** Extra "Try:" lines for connection failures */
  connectionHelp?: ErrorExtras;
  /** Hint shown for 401/403 */
  authHelp?: string[];
}

export interface TimedSignal {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

/** Combine a timeout with an optional caller signal (AbortSignal.any is not available on Node 18). */
export function timedSignal(timeoutMs: number | undefined, outer?: AbortSignal): TimedSignal {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => { timedOut = true; ctl.abort(new DOMException('Request timed out', 'TimeoutError')); }, timeoutMs)
    : undefined;
  const onAbort = (): void => ctl.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) ctl.abort(outer.reason);
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    dispose: () => { if (timer) clearTimeout(timer); outer?.removeEventListener('abort', onAbort); },
  };
}

export function extractErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    const err = j['error'];
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>)['message'];
      if (typeof m === 'string') return m;
    }
    if (typeof j['message'] === 'string') return j['message'];
    if (Array.isArray(j) && j[0] && typeof j[0] === 'object') return extractErrorMessage(JSON.stringify(j[0]));
  } catch { /* not JSON */ }
  return trimmed.slice(0, 300);
}

export function httpError(ctx: RequestContext, status: number, body: string): ProviderError {
  const raw = redactSecrets(extractErrorMessage(body), ctx.secrets);
  const detail = raw ? raw : undefined;
  if (status === 401 || status === 403) {
    return new ProviderError(`${ctx.name} rejected the credentials (HTTP ${status})`, {
      ...(detail ? { details: detail } : {}),
      causes: ['The API key is missing, wrong or expired', 'The key does not have access to this model'],
      ...(ctx.authHelp ? { try: ctx.authHelp } : {}),
    });
  }
  if (status === 404) {
    return new ProviderError(`${ctx.name} returned 404 (not found)`, {
      ...(detail ? { details: detail } : {}),
      causes: ['The model name is wrong or not available to your account', `The base URL is wrong: ${ctx.baseUrl}`],
      try: ['aic model list', 'aic provider test'],
    });
  }
  if (status === 429) {
    return new ProviderError(`${ctx.name} rate limit or quota reached (HTTP 429)`, {
      ...(detail ? { details: detail } : {}),
      causes: ['Too many requests', 'Quota or billing limit reached'],
      try: ['Wait a moment and retry', 'aic provider use <other-provider>'],
    });
  }
  if (status >= 500) {
    return new ProviderError(`${ctx.name} had a server error (HTTP ${status})`, { ...(detail ? { details: detail } : {}), causes: ['The provider is overloaded or down'], try: ['Retry in a moment'] });
  }
  return new ProviderError(`${ctx.name} returned HTTP ${status}`, detail ? { details: detail } : {});
}

export function connectionError(ctx: RequestContext, cause: unknown): ProviderError {
  const base = ctx.connectionHelp ?? {};
  const msg = cause instanceof Error ? redactSecrets(cause.message, ctx.secrets) : String(cause);
  const code = (cause as { cause?: { code?: string } } | undefined)?.cause?.code;
  return new ProviderError(`Unable to connect to ${ctx.name}`, {
    details: `URL: ${ctx.baseUrl}\n${code ? code + ': ' : ''}${msg}`,
    causes: base.causes ?? ['The server is not reachable', 'The configured URL is incorrect', 'Firewall, proxy or network issue'],
    ...(base.try ? { try: base.try } : {}),
    cause,
  });
}

/** fetch() with uniform error mapping. The caller owns the TimedSignal. */
export async function providerFetch(ctx: RequestContext, url: string, init: RequestInit, sig: TimedSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: sig.signal });
  } catch (e) {
    if (isAbortError(e) || sig.signal.aborted) {
      if (sig.timedOut()) throw new ProviderError(`${ctx.name} did not answer in time`, { causes: ['The model is still loading', 'The timeout is too short'], try: ['aic config set timeoutSec 300'] });
      throw e;
    }
    throw connectionError(ctx, e);
  }
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    throw httpError(ctx, res.status, body);
  }
  return res;
}

/** Split a streaming body into text lines. */
export async function* readLines(res: Response, sig?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      if (sig?.aborted) throw sig.reason ?? new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        yield buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
      }
    }
    buf += dec.decode();
    if (buf) yield buf.replace(/\r$/, '');
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

export interface SseEvent {
  event: string | undefined;
  data: string;
}

/** Parse a Server-Sent-Events body. Multi-line `data:` fields are joined with \n. */
export async function* readSse(res: Response, sig?: AbortSignal): AsyncGenerator<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  for await (const line of readLines(res, sig)) {
    if (line === '') {
      if (data.length) yield { event, data: data.join('\n') };
      event = undefined;
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length) yield { event, data: data.join('\n') };
}

export function tryJson(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
