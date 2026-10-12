import { detectCapabilities, Theme, type UiOptions } from './theme.js';

const PLAIN_THEME = new Theme({ tty: false, color: false, anim: false, unicode: false, keys: false });
import { AicError, ExitCode } from '../../utils/errors.js';
import { pad, visibleWidth } from '../../utils/text.js';
import { redactSecrets } from '../../utils/redact.js';

/**
 * All decorative output goes to **stderr**. stdout is reserved for data
 * (`--pass-thru`, `config list`, `--json`, ...) so AIC is safe to use in pipes and scripts.
 */
export class Ui {
  theme: Theme;
  quiet: boolean;
  verbose: boolean;
  private secrets: string[] = [];

  constructor(opts: UiOptions = {}) {
    this.theme = new Theme(detectCapabilities(opts));
    this.quiet = opts.quiet ?? false;
    this.verbose = opts.verbose ?? false;
  }

  configure(opts: UiOptions): void {
    this.theme = new Theme(detectCapabilities(opts));
    this.quiet = opts.quiet ?? false;
    this.verbose = opts.verbose ?? false;
  }

  /** Register values that must never be printed (API keys). */
  protect(...secrets: Array<string | undefined>): void {
    for (const s of secrets) if (s && s.length >= 6 && !this.secrets.includes(s)) this.secrets.push(s);
  }

  get width(): number {
    const w = process.stderr.columns ?? 100;
    return Math.max(40, Math.min(100, w));
  }

  write(s = ''): void {
    process.stderr.write(redactSecrets(s, this.secrets) + '\n');
  }
  raw(s: string): void {
    process.stderr.write(s);
  }
  /** Theme for text written to stdout: no colours when stdout is a pipe or file. */
  get out(): Theme {
    return process.stdout.isTTY ? this.theme : PLAIN_THEME;
  }
  /** data output on stdout */
  data(s: string): void {
    process.stdout.write(s.endsWith('\n') ? s : s + '\n');
  }

  blank(): void { if (!this.quiet) this.write(''); }
  info(s: string): void { if (!this.quiet) this.write('  ' + s); }
  dim(s: string): void { if (!this.quiet) this.write('  ' + this.theme.mute(s)); }
  debug(s: string): void { if (this.verbose) this.write('  ' + this.theme.mute(`[debug] ${s}`)); }
  ok(s: string): void { this.write('  ' + this.theme.ok(`${this.theme.g.ok} ${s}`)); }
  warn(s: string): void { this.write('  ' + this.theme.warn(`${this.theme.g.warn} ${s}`)); }
  step(s: string): void { if (!this.quiet) this.write('  ' + this.theme.ok(this.theme.g.ok) + ' ' + s); }

  heading(s: string): void {
    this.write('');
    this.write('  ' + this.theme.bold(s));
    this.write('');
  }

  /** key: value rows with aligned keys */
  kv(rows: Array<[string, string]>, indent = 2): void {
    const w = Math.max(...rows.map(([k]) => visibleWidth(k)), 0);
    for (const [k, v] of rows) this.write(' '.repeat(indent) + this.theme.mute(pad(k, w)) + '  ' + v);
  }

  table(head: string[], rows: string[][]): void {
    const widths = head.map((h, i) => Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i] ?? ''))));
    this.write('  ' + head.map((h, i) => this.theme.mute(pad(h, widths[i] as number))).join('  '));
    for (const r of rows) this.write('  ' + r.map((c, i) => pad(c, widths[i] as number)).join('  '));
  }

  /** Rounded header box with a fixed set of lines. */
  box(lines: string[]): void {
    const g = this.theme.g;
    const inner = Math.max(...lines.map((l) => visibleWidth(l)), 20) + 2;
    this.write(this.theme.mute(g.tl + g.h.repeat(inner) + g.tr));
    for (const l of lines) this.write(this.theme.mute(g.v) + ' ' + pad(l, inner - 1) + this.theme.mute(g.v));
    this.write(this.theme.mute(g.bl + g.h.repeat(inner) + g.br));
  }

  /** "Left rail" card: no right border, so nothing misaligns with wide glyphs or RTL text. */
  card(title: string, lines: string[], opts: { tag?: string; footer?: string } = {}): void {
    const g = this.theme.g;
    const fill = Math.max(2, this.width - 8 - visibleWidth(title) - (opts.tag ? visibleWidth(opts.tag) + 1 : 0));
    this.write('  ' + this.theme.mute(g.tl + g.h) + ' ' + this.theme.bold(title) + ' ' + this.theme.mute(g.h.repeat(fill)) + (opts.tag ? ' ' + opts.tag : ''));
    for (const l of lines) this.write('  ' + this.theme.mute(g.v) + ' ' + l);
    this.write('  ' + this.theme.mute(g.bl + (opts.footer ? ' ' + opts.footer : g.h)));
  }

  /** Render an error the way users should see it (what happened, why, what to try). Never prints secrets. */
  error(e: unknown): void {
    const t = this.theme;
    if (e instanceof AicError) {
      this.write('');
      this.write('  ' + t.errBold(`${t.g.bad} ${e.message}`));
      const x = e.extras;
      if (x.details) {
        this.write('');
        for (const l of x.details.split('\n')) this.write('    ' + t.mute(l));
      }
      if (x.causes?.length) {
        this.write('');
        this.write('    ' + t.bold('Possible causes:'));
        for (const c of x.causes) this.write('      ' + t.g.bullet + ' ' + c);
      }
      if (x.try?.length) {
        this.write('');
        this.write('    ' + t.bold('Try:'));
        for (const c of x.try) this.write('      ' + t.accent(c));
      }
      if (this.verbose && e.cause) this.write('\n    ' + t.mute(String((e.cause as Error)?.stack ?? e.cause)));
      return;
    }
    this.write('');
    this.write('  ' + t.errBold(`${t.g.bad} ${e instanceof Error ? e.message : String(e)}`));
    if (this.verbose && e instanceof Error && e.stack) this.write('\n' + t.mute(e.stack.split('\n').slice(1, 8).join('\n')));
    else this.write('    ' + t.mute('Run with --verbose for details, or `aic doctor` to check your setup.'));
  }

  /** Exit code for an error */
  codeFor(e: unknown): number {
    return e instanceof AicError ? e.code : ExitCode.GENERAL;
  }
}

export const ui = new Ui();
