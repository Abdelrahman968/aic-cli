import { CancelledError } from '../../utils/errors.js';

export interface Key {
  /** 'enter' | 'escape' | 'ctrl-c' | 'other' | the character itself */
  name: string;
  char: string;
}

/** Wait for a single key press (raw mode). Falls back to reading one line when stdin is not a TTY. */
export function readKey(): Promise<Key> {
  const stdin = process.stdin;
  return new Promise((resolve) => {
    if (!stdin.isTTY) {
      // piped input: take the first character of the next chunk
      stdin.once('data', (d: Buffer) => resolve(parseKey(d)));
      stdin.once('end', () => resolve({ name: 'escape', char: '' }));
      stdin.resume();
      return;
    }
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', (d: Buffer) => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(parseKey(d));
    });
  });
}

export function parseKey(d: Buffer): Key {
  const s = d.toString('utf8');
  if (s === '\r' || s === '\n' || s === '\r\n') return { name: 'enter', char: '' };
  if (s === '\u001b') return { name: 'escape', char: '' };
  if (s === '\u0003') return { name: 'ctrl-c', char: '' };
  if (s.startsWith('\u001b')) return { name: 'other', char: '' };
  const ch = [...s][0] ?? '';
  return { name: ch.toLowerCase(), char: ch };
}

/**
 * While generating: Esc or Ctrl+C aborts the request instead of killing the process.
 * Returns a function that restores the terminal.
 */
export function cancelOnEsc(controller: AbortController): () => void {
  const stdin = process.stdin;
  const onSigint = (): void => controller.abort(new CancelledError());
  process.on('SIGINT', onSigint);
  if (!stdin.isTTY) return () => { process.off('SIGINT', onSigint); };
  const wasRaw = stdin.isRaw;
  const onData = (d: Buffer): void => {
    const k = parseKey(d);
    if (k.name === 'escape' || k.name === 'ctrl-c') controller.abort(new CancelledError());
  };
  stdin.setRawMode(true);
  stdin.on('data', onData);
  stdin.resume();
  return () => {
    stdin.off('data', onData);
    process.off('SIGINT', onSigint);
    try { stdin.setRawMode(wasRaw); } catch { /* terminal gone */ }
    stdin.pause();
  };
}
