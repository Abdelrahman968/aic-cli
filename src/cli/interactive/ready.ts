import type { Session } from '../../agent/session.js';
import { OllamaProvider } from '../../providers/ollama.js';
import { ui } from '../ui/output.js';
import { Spinner } from '../ui/spinner.js';
import { pickOne, yesNo } from '../ui/prompts.js';
import { updateGlobalConfig } from '../../config/global.js';
import { ProviderError } from '../../utils/errors.js';

export interface ReadyOptions {
  startOllama?: boolean | undefined;
  /** skip the model-installed check (e.g. `model list`) */
  skipModelCheck?: boolean;
}

/** Make sure the provider can answer: Ollama running (offer to start it) and model installed; cloud privacy notice. */
export async function ensureReady(s: Session, o: ReadyOptions = {}): Promise<void> {
  const p = s.provider;
  if (p instanceof OllamaProvider) {
    if (!(await p.isUp())) {
      const canStart = p.local && (o.startOllama || s.settings.autoStartOllama || (s.interactive && (await yesNo('Ollama is not running. Start it now?', true))));
      if (canStart) {
        const sp = new Spinner('starting ollama').start();
        const up = await p.startServer();
        sp.stop();
        if (!up) throw p.unreachableError();
      } else {
        throw p.unreachableError();
      }
    }
    if (!o.skipModelCheck) {
      const models = await p.listModels();
      const installed = models.map((m) => m.id);
      let want = OllamaProvider.canonicalName(s.model);
      if (!installed.includes(want)) {
        const alts = installed.filter((n) => !/embed/i.test(n));
        if (s.interactive && alts.length) {
          ui.warn(`Model '${s.model}' is not installed.`);
          want = await pickOne('Use one of your installed models', alts.map((n) => ({ name: n, value: n })));
        } else {
          throw new ProviderError(`Model '${s.model}' is not installed`, {
            details: installed.length ? `Installed: ${installed.join(', ')}` : 'No models are installed.',
            try: [`ollama pull ${s.model}`, 'aic model list'],
          });
        }
      }
      s.model = want;
      const caps = await p.capabilities(want);
      if (caps.includes('embedding') && !caps.includes('completion')) {
        throw new ProviderError(`'${want}' is an embedding model and cannot write text.`, { try: ['aic model list'] });
      }
    }
    return;
  }
  await cloudNotice(s);
}

/** Cloud providers receive repository context: say so, and ask once per provider. */
export async function cloudNotice(s: Session): Promise<void> {
  if (s.provider.local) return;
  const id = s.provider.id;
  const ack = s.resolved.global.acknowledgedProviders ?? [];
  if (ack.includes(id)) return;
  const what = [s.settings.sendDiff ? 'diff content' : '', 'file names', s.settings.sendHistory ? 'recent commit subjects' : '', s.settings.sendBranch ? 'branch name' : ''].filter(Boolean).join(', ');
  if (s.interactive && !s.yes) {
    ui.write('');
    ui.warn(`${s.provider.name} is a cloud provider (${s.provider.endpoint}).`);
    ui.dim(`AIC will send: ${what}. Secrets are redacted first. Control this with sendDiff / sendHistory / sendBranch.`);
    if (!(await yesNo(`Allow sending repository context to ${s.provider.name}?`, false))) {
      throw new ProviderError(`Not sending repository context to ${s.provider.name}`, { try: ['aic provider use ollama', 'aic config set sendDiff false'] });
    }
    updateGlobalConfig((g) => { g.acknowledgedProviders = [...new Set([...(g.acknowledgedProviders ?? []), id])]; });
  } else {
    ui.dim(`privacy: sending ${what} to ${s.provider.name} (${s.provider.endpoint})`);
  }
}
