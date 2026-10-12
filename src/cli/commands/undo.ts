import type { Session } from '../../agent/session.js';
import { checkUndo, softUndo } from '../../git/commit.js';
import { lastCommit } from '../../git/history.js';
import { ui } from '../ui/output.js';
import { yesNo } from '../ui/prompts.js';
import { AicError, ExitCode, GitError } from '../../utils/errors.js';

/**
 * Soft-undo the last commit (HEAD~1, everything stays staged). Nothing is lost.
 * `--yes` skips the question, except when the commit is already on the remote: that always needs a human.
 */
export async function runUndo(s: Session): Promise<boolean> {
  const git = s.git;
  if (!git) throw new GitError('Not inside a Git repository');
  const check = await checkUndo(git);
  if (!check.ok) throw new AicError(check.reason ?? 'Nothing to undo', ExitCode.GIT);
  const last = await lastCommit(git);
  ui.blank();
  ui.info(`${ui.theme.accent('last commit ' + (last?.hash ?? ''))}  ${last?.subject ?? ''}`);
  if (check.published) ui.warn('It is already on the remote: undoing it locally means force-pushing later.');
  const needsHuman = check.published;
  if (!s.yes || needsHuman) {
    if (!s.interactive) {
      throw new AicError(needsHuman ? 'This commit is already pushed; undoing it needs confirmation' : 'Undo needs confirmation', ExitCode.CANCELLED, {
        try: needsHuman ? ['Run `aic undo` in a terminal'] : ['aic undo --yes'],
      });
    }
    ui.write('');
    ui.write('  ' + ui.theme.bold('AIC wants to run:'));
    ui.write('');
    ui.write('    ' + ui.theme.accent('git reset --soft HEAD~1'));
    ui.write('');
    if (!(await yesNo('Undo it? Your changes stay staged.', false))) { ui.dim('cancelled'); return false; }
  }
  await softUndo(git);
  ui.ok('undone. Changes are staged, run aic again.');
  return true;
}
