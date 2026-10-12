import { spawn } from 'node:child_process';

function tryCopy(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
      p.stdin.on('error', () => resolve(false));
      p.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/** Copy text to the system clipboard without extra dependencies. Returns false when unavailable. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (process.platform === 'win32') return tryCopy('clip', [], text.replace(/\r?\n/g, '\r\n'));
  if (process.platform === 'darwin') return tryCopy('pbcopy', [], text);
  if (process.env['WAYLAND_DISPLAY'] && (await tryCopy('wl-copy', [], text))) return true;
  if (await tryCopy('xclip', ['-selection', 'clipboard'], text)) return true;
  if (await tryCopy('xsel', ['--clipboard', '--input'], text)) return true;
  return false;
}
