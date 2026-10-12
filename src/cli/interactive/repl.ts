import { createInterface } from 'node:readline';
import { Agent } from '../../agent/agent.js';
import { plan, SLASH_HELP, type RegenModifiers } from '../../agent/planner.js';
import { rebuildProvider, type Session } from '../../agent/session.js';
import { listProviderEntries } from '../../providers/registry.js';
import { changedFiles } from '../../git/status.js';
import { aheadBehind, currentBranch } from '../../git/branch.js';
import { log } from '../../git/history.js';
import { stagedDiff, unstagedDiff } from '../../git/diff.js';
import { rememberModel, switchProvider } from '../../config/global.js';
import { CancelledError } from '../../utils/errors.js';
import { ui } from '../ui/output.js';
import { Spinner } from '../ui/spinner.js';
import { cancelOnEsc } from '../ui/keys.js';
import { pickOne } from '../ui/prompts.js';
import { changeModel, confirmCommandFactory, pushWithApproval, runCommitFlow } from './commit-flow.js';
import { ensureReady } from './ready.js';
import { printDiffColored, renderStatus } from './render.js';
import { runUndo } from '../commands/undo.js';
import type { MessageState } from '../../commit/generate.js';
import { OllamaProvider } from '../../providers/ollama.js';

/** One short-lived readline per prompt: it never fights with raw key capture or spinners. undefined = Ctrl+C / Ctrl+D. */
function readLine(prompt: string, history: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, history: [...history], historySize: 100, terminal: true });
    let done = false;
    const finish = (v: string | undefined): void => {
      if (done) return;
      done = true;
      rl.close();
      resolve(v);
    };
    rl.once('SIGINT', () => finish(undefined));
    rl.once('close', () => finish(undefined));
    rl.question(prompt, (answer) => finish(answer));
  });
}

async function header(s: Session): Promise<void> {
  const t = ui.theme;
  const git = s.git as NonNullable<Session['git']>;
  ui.write('');
  ui.box([
    `${t.accentBold('AIC')}  ${t.g.bullet}  AI Coding Agent`,
    t.mute(`${s.provider.name} ${t.g.bullet} ${s.model}`),
  ]);
  ui.write('');
  ui.kv([
    ['Repository', git.name],
    ['Branch', t.scope(await currentBranch(git))],
    ['Provider', s.provider.name + (s.provider.local ? t.mute('  local only: nothing leaves your machine') : t.warn('  cloud: repository context is sent to ' + s.provider.endpoint))],
  ]);
  ui.write('');
  ui.dim('Ask in plain English or use /help. Esc cancels a running request, Ctrl+C leaves.');
}

function printHelp(): void {
  const t = ui.theme;
  ui.write('');
  for (const [cmd, desc] of SLASH_HELP) ui.write('  ' + t.accent(cmd.padEnd(20)) + t.mute(desc));
  ui.write('');
  ui.dim('Natural language works too: "commit my changes", "explain what changed", "use a shorter commit message", "show me the diff".');
}

function applyModifiers(s: Session, m: RegenModifiers, state: MessageState): () => void {
  const saved = { ...s.settings };
  if (m.shorter) s.settings = { ...s.settings, bullets: 0 };
  if (m.longer) s.settings = { ...s.settings, bullets: Math.max(3, s.settings.bullets) };
  if (m.emoji) s.settings = { ...s.settings, emoji: true };
  if (m.language) s.settings = { ...s.settings, language: m.language };
  if (m.type) state.type = m.type;
  if (m.scope) { state.scope = m.scope; state.noScope = false; }
  if (m.noScope) { state.noScope = true; state.scope = undefined; }
  if (m.breaking) state.breaking = true;
  if (m.hint) state.hint = m.hint;
  return () => { s.settings = saved; };
}

export async function runRepl(s: Session, opts: { startOllama?: boolean | undefined } = {}): Promise<void> {
  const git = s.git as NonNullable<Session['git']>;
  const t = ui.theme;
  await ensureReady(s, { startOllama: opts.startOllama });
  await header(s);

  const agent = new Agent({ session: s, confirm: (cmd) => confirmCommandFactory(s)(cmd) });
  let pending: MessageState | undefined;
  const hist: string[] = [];

  const prompt = `\n${t.bold('You')} ${t.accent(t.g.prompt)} `;
  try {
    while (true) {
      const typed = await readLine(prompt, hist);
      if (typed === undefined) { ui.write(''); break; } // Ctrl+C / Ctrl+D at the prompt
      const line = typed.trim();
      if (!line) continue;
      hist.unshift(line);
      const { intent, steps } = plan(line, { hasPending: pending !== undefined });
      try {
        switch (intent.kind) {
          case 'exit': return;
          case 'help': printHelp(); break;
          case 'clear': agent.clear(); process.stderr.write('\u001bc'); await header(s); break;
          case 'status': {
            const ab = await aheadBehind(git);
            renderStatus(await changedFiles(git), await currentBranch(git), ab.upstream ? `${ab.upstream}  ahead ${ab.ahead} behind ${ab.behind}` : undefined);
            break;
          }
          case 'diff': {
            const d = intent.staged ? await stagedDiff(git, { exclude: s.settings.exclude }, 3) : await unstagedDiff(git, { exclude: s.settings.exclude }, 3);
            if (d) printDiffColored(d); else ui.dim(intent.staged ? 'nothing staged' : 'no unstaged changes');
            break;
          }
          case 'history': {
            const commits = await log(git, intent.count);
            ui.write('');
            for (const c of commits) ui.write(`  ${t.accent(c.hash)}  ${c.subject}  ${t.mute(`${c.author ?? ''} ${c.date ?? ''}`)}`);
            break;
          }
          case 'commit': case 'generate': case 'regenerate': {
            const state: MessageState = intent.kind === 'regenerate' && pending ? pending : { regen: 0 };
            if (intent.kind === 'regenerate' && pending) state.regen++;
            const restore = applyModifiers(s, intent.kind === 'commit' ? {} : intent.modifiers, state);
            try {
              if (intent.kind !== 'commit' && intent.modifiers.pickModel) await changeModel(s);
                const r = await runCommitFlow(s, { mode: intent.kind === 'commit' ? 'commit' : 'generate', all: intent.kind === 'commit' ? intent.all : false, push: intent.kind === 'commit' ? intent.push : false, state, skipReady: true });
              pending = r.committed ? undefined : r.state;
              if (r.cancelled) ui.dim('cancelled');
              } finally {
              restore();
            }
            break;
          }
          case 'push': {
            const ab = await aheadBehind(git);
            if (ab.upstream && ab.ahead === 0) { ui.info('Nothing to push: the branch is up to date.'); break; }
            await pushWithApproval(s, false);
            break;
          }
          case 'undo': await runUndo(s); break;
          case 'model': {
            if (intent.arg) { s.model = intent.arg; rememberModel(s.provider.id, intent.arg); ui.ok(`model → ${s.model}`); }
            else { await changeModel(s); rememberModel(s.provider.id, s.model); ui.ok(`model → ${s.model}`); }
            break;
          }
          case 'provider': {
            const entries = listProviderEntries({ settings: s.settings, global: s.resolved.global }, s.model);
            const id = intent.arg ?? (await pickOne('Pick a provider', entries.map((e) => ({ name: `${e.ready ? t.g.ok : t.g.hollow} ${e.name}${e.active ? '  (current)' : ''}`, value: e.id })), s.provider.id));
            if (id !== s.provider.id) {
              rebuildProvider(s, id);
              switchProvider(id);
              await ensureReady(s, { startOllama: opts.startOllama });
              ui.ok(`provider → ${s.provider.name} · ${s.model}`);
            }
            break;
          }
          case 'config': {
            ui.write('');
            ui.kv([
              ['provider', s.provider.id], ['model', s.model], ['language', s.settings.language], ['bullets', String(s.settings.bullets)],
              ['emoji', String(s.settings.emoji)], ['secretScan', String(s.settings.secretScan)], ['maxChars', String(s.settings.maxChars)],
            ]);
            ui.dim('Edit with `aic config`.');
            break;
          }
          case 'explain': case 'chat': {
            const text = intent.kind === 'explain'
              ? 'Explain what changed in my working tree. Group the changes by area in short bullets, mention anything risky or incomplete, and suggest a sensible commit split if the changes are unrelated.'
              : line;
            await streamAnswer(s, agent, text, intent.kind === 'explain' ? steps : []);
            break;
          }
        }
      } catch (e) {
        if (e instanceof CancelledError) { ui.dim('cancelled'); continue; }
        ui.error(e);
      }
    }
  } finally {
    if (s.provider instanceof OllamaProvider && s.settings.unloadModel) await s.provider.unloadUsedModels();
  }
}

async function streamAnswer(s: Session, agent: Agent, text: string, steps: string[]): Promise<void> {
  const t = ui.theme;
  const sp = new Spinner('Analyzing repository').start();
  sp.update({ cancelHint: true });
  const ctl = new AbortController();
  const stopWatch = cancelOnEsc(ctl);
  let started = false;
  let stoppedSpinner = false;
  const begin = (): void => {
    if (!stoppedSpinner) { sp.stop(); stoppedSpinner = true; }
    if (!started) { started = true; ui.write(''); process.stderr.write('  ' + t.accentBold('AIC') + ':\n  '); }
  };
  try {
    await agent.ask(text, {
      onText: (chunk) => { begin(); process.stderr.write(chunk.replace(/\n/g, '\n  ')); },
      onThinking: () => sp.update({ label: 'thinking' }),
      onToolStart: (call, cmd) => { sp.stop(); stoppedSpinner = true; ui.dim(`${t.g.arrow} ${call.name}: ${cmd}`); },
      onToolEnd: (call, r) => { if (!r.ok) ui.warn(`${call.name}: ${r.output.split('\n')[0]}`); sp.start(); stoppedSpinner = false; sp.update({ label: 'working' }); },
    }, ctl.signal, (info) => {
      sp.stop(); stoppedSpinner = true;
      ui.write('');
      for (const st of steps) ui.step(st);
      if (info.truncated.length) ui.dim(`context shortened to fit the limit: ${info.truncated.join(', ')}`);
      if (info.dropped.length) ui.dim(`context left out: ${info.dropped.join(', ')}`);
      if (info.redactions) ui.dim(`${info.redactions} secret-like value(s) redacted before sending`);
      sp.start(); stoppedSpinner = false; sp.update({ label: 'thinking', cancelHint: true });
    });
    if (!stoppedSpinner) sp.stop();
    process.stderr.write('\n');
  } finally {
    stopWatch();
    sp.stop();
  }
}
