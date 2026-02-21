import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = join(__dirname, '..', 'node_modules', 'yargs', 'index.mjs');

const shim = `import yargs from './index.cjs';
export default yargs;
export * from './index.cjs';
`;

try {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, shim, 'utf8');
  console.log('[postinstall] shimmed yargs/index.mjs for DeskThing CLI.');
} catch (err) {
  console.warn('[postinstall] failed to write yargs shim:', err);
}
