import type { Command } from 'commander';
import { createSession } from '../../agent/session.js';
import { UsageError } from '../../utils/errors.js';
import { flagsToLayer } from '../options.js';
import { runRepl } from '../interactive/repl.js';
import { allFlags } from './flow.js';
import { ui } from '../ui/output.js';

export async function runChat(cmd: Command): Promise<void> {
  const f = allFlags(cmd);
  const s = await createSession({ cli: flagsToLayer(f), yes: f.yes, requireRepo: true });
  if (!s.interactive) {
    throw new UsageError('The interactive agent needs a terminal', { try: ['aic commit --yes', 'aic generate --pass-thru', 'aic help'] });
  }
  for (const w of s.resolved.warnings) ui.warn(w);
  ui.protect(s.apiKey);
  await runRepl(s, { startOllama: f.startOllama });
}
