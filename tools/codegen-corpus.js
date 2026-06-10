// Run every parseable corpus file through sem+codegen and histogram the
// unsupported-feature errors — a frequency-ordered roadmap for codegen work.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sem.js';
import { compileProgram } from '../src/codegen.js';
import { makeResolver } from './modules.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'research', 'extracted');

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
  return buf.includes(0);
}

let files = 0, clean = 0, crashed = 0;
const kinds = new Map();
for (const path of walk(root)) {
  const buf = readFileSync(path);
  if (isBinary(buf)) continue;
  const src = buf.toString('latin1');
  let program;
  try {
    const r = parse(src, path);
    if (r.errors.length) continue;
    program = r.program;
  } catch { continue; }
  files++;
  try {
    const sem = analyze(program, { resolveModule: makeResolver(dirname(path)) });
    const { errors } = compileProgram(program, sem);
    if (!errors.length) { clean++; continue; }
    const seen = new Set();
    for (const e of errors) {
      const kind = e.msg
        .replace(/'[^']*'/g, '<x>')
        .replace(/variable \S+/, 'variable <x>')
        .replace(/member \S+ of \S+/, 'member <x>')
        .replace(/\(.*\)/, '')
        .replace(/ in \S+$/, '')
        .trim();
      if (seen.has(kind)) continue;  // count each kind once per file
      seen.add(kind);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
  } catch (err) {
    crashed++;
    const kind = 'CRASH: ' + err.message.slice(0, 60);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
}

console.log(`\n=== codegen corpus sweep ===`);
console.log(`files (parse-clean): ${files}`);
console.log(`codegen-clean:       ${clean} (${(clean / files * 100).toFixed(2)}%)`);
console.log(`crashes:             ${crashed}\n`);
for (const [k, c] of [...kinds.entries()].sort((x, y) => y[1] - x[1]).slice(0, 25)) {
  console.log(`${String(c).padStart(6)}  ${k}`);
}
