/**
 * Compatibility with the PowerShell script: `aic -All -Push`, `aic -DryRun -Type fix`, `aic -Undo` ...
 * PowerShell parameters are case-insensitive and single-dash, so they are mapped onto the new flags here.
 * New code should use the documented flags (`aic commit --all --push`).
 */
const SWITCHES: Record<string, string> = {
  all: '--all', pick: '--pick', amend: '--amend', push: '--push', copy: '--copy', passthru: '--pass-thru',
  noverify: '--no-verify', signoff: '--signoff', breaking: '--breaking', emoji: '--emoji', yes: '--yes', dryrun: '--dry-run',
  noscan: '--no-scan', startollama: '--start-ollama', unload: '--unload', plain: '--plain', noanim: '--no-anim',
};
const VALUES: Record<string, string> = {
  model: '--model', ollamaurl: '--ollama-url', maxchars: '--max-chars', numctx: '--num-ctx', numpredict: '--num-predict',
  temperature: '--temperature', keepalive: '--keep-alive', timeoutsec: '--timeout', type: '--type', scope: '--scope', scopes: '--scopes',
  hint: '--hint', language: '--language', bullets: '--bullets', history: '--history', ref: '--ref', exclude: '--exclude',
  retries: '--retries',
};
const COMMANDS = new Set(['chat', 'generate', 'gen', 'commit', 'push', 'provider', 'model', 'config', 'init', 'undo', 'status', 'doctor', 'help']);

export interface LegacyResult {
  argv: string[];
  /** true when at least one PowerShell-style flag was translated */
  translated: boolean;
}

export function normalizeLegacyArgv(argv: string[]): LegacyResult {
  const out: string[] = [];
  let translated = false;
  let wantUndo = false;
  let wantInit = false;
  for (const a of argv) {
    const m = /^-([A-Za-z]{3,})$/.exec(a);
    const key = m?.[1]?.toLowerCase();
    if (key === 'undo') { wantUndo = true; translated = true; continue; }
    if (key === 'init') { wantInit = true; translated = true; continue; }
    if (key && SWITCHES[key]) { out.push(SWITCHES[key] as string); translated = true; continue; }
    if (key && VALUES[key]) { out.push(VALUES[key] as string); translated = true; continue; }
    out.push(a);
  }
  if (!translated) return { argv, translated: false };
  const hasCommand = out.some((a) => COMMANDS.has(a));
  const command = wantUndo ? 'undo' : wantInit ? 'init' : hasCommand ? undefined : 'commit';
  return { argv: command ? [command, ...out] : out, translated };
}
