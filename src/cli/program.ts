import { Command, CommanderError } from 'commander';
import { VERSION } from '../version.js';
import { ui } from './ui/output.js';
import { normalizeLegacyArgv } from './legacy.js';
import { addCommitOptions, collect } from './options.js';
import { runCommit, runGenerate, runPush } from './commands/flow.js';
import { runChat } from './commands/chat.js';
import { runStatus } from './commands/status.js';
import { runUndoCommand } from './commands/undo-cmd.js';
import { runInit } from './commands/init.js';
import { runDoctor } from './commands/doctor.js';
import { providerAdd, providerList, providerRemove, providerTest, providerUse } from './commands/provider.js';
import { modelCurrent, modelList, modelTest, modelUse } from './commands/model.js';
import { configEdit, configGet, configInteractive, configList, configPath, configReset, configSet, configUnset } from './commands/config.js';
import { AicError, CancelledError, ExitCode, UsageError } from '../utils/errors.js';

const EXAMPLES = `
Examples:
  aic                              interactive AI agent for the current repository
  aic commit                       generate a message, review it, commit
  aic commit --all --push          stage everything, commit, push (asks before pushing)
  aic generate --pass-thru         print a message on stdout, commit nothing
  aic commit --dry-run --type fix --scope auth
  aic provider add my-provider --base-url https://example.com/v1 --api-key-env MY_API_KEY
  aic config set provider openai
  aic doctor                       check Node, Git, provider, model and configuration

Exit codes: 0 ok, 1 general, 2 usage, 3 provider, 4 git, 5 secret detected, 6 cancelled
Docs: https://github.com/aic-cli/aic#readme`;

export interface BuiltProgram {
  program: Command;
  exit: { code: number };
}

export function buildProgram(): BuiltProgram {
  const exit = { code: 0 };
  const program = new Command('aic');
  program
    .description('AIC — AI Coding Agent for Git: commit messages, repository analysis and safe Git automation.')
    .usage('[command] [options]')
    .version(VERSION, '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .addHelpCommand('help [command]', 'show help for a command')
    .configureHelp({ visibleArguments: () => [] })
    .showSuggestionAfterError()
    .allowExcessArguments(true)
    .exitOverride()
    .configureOutput({
      writeErr: (s) => process.stderr.write(s),
      outputError: (s, write) => write(s),
    })
    .option('-m, --model <model>', 'model to use (overrides config)')
    .option('-p, --provider <id>', 'provider to use: ollama, openai, anthropic, gemini, openrouter or a custom id')
    .option('--ollama-url <url>', 'Ollama server URL')
    .option('--start-ollama', 'start `ollama serve` if it is not running')
    .option('-n, --dry-run', 'show the message, commit nothing')
    .option('-y, --yes', 'skip the review prompt (never skips secret or safety checks)')
    .option('--no-scan', 'skip the secret scan (only if you understand the risk)')
    .option('--verbose', 'show extra diagnostics')
    .option('-q, --quiet', 'less output')
    .option('--plain', 'ASCII only, no colour, no animation')
    .option('--no-color', 'disable colours')
    .option('--no-anim', 'keep colours, drop animations')
    .option('--cwd <dir>', 'run as if started in <dir>');

  program.hook('preAction', (root) => {
    const o = root.opts<{ verbose?: boolean; quiet?: boolean; plain?: boolean; color?: boolean; anim?: boolean }>();
    ui.configure({ plain: o.plain, noColor: o.color === false, noAnim: o.anim === false, quiet: o.quiet, verbose: o.verbose });
    if (o.verbose) process.env['AIC_VERBOSE'] = '1';
  });

  program.addHelpText('after', EXAMPLES);

  program.argument('[args...]', 'unknown arguments are rejected').action(async (args: string[], _o: unknown, cmd: Command) => {
    if (args.length > 0) {
      throw new UsageError(`Unknown command "${args[0]}"`, { try: ['aic help'] });
    }
    if (process.stdin.isTTY && process.stderr.isTTY) await runChat(cmd);
    else program.outputHelp();
  });

  program.command('chat').description('start the interactive AI agent (default when run in a terminal)').action((_o, cmd: Command) => runChat(cmd));

  addCommitOptions(
    program.command('generate').alias('gen').description('generate a commit message for the staged changes (commits nothing)'),
  ).action((_o, cmd: Command) => runGenerate(cmd));

  addCommitOptions(
    program.command('commit').description('generate a message, review it, commit'),
  ).action((_o, cmd: Command) => runCommit(cmd));

  addCommitOptions(
    program.command('push').description('commit and push (with nothing to commit: push existing commits)'),
  ).action((_o, cmd: Command) => runPush(cmd));

  program.command('undo').description('soft-undo the last commit (changes stay staged)').action((_o, cmd: Command) => runUndoCommand(cmd));

  program.command('status').description('show repository status').option('--json', 'machine-readable output').action((_o, cmd: Command) => runStatus(cmd));

  program.command('init').description('create .aic.json for this repository (scopes are inferred)')
    .option('--global', 'set up the global configuration instead')
    .option('--force', 'overwrite an existing file')
    .action((o: { global?: boolean; force?: boolean }, cmd: Command) => runInit(cmd, o));

  program.command('doctor').description('check Node, Git, provider, model and configuration')
    .action(async (_o, cmd: Command) => { exit.code = await runDoctor(cmd); });

  // ---- provider -------------------------------------------------------------------------------
  const provider = program.command('provider').description('manage AI providers').action(function (this: Command) { this.help(); });
  provider.command('list').alias('ls').description('list providers and show the current one').option('--json', 'machine-readable output').action((_o, cmd: Command) => providerList(cmd));
  provider.command('add [name]').description('add a custom OpenAI-compatible (or Anthropic/Ollama protocol) provider')
    .option('--base-url <url>', 'API base URL, e.g. https://example.com/v1')
    .option('--protocol <p>', 'openai-compatible (default), anthropic or ollama')
    .option('--api-key-env <NAME>', 'environment variable that holds the API key')
    .option('--model <model>', 'default model')
    .option('--header <NAME=value>', 'extra static header (repeatable; not for secrets)', collect)
    .option('--timeout <seconds>', 'request timeout')
    .option('--no-stream', 'the endpoint does not support streaming')
    .option('--context-length <n>', 'context length of the model')
    .option('--temperature <n>', 'default temperature')
    .option('--max-tokens <n>', 'default max tokens')
    .option('--force', 'overwrite an existing definition')
    .action((name: string | undefined, o, cmd: Command) => providerAdd(cmd, name, o));
  provider.command('remove <name>').alias('rm').description('remove a custom provider').action((name: string, _o, cmd: Command) => providerRemove(cmd, name));
  provider.command('use [name]').description('make a provider the default').option('--model <model>', 'also set the model')
    .action((name: string | undefined, o: { model?: string }, cmd: Command) => providerUse(cmd, name, o));
  provider.command('test [name]').description('check connectivity, credentials and a tiny generation')
    .option('--no-generate', 'only list models, do not send a prompt')
    .action((name: string | undefined, o: { generate?: boolean }, cmd: Command) => providerTest(cmd, name, o));

  // ---- model ----------------------------------------------------------------------------------
  const model = program.command('model').description('manage models for the current provider').action(function (this: Command) { this.help(); });
  model.command('list').alias('ls').description('list available models').option('--json', 'machine-readable output').action((_o, cmd: Command) => modelList(cmd));
  model.command('current').description('show the active provider and model').option('--json', 'machine-readable output').action((_o, cmd: Command) => modelCurrent(cmd));
  model.command('use [name]').description('select a model (interactive picker when omitted)').option('--project', 'save in .aic.json instead of the global config')
    .action((name: string | undefined, o: { project?: boolean }, cmd: Command) => modelUse(cmd, name, o));
  model.command('test [name]').description('send a tiny prompt to the model').action((name: string | undefined, _o, cmd: Command) => modelTest(cmd, name));

  // ---- config ---------------------------------------------------------------------------------
  const config = program.command('config').description('manage settings (interactive when run without a subcommand)')
    .action((_o, cmd: Command) => configInteractive(cmd));
  config.command('list').alias('ls').description('show effective settings and where each value comes from').option('--json', 'machine-readable output').action((_o, cmd: Command) => configList(cmd));
  config.command('get <key>').description('print one effective value').action((key: string, _o, cmd: Command) => configGet(cmd, key));
  config.command('set <key> [value]').description('set a value (api-key prompts without echo when the value is omitted)')
    .option('--project', 'write to .aic.json in this repository')
    .option('--provider <id>', 'for api-key: which provider the key belongs to')
    .action((key: string, value: string | undefined, o: { project?: boolean; provider?: string }, cmd: Command) => configSet(cmd, key, value, o));
  config.command('unset <key>').description('remove a value so the default applies').option('--project', 'remove from .aic.json')
    .action((key: string, o: { project?: boolean }, cmd: Command) => configUnset(cmd, key, o));
  config.command('reset').description('reset settings to defaults (keeps providers and API keys)').option('--all', 'delete the whole global config, including providers and keys')
    .action((o: { all?: boolean }, cmd: Command) => configReset(cmd, o));
  config.command('edit').description('open the config file in $EDITOR').option('--project', 'edit .aic.json instead').action((o: { project?: boolean }, cmd: Command) => configEdit(cmd, o));
  config.command('path').description('print the global config path').action(() => configPath());

  return { program, exit };
}

/** Run the CLI and return the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const legacy = normalizeLegacyArgv(argv);
  const { program, exit } = buildProgram();
  try {
    await program.parseAsync(legacy.argv, { from: 'user' });
    if (legacy.translated) ui.dim('PowerShell-style flags are still accepted. New syntax: aic commit --all --push (see `aic help commit`).');
    return exit.code;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') return 0;
      return ExitCode.USAGE;
    }
    if (e instanceof CancelledError) {
      ui.write('  ' + ui.theme.mute('cancelled'));
      return ExitCode.CANCELLED;
    }
    ui.error(e);
    return e instanceof AicError ? e.code : ExitCode.GENERAL;
  }
}
