// Minimal test framework: zero dependencies so it runs on bare node 16
// (npm registry is unreachable in this environment) and in the browser.
import { strict as assert } from 'node:assert';

const results = [];
let currentFile = '';

export function setFile(name) {
  currentFile = name;
}

const QUIET = process.argv.includes('--quiet') || process.env.ECOMP_TEST_QUIET;

export function test(name, fn) {
  try {
    fn(assert);
    results.push({ file: currentFile, name, ok: true });
    if (!QUIET) console.log(`PASS [${currentFile.replace('.test.js', '')}] ${name}`);
  } catch (err) {
    results.push({ file: currentFile, name, ok: false, err });
    if (!QUIET) console.log(`FAIL [${currentFile.replace('.test.js', '')}] ${name}`);
  }
}

export function summary() {
  const fails = results.filter(r => !r.ok);
  for (const r of results) {
    if (!r.ok) {
      console.log(`FAIL  [${r.file}] ${r.name}`);
      console.log(`      ${r.err.message.split('\n').join('\n      ')}`);
    }
  }
  const byFile = new Map();
  for (const r of results) {
    const f = r.file.replace('.test.js', '');
    if (!byFile.has(f)) byFile.set(f, { p: 0, f: 0 });
    byFile.get(f)[r.ok ? 'p' : 'f']++;
  }
  console.log('');
  for (const [f, c] of byFile) {
    console.log(`  ${f.padEnd(14)} ${c.p}/${c.p + c.f}${c.f ? `  (${c.f} FAILED)` : ''}`);
  }
  console.log(`\n${results.length - fails.length}/${results.length} tests passed` +
    (fails.length ? `, ${fails.length} FAILED` : ''));
  return fails.length === 0;
}
