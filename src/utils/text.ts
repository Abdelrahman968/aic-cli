/** Rough token estimate. Code averages ~2.8 chars/token; good enough for budgeting. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 2.8);
}

export function truncate(text: string, max: number, suffix = '…'): string {
  if (max <= 0) return '';
  return text.length <= max ? text : text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** Visible width, ignoring ANSI sequences. Wide CJK/emoji glyphs count as 2 columns. */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff))) w += 2;
    else if (cp >= 0x300 && cp <= 0x36f) w += 0;
    else w += 1;
  }
  return w;
}

export function pad(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });
}
