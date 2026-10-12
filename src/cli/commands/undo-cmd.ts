import type { Command } from 'commander';
import { createSession } from '../../agent/session.js';
import { CancelledError } from '../../utils/errors.js';
import { flagsToLayer } from '../options.js';
import { runUndo } from './undo.js';
import { allFlags } from './flow.js';

export async function runUndoCommand(cmd: Command): Promise<void> {
  const f = allFlags(cmd);
  const s = await createSession({ cli: flagsToLayer(f), yes: f.yes, requireRepo: true, lenient: true });
  if (!(await runUndo(s))) throw new CancelledError();
}
