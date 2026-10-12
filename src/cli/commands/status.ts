import type { Command } from 'commander';
import { openRepo } from '../../git/exec.js';
import { changedFiles } from '../../git/status.js';
import { aheadBehind, currentBranch } from '../../git/branch.js';
import { ui } from '../ui/output.js';
import { renderStatus } from '../interactive/render.js';
import { allFlags } from './flow.js';

export async function runStatus(cmd: Command): Promise<void> {
  const f = allFlags(cmd);
  const git = await openRepo(f.cwd ?? process.cwd());
  const files = await changedFiles(git);
  const branch = await currentBranch(git);
  const ab = await aheadBehind(git);
  if (f.json) {
    ui.data(JSON.stringify({ repository: git.name, root: git.root, branch, upstream: ab.upstream ?? null, ahead: ab.ahead, behind: ab.behind, files }, null, 2));
    return;
  }
  renderStatus(files, branch, ab.upstream ? `${ab.upstream}  ahead ${ab.ahead} behind ${ab.behind}` : undefined);
}
