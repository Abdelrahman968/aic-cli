import type { Command } from 'commander';
import { SETTINGS, coerceValue, type SettingKey, type SettingsLayer } from '../config/schema.js';
import { UsageError } from '../utils/errors.js';

/** Flags shared by commit / generate / push / chat. */
export interface CommonFlags {
  provider?: string;
  model?: string;
  ollamaUrl?: string;
  yes?: boolean;
  dryRun?: boolean;
  scan?: boolean;
  startOllama?: boolean;
  unload?: boolean;
  verbose?: boolean;
  plain?: boolean;
  color?: boolean;
  anim?: boolean;
  quiet?: boolean;
  cwd?: string;
  // commit-ish
  all?: boolean;
  pick?: boolean;
  amend?: boolean;
  push?: boolean;
  copy?: boolean;
  passThru?: boolean;
  verify?: boolean;
  signoff?: boolean;
  type?: string;
  scope?: string;
  scopes?: string[];
  breaking?: boolean;
  emoji?: boolean;
  hint?: string;
  language?: string;
  bullets?: string;
  history?: string;
  ref?: string;
  exclude?: string[];
  maxChars?: string;
  retries?: string;
  temperature?: string;
  numCtx?: string;
  numPredict?: string;
  timeout?: string;
  keepAlive?: string;
  json?: boolean;
}

function num(key: SettingKey, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return coerceValue(key, raw) as number;
}

/** Translate command-line flags into the CLI layer of the config precedence chain. */
export function flagsToLayer(f: CommonFlags): SettingsLayer {
  const layer: Record<string, unknown> = {};
  const set = (k: SettingKey, v: unknown): void => { if (v !== undefined) layer[k] = v; };
  set('provider', f.provider);
  set('model', f.model);
  set('ollamaUrl', f.ollamaUrl);
  set('language', f.language);
  set('bullets', num('bullets', f.bullets));
  set('history', num('history', f.history));
  set('maxChars', num('maxChars', f.maxChars));
  set('retries', num('retries', f.retries));
  set('temperature', num('temperature', f.temperature));
  set('numCtx', num('numCtx', f.numCtx));
  set('numPredict', num('numPredict', f.numPredict));
  set('timeoutSec', num('timeoutSec', f.timeout));
  set('keepAlive', f.keepAlive);
  if (f.emoji) set('emoji', true);
  if (f.exclude?.length) set('exclude', f.exclude);
  if (f.scopes?.length) set('scopes', f.scopes);
  if (f.scan === false) set('secretScan', false);
  if (f.startOllama) set('autoStartOllama', true);
  if (f.unload) set('unloadModel', true);
  if (f.verify === false) set('noVerify', true);
  if (f.signoff) set('signoff', true);
  return layer as SettingsLayer;
}

export function validateType(type: string | undefined, allowed: string[]): void {
  if (type && !allowed.includes(type)) {
    throw new UsageError(`Invalid commit type "${type}".`, { details: `Allowed: ${allowed.join(', ')}`, try: ['aic config get types'] });
  }
}

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, ...value.split(',').map((s) => s.trim()).filter(Boolean)];
}

/** Options that describe how a commit message is produced (generate / commit / push). */
export function addCommitOptions(cmd: Command): Command {
  return cmd
    .option('-a, --all', 'stage everything first (git add -A)')
    .option('--pick', 'choose the files for this commit from a checklist')
    .option('--amend', 'rewrite the message of the last commit')
    .option('--push', 'push after committing (asks first unless --yes)')
    .option('--copy', 'copy the message to the clipboard, commit nothing')
    .option('--pass-thru', 'print only the final message on stdout (for scripts and hooks)')
    .option('--no-verify', 'skip git hooks')
    .option('--signoff', 'add Signed-off-by')
    .option('-t, --type <type>', 'force the commit type (feat, fix, ...)')
    .option('-s, --scope <scope>', 'force the scope')
    .option('--scopes <list>', 'allowed scopes, comma separated (the model must pick one)', collect)
    .option('--breaking', 'mark as breaking change: type(scope)!:')
    .option('--emoji', 'add a gitmoji after the colon')
    .option('--hint <text>', 'extra context for the model')
    .option('-l, --language <lang>', 'language of subject and bullets')
    .option('--bullets <n>', `max body bullets, 0 = subject only (default ${SETTINGS.bullets.default})`)
    .option('--history <n>', `recent commits shown to the model (default ${SETTINGS.history.default})`)
    .option('--ref <ref>', 'footer reference, e.g. "#42" adds "Refs: #42"')
    .option('-x, --exclude <glob>', 'extra pathspecs hidden from the model (repeatable)', collect)
    .option('--max-chars <n>', `diff size cap (default ${SETTINGS.maxChars.default})`)
    .option('--retries <n>', `automatic retries when the format check fails (default ${SETTINGS.retries.default})`)
    .option('--temperature <n>', `sampling temperature (default ${SETTINGS.temperature.default})`)
    .option('--num-ctx <n>', 'minimum context window')
    .option('--num-predict <n>', 'max tokens in the answer')
    .option('--timeout <seconds>', `request timeout (default ${SETTINGS.timeoutSec.default})`)
    .option('--keep-alive <dur>', 'how long Ollama keeps the model loaded, e.g. 10m')
    .option('--unload', 'unload the Ollama model when finished');
}
