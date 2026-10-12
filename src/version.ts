import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** package.json sits one level above both src/ and dist/. */
export const VERSION: string = (require('../package.json') as { version: string }).version;
