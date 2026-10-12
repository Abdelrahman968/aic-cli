import { checkbox, confirm, input, password, select } from '@inquirer/prompts';
import { CancelledError, isPromptExit } from '../../utils/errors.js';

/** Prompts render on stderr so stdout stays clean for scripts. */
const context = { output: process.stderr };

async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (isPromptExit(e)) throw new CancelledError();
    throw e;
  }
}

export interface Choice<T> {
  name: string;
  value: T;
  description?: string;
}

export function pickOne<T>(message: string, choices: Array<Choice<T>>, defaultValue?: T): Promise<T> {
  return guard(select({ message, choices, ...(defaultValue !== undefined ? { default: defaultValue } : {}), pageSize: 12 }, context));
}

export function pickMany<T>(message: string, choices: Array<Choice<T> & { checked?: boolean }>): Promise<T[]> {
  return guard(checkbox({ message, choices, pageSize: 14, loop: false }, context));
}

export function ask(message: string, defaultValue?: string): Promise<string> {
  return guard(input({ message, ...(defaultValue !== undefined ? { default: defaultValue } : {}) }, context));
}

export function yesNo(message: string, defaultYes = false): Promise<boolean> {
  return guard(confirm({ message, default: defaultYes }, context));
}

/** Hidden input (API keys). Nothing is echoed. */
export function askSecret(message: string): Promise<string> {
  return guard(password({ message, mask: '*' }, context));
}
