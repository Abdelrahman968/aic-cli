import { parseAddedLines } from '../git/diff.js';

export interface Finding {
  file: string;
  /** 1-based line in the new file; undefined for whole-file findings */
  line?: number;
  /** human readable type, e.g. "AWS access key id" */
  type: string;
  /** NOTE: the matched text is deliberately never stored, so findings can be printed and logged safely */
  kind: 'file' | 'content' | 'entropy';
}

interface Rule {
  type: string;
  rx: RegExp;
  /** skip matches that look like placeholders ("your-api-key", "changeme", ...) */
  placeholderCheck?: boolean;
}

const RULES: Rule[] = [
  { type: 'AWS access key id', rx: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: 'private key block', rx: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY/ },
  { type: 'GitHub token', rx: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/ },
  { type: 'Slack token', rx: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { type: 'Stripe live key', rx: /\b[sr]k_live_[0-9A-Za-z]{20,}/ },
  { type: 'Google API key', rx: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { type: 'OpenAI API key', rx: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { type: 'Anthropic API key', rx: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { type: 'npm token', rx: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { type: 'JWT', rx: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { type: 'database URL with password', rx: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s:/@'"]+:[^\s@/'"]{3,}@/, placeholderCheck: true },
  { type: 'hard-coded secret', rx: /(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i, placeholderCheck: true },
];

const PLACEHOLDER = /example|your[-_ ]|xxxx|placeholder|changeme|dummy|<.+>|\$\{|process\.env|os\.environ|:(password|pass|secret|root|admin|postgres)@/i;
const TEMPLATE_FILE = /\.(example|sample|template|dist)$/i;
const ENV_FILE = /(^|\/)\.env(\.[^/]+)?$/;
const KEY_FILE = /\.(pem|p12|pfx|jks|keystore)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$|service[-_]?account[^/]*\.json$/i;
const NOISE_FILE = /\.(lock|svg|map|min\.js|min\.css|snap|png|jpe?g|gif|ico|woff2?|pdf)$/i;
const SECRET_WORD = /(key|token|secret|passw|auth|cred|bearer|signature|salt)/i;

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Candidate high-entropy tokens on one line. Conservative on purpose: false alarms train people to ignore the scanner. */
export function highEntropyToken(line: string): boolean {
  if (/sha(1|256|384|512)-|integrity|data:[a-z]+\/[a-z0-9.+-]+;base64|https?:\/\/\S{30,}/i.test(line)) return false;
  const withName = SECRET_WORD.test(line);
  for (const m of line.matchAll(/[A-Za-z0-9+/_=-]{24,}/g)) {
    const tok = m[0];
    if (/^[0-9a-f]+$/i.test(tok) && tok.length <= 64) continue;     // hex digests / commit ids
    if (/^[A-Za-z]+$/.test(tok) || /^[0-9]+$/.test(tok)) continue;  // plain words / numbers
    if (/[/_-]/.test(tok) && /^[a-z0-9/_.-]+$/.test(tok)) continue; // paths / kebab-case identifiers
    if (!(/[A-Z]/.test(tok) && /[a-z]/.test(tok) && /[0-9]/.test(tok))) continue;
    const e = shannonEntropy(tok);
    if (withName ? e >= 4.2 : tok.length >= 32 && e >= 4.7) return true;
  }
  return false;
}

export function scanPaths(paths: string[]): Finding[] {
  const out: Finding[] = [];
  for (const p of paths) {
    if (ENV_FILE.test(p) && !TEMPLATE_FILE.test(p)) out.push({ file: p, type: 'environment file (usually holds secrets)', kind: 'file' });
    else if (KEY_FILE.test(p)) out.push({ file: p, type: 'key / credential file', kind: 'file' });
  }
  return out;
}

const MAX_LINE = 4000;

export function scanDiff(diff: string): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const add = (f: Finding): void => {
    const k = `${f.file}:${f.line ?? ''}:${f.type}`;
    if (!seen.has(k)) { seen.add(k); out.push(f); }
  };
  for (const a of parseAddedLines(diff)) {
    if (TEMPLATE_FILE.test(a.file)) continue;       // templates hold placeholders by design
    const text = a.text.length > MAX_LINE ? a.text.slice(0, MAX_LINE) : a.text;
    let matched = false;
    for (const r of RULES) {
      const m = r.rx.exec(text);
      if (!m) continue;
      if (r.placeholderCheck && PLACEHOLDER.test(m[0])) continue;
      add({ file: a.file, line: a.line, type: r.type, kind: 'content' });
      matched = true;
    }
    if (!matched && !NOISE_FILE.test(a.file) && highEntropyToken(text)) {
      add({ file: a.file, line: a.line, type: 'high-entropy string (possible credential)', kind: 'entropy' });
    }
  }
  return out;
}

/** Scan staged paths and the added lines of the staged diff. Everything stays local. */
export function scanStaged(paths: string[], diff: string): Finding[] {
  const pathFindings = scanPaths(paths);
  const flaggedFiles = new Set(pathFindings.map((f) => f.file));
  const content = scanDiff(diff.length > 3 * 1024 * 1024 ? diff.slice(0, 3 * 1024 * 1024) : diff).filter((f) => !flaggedFiles.has(f.file));
  return [...pathFindings, ...content];
}

/** Paths whose content must never be read by tools or sent to a provider. */
export function isSensitivePath(path: string): boolean {
  if (ENV_FILE.test(path) && !TEMPLATE_FILE.test(path)) return true;
  if (KEY_FILE.test(path)) return true;
  return /(^|\/)(\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials|\.aws\/|\.ssh\/)|\.kdbx$/i.test(path);
}

/** Replace anything that matches a secret rule with [REDACTED] (used before text leaves the machine). */
export function redactContent(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const r of RULES) {
    const rx = new RegExp(r.rx.source, r.rx.flags.includes('g') ? r.rx.flags : r.rx.flags + 'g');
    out = out.replace(rx, (m) => {
      if (r.placeholderCheck && PLACEHOLDER.test(m)) return m;
      count++;
      return '[REDACTED]';
    });
  }
  return { text: out, count };
}
