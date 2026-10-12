import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
if (existsSync(bin)) {
  try { chmodSync(bin, 0o755); } catch { /* not supported on this FS */ }
}
