import { COMMIT_TYPES } from '../config/schema.js';

export interface RegenModifiers {
  /** subject line only */
  shorter?: boolean;
  longer?: boolean;
  type?: string;
  scope?: string;
  noScope?: boolean;
  emoji?: boolean;
  breaking?: boolean;
  language?: string;
  /** user wants to pick a different model */
  pickModel?: boolean;
  hint?: string;
}

export type Intent =
  | { kind: 'help' }
  | { kind: 'exit' }
  | { kind: 'clear' }
  | { kind: 'status' }
  | { kind: 'diff'; staged: boolean }
  | { kind: 'commit'; push: boolean; all: boolean }
  | { kind: 'generate'; modifiers: RegenModifiers }
  | { kind: 'regenerate'; modifiers: RegenModifiers }
  | { kind: 'split' }
  | { kind: 'push' }
  | { kind: 'undo' }
  | { kind: 'history'; count: number }
  | { kind: 'model'; arg?: string }
  | { kind: 'provider'; arg?: string }
  | { kind: 'config'; arg?: string }
  | { kind: 'explain' }
  | { kind: 'chat' };

export interface PlanResult {
  intent: Intent;
  /** short steps shown while the agent works, e.g. ["Git status", "Diff"] */
  steps: string[];
}

const LANGS: Record<string, string> = {
  arabic: 'Arabic', french: 'French', german: 'German', spanish: 'Spanish', portuguese: 'Portuguese', italian: 'Italian',
  chinese: 'Chinese', japanese: 'Japanese', korean: 'Korean', russian: 'Russian', turkish: 'Turkish', dutch: 'Dutch', english: 'English',
};

/** Pull "make it shorter", "use type fix", "scope auth", "with emoji", "in French" ... out of a sentence. */
export function parseModifiers(text: string): RegenModifiers {
  const t = text.toLowerCase();
  const m: RegenModifiers = {};
  if (/\b(shorter|short|concise|brief|one[- ]?line|subject only|no (body|bullets))\b/.test(t)) m.shorter = true;
  else if (/\b(longer|detailed|more detail|with (a )?body|bullets)\b/.test(t)) m.longer = true;
  const type = /\b(?:type|as(?: a)?|use)\s+(?:a\s+)?(feat|fix|refactor|perf|docs|style|test|build|ci|chore|revert)\b/.exec(t);
  if (type?.[1] && (COMMIT_TYPES as readonly string[]).includes(type[1])) m.type = type[1];
  const scope = /\bscope\s+(?:to\s+|of\s+|is\s+)?[`"']?([a-z0-9._-]+)[`"']?/.exec(t);
  if (scope?.[1] && !['none', 'no'].includes(scope[1])) m.scope = scope[1];
  if (/\b(no|without|drop the) scope\b/.test(t)) m.noScope = true;
  if (/\b(with|add|use) (an? )?(emoji|gitmoji)\b/.test(t)) m.emoji = true;
  if (/\bbreaking\b/.test(t)) m.breaking = true;
  const lang = /\b(?:in|using|to)\s+(arabic|french|german|spanish|portuguese|italian|chinese|japanese|korean|russian|turkish|dutch|english)\b/.exec(t);
  if (lang?.[1]) m.language = LANGS[lang[1]] as string;
  if (/\b(another|different|other|new) model\b/.test(t) || /\busing .*\bmodel\b/.test(t)) m.pickModel = true;
  return m;
}

/**
 * Deterministic intent detection. It handles slash commands and the common natural-language requests
 * without a model round trip (small local models are unreliable at routing). Anything else goes to the LLM.
 */
export function plan(input: string, opts: { hasPending: boolean } = { hasPending: false }): PlanResult {
  const text = input.trim();
  const lower = text.toLowerCase();

  if (text.startsWith('/')) {
    const [cmd = '', ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim() || undefined;
    switch (cmd.toLowerCase()) {
      case 'help': case '?': case 'h': return { intent: { kind: 'help' }, steps: [] };
      case 'exit': case 'quit': case 'q': return { intent: { kind: 'exit' }, steps: [] };
      case 'clear': case 'cls': return { intent: { kind: 'clear' }, steps: [] };
      case 'status': case 'st': return { intent: { kind: 'status' }, steps: ['Git status'] };
      case 'diff': return { intent: { kind: 'diff', staged: arg !== 'unstaged' }, steps: ['Diff'] };
      case 'commit': return { intent: { kind: 'commit', push: /\bpush\b/.test(arg ?? ''), all: /\b(-a|--all|all)\b/.test(arg ?? '') }, steps: ['Git status', 'Staged diff', 'Commit history'] };
      case 'generate': case 'gen': return { intent: { kind: 'generate', modifiers: parseModifiers(arg ?? '') }, steps: ['Git status', 'Staged diff', 'Commit history'] };
      case 'split': return { intent: { kind: 'split' }, steps: ['Git status', 'Diff'] };
      case 'push': return { intent: { kind: 'push' }, steps: ['Git status'] };
      case 'regenerate': case 'regen': case 'r': return { intent: { kind: 'regenerate', modifiers: { ...parseModifiers(arg ?? ''), ...(arg && !Object.keys(parseModifiers(arg)).length ? { hint: arg } : {}) } }, steps: ['Staged diff'] };
      case 'undo': return { intent: { kind: 'undo' }, steps: ['Last commit'] };
      case 'history': case 'log': return { intent: { kind: 'history', count: Math.min(50, Math.max(1, Number(arg) || 10)) }, steps: [] };
      case 'model': case 'models': return { intent: { kind: 'model', ...(arg ? { arg } : {}) }, steps: [] };
      case 'provider': case 'providers': return { intent: { kind: 'provider', ...(arg ? { arg } : {}) }, steps: [] };
      case 'config': case 'settings': return { intent: { kind: 'config', ...(arg ? { arg } : {}) }, steps: [] };
      default: return { intent: { kind: 'help' }, steps: [] };
    }
  }

  const commitWords = /\b(commit|check ?in|save my changes)\b/;
  const asksQuestion = /^(what|why|how|which|who|when|where|can you explain|explain|does|do|is|are)\b|\?$/;

  // modify the pending message: "use a shorter commit message", "regenerate using another model"
  if (/\b(regenerate|re-?generate|try again|retry|redo|another (one|version|message)|different (one|message|version))\b/.test(lower)
    || (opts.hasPending && /\b(shorter|longer|more detail|make it|change (the )?(type|scope)|use (type|scope)|with emoji|in (arabic|french|german|spanish|chinese|japanese))\b/.test(lower))) {
    return { intent: { kind: 'regenerate', modifiers: parseModifiers(text) }, steps: ['Staged diff'] };
  }

  if (/\b(split|break (it |this |my changes )?up|separate|divide|group)\b.*\b(changes?|commits?|work|files)\b/.test(lower) && !asksQuestion.test(lower)) return { intent: { kind: 'split' }, steps: ['Git status', 'Diff'] };

  if (/\bpush\b/.test(lower) && commitWords.test(lower)) return { intent: { kind: 'commit', push: true, all: /\b(all|everything)\b/.test(lower) }, steps: ['Git status', 'Staged diff', 'Commit history'] };
  if (/^(please )?push\b/.test(lower) || /\bpush (it|my|the|this|to)\b/.test(lower)) return { intent: { kind: 'push' }, steps: ['Git status'] };
  if (/\b(undo|revert) (the |my )?(last|previous) commit\b|^undo\b/.test(lower)) return { intent: { kind: 'undo' }, steps: ['Last commit'] };

  if (/\b(generate|write|create|make|suggest|draft|give me|propose)\b.*\b(commit|message)\b/.test(lower) || /^(a )?(conventional )?commit message\b/.test(lower)) {
    return { intent: { kind: 'generate', modifiers: parseModifiers(text) }, steps: ['Git status', 'Staged diff', 'Commit history'] };
  }
  if (/\bconventional commit\b/.test(lower) && !asksQuestion.test(lower)) {
    return { intent: { kind: 'generate', modifiers: parseModifiers(text) }, steps: ['Git status', 'Staged diff', 'Commit history'] };
  }
  if (commitWords.test(lower) && !asksQuestion.test(lower)) {
    return { intent: { kind: 'commit', push: false, all: /\b(all|everything)\b/.test(lower) }, steps: ['Git status', 'Staged diff', 'Commit history'] };
  }

  if (/\b(show|view|see|display|print)\b.*\bdiff\b|^diff$/.test(lower)) return { intent: { kind: 'diff', staged: !/unstaged|working/.test(lower) }, steps: ['Diff'] };
  if (/\b(git )?status\b|what('?s| is) (the )?(state|status)/.test(lower)) return { intent: { kind: 'status' }, steps: ['Git status'] };
  if (/\b(show|list|see)\b.*\b(history|log|commits)\b|^(history|log)$/.test(lower)) return { intent: { kind: 'history', count: 10 }, steps: [] };

  if (/\b(explain|analy[sz]e|summari[sz]e|review|what (changed|did i change)|describe)\b.*\b(chang(?:e|es|ed)|diff|work|code|commit|repo)\b|^(analy[sz]e|explain|summari[sz]e) (my )?changes/.test(lower)) {
    return { intent: { kind: 'explain' }, steps: ['Git status', 'Diff', 'Commit history'] };
  }

  return { intent: { kind: 'chat' }, steps: ['Repository context'] };
}

/** Default help text for slash commands (also shown by /help). */
export const SLASH_HELP: Array<[string, string]> = [
  ['/help', 'Show this help'],
  ['/status', 'Repository status'],
  ['/diff [unstaged]', 'Show the staged (or unstaged) diff'],
  ['/commit [push]', 'Generate a commit message, review it, commit'],
  ['/generate', 'Generate a message without committing'],
  ['/regenerate [hint]', 'Try again, optionally with a hint or "shorter", "type fix", ...'],
  ['/split', 'Split the changes into several logical commits'],
  ['/push', 'Push the current branch (asks first)'],
  ['/undo', 'Soft-undo the last commit (changes stay staged)'],
  ['/history [n]', 'Recent commits'],
  ['/model [name]', 'Show or switch the model'],
  ['/provider [id]', 'Show or switch the provider'],
  ['/config', 'Show effective configuration'],
  ['/clear', 'Clear the screen and the conversation'],
  ['/exit', 'Leave'],
];
