// Parse every lexically-clean E file in the corpus and report the parse rate
// plus the most common error shapes — the driver for hardening the parser.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'research', 'extracted');
const showAll = process.argv.includes('--all');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) yield* walk(p);
    else if (name.toLowerCase().endsWith('.e')) yield p;
  }
}

function isBinary(buf) {
  if (buf.length >= 2 && buf[0] === 0xe3 && buf[1] === 0x10) return true;
  let ctl = 0;
  const lim = Math.min(buf.length, 65536);
  for (let k = 0; k < lim; k++) {
    const b = buf[k];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 27) || (b > 27 && b < 32)) ctl++;
  }
  return ctl > lim * 0.005 && ctl > 5;
}

let files = 0, clean = 0, skipped = 0, dialect = 0;
const errorKinds = new Map();

const t0 = Date.now();
for (const path of walk(root)) {
  const buf = readFileSync(path);
  if (isBinary(buf)) { skipped++; continue; }
  const src = buf.toString('latin1');
  if (lex(src, path).errors.length) { skipped++; continue; } // not lexable = not our problem here
  // other-dialect sources are not v3.3a targets: PortablE ({} imports,
  // NATIVE, PUBLIC sections) and CreativE (PMODULE etc.)
  if (/[\/\\]PortablE[\/\\]/.test(path) ||
      /^\s*(NATIVE|PMODULE|STATIC|TYPE|CLASS|IMPORT)\b/m.test(src) ||
      /\bENDNATIVE\b/.test(src) ||
      // MUI macro tag idiom `x := FooObject, tags...` needs a preprocessor
      // (oracle: real ec rejects `x := 1, 2`)
      /:=\s*\w*Object\s*,\s*$/m.test(src)) { dialect++; continue; }
  files++;
  const { errors } = parse(src, path);
  if (errors.length === 0) { clean++; continue; }
  const e = errors[0];
  const kind = e.msg
    .replace(/'[^']*'/g, '<tok>')
    .replace(/keyword \w+/, 'keyword <kw>');
  if (!errorKinds.has(kind)) errorKinds.set(kind, { count: 0, examples: [] });
  const k = errorKinds.get(kind);
  k.count++;
  if (k.examples.length < 3) k.examples.push(`${path}:${e.line}:${e.col} ${e.msg}`);
}
const ms = Date.now() - t0;

console.log(`\n=== corpus parse sweep ===`);
console.log(`files:    ${files} (lexable v3.3a-style; ${skipped} skipped, ${dialect} other-dialect)`);
console.log(`clean:    ${clean} (${(clean / files * 100).toFixed(2)}%)`);
console.log(`failed:   ${files - clean}`);
console.log(`time:     ${ms}ms\n`);

const sorted = [...errorKinds.entries()].sort((a, b) => b[1].count - a[1].count);
for (const [kind, info] of sorted.slice(0, showAll ? 1000 : 15)) {
  console.log(`${String(info.count).padStart(6)}  ${kind}`);
  for (const ex of info.examples) console.log(`        ${ex}`);
}
