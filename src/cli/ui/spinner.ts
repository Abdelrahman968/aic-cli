import { ui } from './output.js';
import { visibleWidth } from '../../utils/text.js';

export interface SpinnerState {
  label: string;
  tokens?: number;
  /** live tail of the streamed text */
  tail?: string;
  cancelHint?: boolean;
}

/** Single-line spinner on stderr with elapsed time, token counter and a live tail of the answer. */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private t0 = 0;
  private state: SpinnerState;
  private active = false;

  constructor(label: string) {
    this.state = { label };
  }

  start(): this {
    const th = ui.theme;
    this.t0 = Date.now();
    this.active = true;
    if (!th.caps.anim) {
      if (!ui.quiet) ui.write('  ' + th.mute(`${this.state.label} ...`));
      return this;
    }
    process.stderr.write('\u001b[?25l');
    const restore = (): void => { process.stderr.write('\u001b[?25h'); };
    process.once('exit', restore);
    this.draw();
    this.timer = setInterval(() => this.draw(), 80);
    return this;
  }

  update(p: Partial<SpinnerState>): void {
    this.state = { ...this.state, ...p };
  }

  private draw(): void {
    const th = ui.theme;
    const s = this.state;
    const secs = ((Date.now() - this.t0) / 1000).toFixed(1);
    const meta = ` ${secs}s` + (s.tokens !== undefined ? ` ${th.g.mid} ${s.tokens} tok` : '');
    const keys = s.cancelHint && th.caps.keys ? ` ${th.g.mid} esc to cancel` : '';
    const used = 4 + visibleWidth(s.label) + meta.length + keys.length;
    const room = (process.stderr.columns ?? 100) - used - 6;
    let tail = '';
    if (s.tail && room > 8) {
      const t = s.tail.replace(/\s+/g, ' ');
      tail = '  ' + (t.length > room ? t.slice(t.length - room) : t);
    }
    const f = th.g.spin[this.frame++ % th.g.spin.length] as string;
    process.stderr.write(`\r\u001b[2K  ${th.accent(f)} ${s.label}${th.mute(meta)}${th.dim(keys)}${th.mute(tail)}`);
  }

  /** Stop and clear the line. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    if (ui.theme.caps.anim) process.stderr.write('\r\u001b[2K\u001b[?25h');
  }

  succeed(text: string): void {
    this.stop();
    ui.ok(text);
  }

  fail(text: string): void {
    this.stop();
    ui.write('  ' + ui.theme.err(`${ui.theme.g.bad} ${text}`));
  }
}

/** Run an async task under a spinner. */
export async function withSpinner<T>(label: string, fn: (s: Spinner) => Promise<T>): Promise<T> {
  const s = new Spinner(label).start();
  try {
    return await fn(s);
  } finally {
    s.stop();
  }
}
