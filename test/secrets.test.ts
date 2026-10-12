import { describe, expect, it } from 'vitest';
import { highEntropyToken, isSensitivePath, redactContent, scanDiff, scanPaths, scanStaged, shannonEntropy } from '../src/security/secret-scanner.js';
import { withholdSensitive } from '../src/agent/context.js';

/** Secrets are assembled at runtime so this file never trips a scanner (including AIC's own). */
const AWS = 'AK' + 'IA' + 'IOSFODNN7EXAMPLQ';
const GH = 'gh' + 'p_' + 'a'.repeat(36);
const STRIPE = 'sk' + '_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
const OPENAI = 'sk' + '-proj-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';
const ANTHROPIC = 'sk' + '-ant-' + 'api03-Abcdef123456GHijkl7890';
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.');
const PEM = '-----BEGIN RSA ' + 'PRIVATE KEY-----';

const diffOf = (file: string, ...lines: string[]): string =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,1 +1,${lines.length} @@`, ...lines.map((l) => '+' + l), ''].join('\n');

describe('content rules', () => {
  const cases: Array<[string, string, string]> = [
    ['AWS access key id', `const k = "${AWS}";`, 'a.ts'],
    ['GitHub token', `token: ${GH}`, 'a.yml'],
    ['Stripe live key', `key = ${STRIPE}`, 'a.ts'],
    ['OpenAI API key', `OPENAI=${OPENAI}`, 'a.sh'],
    ['Anthropic API key', `k=${ANTHROPIC}`, 'a.sh'],
    ['JWT', `Authorization: Bearer ${JWT}`, 'a.http'],
    ['private key block', PEM, 'a.txt'],
    ['database URL with password', 'url = "postgres://admin:s3cr3tpass@db.internal:5432/app"', 'a.ts'],
    ['hard-coded secret', 'const password = "hunter2hunter2hunter2";', 'a.ts'],
  ];
  for (const [type, line, file] of cases) {
    it(`detects ${type}`, () => {
      const f = scanDiff(diffOf(file, 'harmless', line));
      expect(f.map((x) => x.type)).toContain(type);
      expect(f[0]).toMatchObject({ file, line: 2 });
    });
  }
  it('never stores the matched value in a finding', () => {
    const f = scanDiff(diffOf('a.ts', `const k = "${AWS}";`, `x = ${GH}`));
    const text = JSON.stringify(f);
    expect(text).not.toContain(AWS);
    expect(text).not.toContain(GH);
    expect(Object.keys(f[0]!).sort()).toEqual(['file', 'kind', 'line', 'type']);
  });
  it('ignores placeholders, env lookups and template files', () => {
    expect(scanDiff(diffOf('a.ts', 'const password = "your-password-here-please";', 'const secret = process.env.SECRET_VALUE_XYZ;', 'url = "postgres://user:password@localhost/db"'))).toEqual([]);
    expect(scanDiff(diffOf('.env.example', `KEY=${AWS}`))).toEqual([]);
  });
  it('only looks at added lines', () => {
    const d = ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,1 +1,1 @@', `-const k = "${AWS}";`, '+const k = load();', ''].join('\n');
    expect(scanDiff(d)).toEqual([]);
  });
  it('reports the correct line number after context lines', () => {
    const d = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -10,2 +40,3 @@', ' ctx', ' ctx', `+const k = "${AWS}";`, ''].join('\n');
    expect(scanDiff(d)[0]?.line).toBe(42);
  });
});

describe('file rules', () => {
  it('flags .env and key files but not templates', () => {
    const f = scanPaths(['.env', 'config/.env.production', '.env.example', 'id_rsa', 'certs/server.pem', 'service-account-prod.json', 'src/app.ts']);
    expect(f.map((x) => x.file)).toEqual(['.env', 'config/.env.production', 'id_rsa', 'certs/server.pem', 'service-account-prod.json']);
    expect(f.every((x) => x.kind === 'file')).toBe(true);
  });
  it('does not double-report a flagged file', () => {
    const f = scanStaged(['.env'], diffOf('.env', `AWS=${AWS}`));
    expect(f).toHaveLength(1);
    expect(f[0]?.kind).toBe('file');
  });
});

describe('entropy rule', () => {
  it('computes Shannon entropy', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
  });
  it('flags random-looking tokens near secret words', () => {
    expect(highEntropyToken('auth_token = "q8Zr3Kx9Lm2Vb7Nc4Td6Yh1Wp5Js0Fg"')).toBe(true);
  });
  it('does not flag hashes, paths, identifiers, integrity fields or plain words', () => {
    expect(highEntropyToken('commit 3f786850e387550fdab836ed7e6dc881de23001b')).toBe(false);
    expect(highEntropyToken('import x from "../../shared/components/authentication-provider"')).toBe(false);
    expect(highEntropyToken('const someVeryLongCamelCaseIdentifierName = 1')).toBe(false);
    expect(highEntropyToken('"integrity": "sha512-q8Zr3Kx9Lm2Vb7Nc4Td6Yh1Wp5Js0FgABCD=="')).toBe(false);
    expect(highEntropyToken('<img src="data:image/png;base64,q8Zr3Kx9Lm2Vb7Nc4Td6Yh1Wp5Js0Fg">')).toBe(false);
  });
  it('is reported as its own kind and skipped in lockfiles', () => {
    expect(scanDiff(diffOf('a.ts', 'signature = q8Zr3Kx9Lm2Vb7Nc4Td6Yh1Wp5Js0Fg'))[0]?.kind).toBe('entropy');
    expect(scanDiff(diffOf('yarn.lock', 'signature = q8Zr3Kx9Lm2Vb7Nc4Td6Yh1Wp5Js0Fg'))).toEqual([]);
  });
});

describe('redaction before data leaves the machine', () => {
  it('replaces secrets with [REDACTED] and counts them', () => {
    const r = redactContent(`a ${AWS} b\nc ${GH}\nd ${PEM}`);
    expect(r.text).not.toContain(AWS);
    expect(r.text).not.toContain(GH);
    expect(r.text).toContain('[REDACTED]');
    expect(r.count).toBe(3);
  });
  it('leaves normal code alone', () => {
    const code = 'export function add(a: number, b: number) { return a + b; }';
    expect(redactContent(code)).toEqual({ text: code, count: 0 });
  });
  it('withholds credentials files entirely', () => {
    const d = diffOf('.env', 'SOME=value') + diffOf('src/a.ts', 'const x = 1;');
    const r = withholdSensitive(d);
    expect(r.files).toEqual(['.env']);
    expect(r.text).not.toContain('SOME=value');
    expect(r.text).toContain('const x = 1;');
  });
  it('recognizes sensitive paths for the read tools', () => {
    for (const p of ['.env', '.env.local', 'deploy/id_rsa', '.npmrc', 'home/.ssh/config', 'x.pem']) expect(isSensitivePath(p)).toBe(true);
    for (const p of ['.env.example', 'src/env.ts', 'README.md']) expect(isSensitivePath(p)).toBe(false);
  });
});
