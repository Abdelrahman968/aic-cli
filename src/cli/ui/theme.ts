import pc from 'picocolors';

export interface UiOptions {
  /** ASCII only, no colour, no animation */
  plain?: boolean;
  noColor?: boolean;
  noAnim?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

export interface Glyphs {
  ok: string; bad: string; warn: string; dot: string; hollow: string; mid: string; arrow: string; bullet: string;
  tl: string; tr: string; bl: string; br: string; h: string; v: string; spin: string[]; prompt: string;
}

const UNICODE: Glyphs = {
  ok: '✓', bad: '✗', warn: '⚠', dot: '●', hollow: '○', mid: '·', arrow: '→', bullet: '•',
  tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', spin: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], prompt: '›',
};
const ASCII: Glyphs = {
  ok: 'OK', bad: 'x', warn: '!', dot: '*', hollow: 'o', mid: '-', arrow: '->', bullet: '*',
  tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', spin: ['|', '/', '-', '\\'], prompt: '>',
};

export interface Capabilities {
  tty: boolean;
  color: boolean;
  anim: boolean;
  unicode: boolean;
  /** stdin is a TTY: single-key prompts are possible */
  keys: boolean;
}

export function detectCapabilities(o: UiOptions = {}, env: NodeJS.ProcessEnv = process.env, streams: { err?: NodeJS.WriteStream; in?: NodeJS.ReadStream } = {}): Capabilities {
  const err = streams.err ?? process.stderr;
  const inp = streams.in ?? process.stdin;
  const tty = Boolean(err.isTTY);
  const dumb = env['TERM'] === 'dumb';
  const modernWindows = process.platform !== 'win32' || Boolean(env['WT_SESSION'] || env['TERM_PROGRAM'] || env['ConEmuANSI'] === 'ON' || env['TERM']);
  const fancy = tty && !dumb && !o.plain;
  return {
    tty,
    color: fancy && !o.noColor && !('NO_COLOR' in env) && env['FORCE_COLOR'] !== '0',
    anim: fancy && !o.noAnim && !env['CI'],
    unicode: fancy && modernWindows && !env['AIC_ASCII'],
    keys: Boolean(inp.isTTY) && tty,
  };
}

export class Theme {
  readonly caps: Capabilities;
  readonly g: Glyphs;
  private readonly c: ReturnType<typeof pc.createColors>;

  constructor(caps: Capabilities) {
    this.caps = caps;
    this.g = caps.unicode ? UNICODE : ASCII;
    this.c = pc.createColors(caps.color);
  }

  bold = (s: string): string => this.c.bold(s);
  dim = (s: string): string => this.c.dim(s);
  accent = (s: string): string => this.c.cyan(s);
  accentBold = (s: string): string => this.c.bold(this.c.cyan(s));
  ok = (s: string): string => this.c.green(s);
  warn = (s: string): string => this.c.yellow(s);
  err = (s: string): string => this.c.red(s);
  errBold = (s: string): string => this.c.bold(this.c.red(s));
  mute = (s: string): string => this.c.gray(s);
  scope = (s: string): string => this.c.magenta(s);
  /** inverse-video key cap */
  cap = (s: string): string => (this.caps.color ? this.c.inverse(` ${s} `) : `[${s}]`);

  /** colour a conventional-commit type */
  type(t: string): string {
    switch (t) {
      case 'feat': return this.c.green(t);
      case 'fix': return this.c.red(t);
      case 'refactor': return this.c.magenta(t);
      case 'perf': return this.c.yellow(t);
      case 'docs': return this.c.blue(t);
      case 'test': return this.c.yellow(t);
      case 'revert': return this.c.red(t);
      default: return this.c.cyan(t);
    }
  }
}
