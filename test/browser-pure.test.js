// The compiler core must run in the browser: nothing under src/ may import
// node builtins or use node globals. tools/ and test/ are host-side rigs.
import { test } from './harness.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('src/ is pure browser JS: no node imports or globals', a => {
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith('.js')) continue;
    const code = readFileSync(join(srcDir, f), 'utf8');
    a.ok(!/from\s+['"]node:/.test(code), `${f} imports node builtin`);
    a.ok(!/\brequire\s*\(/.test(code), `${f} uses require()`);
    a.ok(!/\bprocess\.|__dirname|__filename/.test(code), `${f} uses node globals`);
  }
});
