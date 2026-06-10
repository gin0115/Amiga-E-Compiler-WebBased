// Minimal test framework: zero dependencies so it runs on bare node 16
// (npm registry is unreachable in this environment) and in the browser.
import { strict as assert } from 'node:assert';

const results = [];
let currentFile = '';

export function setFile(name) {
  currentFile = name;
}

export function test(name, fn) {
  try {
    fn(assert);
    results.push({ file: currentFile, name, ok: true });
  } catch (err) {
    results.push({ file: currentFile, name, ok: false, err });
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
  console.log(`\n${results.length - fails.length}/${results.length} tests passed` +
    (fails.length ? `, ${fails.length} FAILED` : ''));
  return fails.length === 0;
}
