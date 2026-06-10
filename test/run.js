import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setFile, summary } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(f => f.endsWith('.test.js')).sort();

for (const f of files) {
  setFile(f);
  await import(join(here, f));
}

process.exit(summary() ? 0 : 1);
