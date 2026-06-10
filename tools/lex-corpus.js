// Sweep every .e file in the research corpus through the lexer and report
// the pass rate plus the most common error shapes. Corpus files are 1980s/90s
// Amiga text: read as latin1 (any byte is valid, no utf8 decode failures).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lex } from '../src/lexer.js';

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

// Not every "*.e" in the corpus is source: some are Workbench icons
// (magic 0xE310), compiled modules, or files with corrupt binary tails.
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

// A failing file is only a lexer bug if it is genuine Amiga E source.
// The corpus also contains prose misnamed .e, truncated extractions, and
// PortablE-dialect sources (NATIVE inline-C, escaped char consts, bare $).
function classify(path, src, errors) {
  if (/[\/\\]PortablE[\/\\]/.test(path) || /\bENDNATIVE\b|!!VALUE|\bNATIVE\s*\{/.test(src)) {
    return 'portablE-dialect';
  }
  if (/^\s*#\s*(define|include|ifdef|ifndef|if\b|endif|undef)/m.test(src) ||
      /\bINCLUDE\s+"/.test(src)) {
    return 'preprocessor-dialect (ECX/CreativE)';
  }
  if (!/^\s*(PROC|OPT|MODULE|CONST|ENUM|OBJECT|DEF)\b/m.test(src)) {
    return 'not-E-text';
  }
  if (errors.some(e => /character constant/.test(e.msg)) && /"\\"/.test(src)) {
    return 'charconst-lone-backslash (oracle: real ec rejects too)';
  }
  if (/unexpected character "[\x80-\xff]/.test(errors[0].msg) ||
      /'[^'\n]*[a-z]'[a-z\xe0-\xff]/.test(src)) {
    return 'latin1-or-apostrophe-in-string (oracle: real ec rejects these)';
  }
  if (errors.some(e => /unterminated/.test(e.msg))) return 'unterminated-at-eof';
  return 'UNEXPLAINED';
}

let files = 0, clean = 0, binary = 0, totalTokens = 0, totalErrors = 0;
const buckets = new Map();
const unexplained = [];

const t0 = Date.now();
for (const path of walk(root)) {
  const buf = readFileSync(path);
  if (isBinary(buf)) { binary++; continue; }
  files++;
  const src = buf.toString('latin1');
  const { tokens, errors } = lex(src, path);
  totalTokens += tokens.length;
  if (errors.length === 0) {
    clean++;
  } else {
    totalErrors += errors.length;
    const bucket = classify(path, src, errors);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    if (bucket === 'UNEXPLAINED') {
      const e = errors[0];
      unexplained.push(`${path}:${e.line}:${e.col} ${e.msg} (${errors.length} errs)`);
    }
  }
  if (files % 1000 === 0) console.log(`...${files} files`);
}
const ms = Date.now() - t0;
const failed = files - clean;

console.log(`\n=== corpus lex sweep ===`);
console.log(`files:    ${files} (+ ${binary} binary/corrupt skipped)`);
console.log(`clean:    ${clean} (${(clean / files * 100).toFixed(2)}%)`);
console.log(`failed:   ${failed}, total errors: ${totalErrors}`);
console.log(`tokens:   ${totalTokens}`);
console.log(`time:     ${ms}ms\n`);

for (const [bucket, count] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(6)}  ${bucket}`);
}
if (unexplained.length) {
  console.log(`\nUNEXPLAINED failures (potential lexer bugs):`);
  for (const u of unexplained) console.log(`  ${u}`);
}
process.exit(unexplained.length === 0 ? 0 : 1);
