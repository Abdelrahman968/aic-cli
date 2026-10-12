/** Process exit codes. Documented in docs/commands.md. */
export const ExitCode = {
  OK: 0,
  GENERAL: 1,
  USAGE: 2,
  PROVIDER: 3,
  GIT: 4,
  SECRET: 5,
  CANCELLED: 6,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface ErrorExtras {
  /** Extra detail line(s) shown under the headline. */
  details?: string;
  /** "Possible causes" bullets. */
  causes?: string[];
  /** Commands the user can run next. */
  try?: string[];
  cause?: unknown;
}

export class AicError extends Error {
  readonly code: ExitCodeValue;
  readonly extras: ErrorExtras;
  constructor(message: string, code: ExitCodeValue = ExitCode.GENERAL, extras: ErrorExtras = {}) {
    super(message, extras.cause !== undefined ? { cause: extras.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.extras = extras;
  }
}

export class UsageError extends AicError {
  constructor(message: string, extras: ErrorExtras = {}) {
    super(message, ExitCode.USAGE, extras);
  }
}
export class ProviderError extends AicError {
  constructor(message: string, extras: ErrorExtras = {}) {
    super(message, ExitCode.PROVIDER, extras);
  }
}
export class GitError extends AicError {
  constructor(message: string, extras: ErrorExtras = {}) {
    super(message, ExitCode.GIT, extras);
  }
}
export class SecretError extends AicError {
  constructor(message: string, extras: ErrorExtras = {}) {
    super(message, ExitCode.SECRET, extras);
  }
}
export class CancelledError extends AicError {
  constructor(message = 'Cancelled') {
    super(message, ExitCode.CANCELLED);
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
}

/** Inquirer throws ExitPromptError on Ctrl+C. */
export function isPromptExit(e: unknown): boolean {
  return e instanceof Error && (e.name === 'ExitPromptError' || e.name === 'AbortPromptError');
}

export function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
