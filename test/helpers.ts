import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BaseProvider } from '../src/providers/base.js';
import type { GenerateRequest, ModelInfo, StreamChunk } from '../src/providers/types.js';

export interface Recorded { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
export type Handler = (req: Recorded, res: http.ServerResponse) => void;

/** Tiny HTTP server for provider tests: no network, no API keys. */
export async function startServer(handler: Handler): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const rec = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      requests.push(rec);
      handler(rec, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

export function sse(res: http.ServerResponse, events: Array<{ event?: string; data: unknown }>, done = false): void {
  res.setHeader('content-type', 'text/event-stream');
  for (const e of events) res.write(`${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
  if (done) res.write('data: [DONE]\n\n');
  res.end();
}

export function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export interface TempRepo { dir: string; git: (...args: string[]) => string; write: (rel: string, content: string) => void; cleanup: () => void }

export function tempRepo(): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'aic-test-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  return {
    dir, git,
    write: (rel, content) => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Provider that replays scripted answers: used to test generation without any model. */
export class FakeProvider extends BaseProvider {
  readonly id = 'fake';
  readonly name = 'Fake';
  readonly local = true;
  readonly endpoint = 'memory://fake';
  calls: GenerateRequest[] = [];
  constructor(private replies: string[]) { super(); }
  listModels(): Promise<ModelInfo[]> { return Promise.resolve([{ id: 'fake-model' }]); }
  async *stream(req: GenerateRequest): AsyncGenerator<StreamChunk> {
    this.calls.push(req);
    const reply = this.replies.length > 1 ? (this.replies.shift() as string) : (this.replies[0] ?? '');
    for (const part of reply.match(/[\s\S]{1,5}/g) ?? []) yield { type: 'text', text: part };
    yield { type: 'done' };
  }
}

/** Await a promise that must reject and return the error (typed), failing the test otherwise. */
export async function rejection<E = Error>(p: Promise<unknown>): Promise<E> {
  try {
    await p;
  } catch (e) {
    return e as E;
  }
  throw new Error('expected the promise to reject');
}
