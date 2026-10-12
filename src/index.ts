#!/usr/bin/env node
import { main } from './cli/program.js';
import { ExitCode } from './utils/errors.js';

// Restore the cursor and leave with the "cancelled" code, unless something (generation, a prompt) handles Ctrl+C itself.
process.on('SIGINT', () => {
  if (process.listenerCount('SIGINT') > 1) return;
  process.stderr.write('\u001b[?25h\n');
  process.exit(ExitCode.CANCELLED);
});

// Closed pipes (`aic ... | head`) are not errors.
process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); });

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => {
    process.stderr.write(`aic: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = ExitCode.GENERAL;
  },
);
