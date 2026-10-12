import { homedir } from 'node:os';
import { join } from 'node:path';

/** Directory that holds the global config. Override with AIC_CONFIG_DIR (also used by the tests). */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env['AIC_CONFIG_DIR'];
  if (override) return override;
  if (platform === 'win32') return join(env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'aic');
  return join(env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'aic');
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'config.json');
}

export const PROJECT_CONFIG_NAME = '.aic.json';
