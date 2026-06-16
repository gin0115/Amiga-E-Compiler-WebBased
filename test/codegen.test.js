// compileProgram() build diagnostics (the `stats` object), used by the IDE's
// verbose link log: total code bytes, relocation count, A4 global-area size,
// and a per-linked-binary-module breakdown.
import { test, setFile } from './harness.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sem.js';
import { compileProgram } from '../src/codegen.js';
import { makeResolver } from '../tools/modules.js';

setFile('codegen.test.js');
const LINK = join(dirname(fileURLToPath(import.meta.url)), 'e2e', 'link');

function build(src) {
  const { program } = parse(src, 'main.e');
  const sem = analyze(program, { resolveModule: makeResolver(LINK, []) });
  return compileProgram(program, sem);
}

test('compileProgram exposes build stats', (a) => {
  const { bin, errors, stats } = build("PROC main()\n  WriteF('hi\\n')\nENDPROC\n");
  a.equal(errors.length, 0);
  a.ok(stats, 'stats present');
  a.ok(stats.codeBytes > 0 && stats.codeBytes <= bin.length, 'codeBytes within the binary');
  a.ok(stats.globalSize >= 32, 'globalSize includes the standard runtime globals');
  a.deepEqual(stats.modules, [], 'no binary modules linked for a plain program');
});

test('stats reports each linked binary module', (a) => {
  // mymath.m (gcd/fib/ipow) lives in test/e2e/link as a third-party-style module
  const { errors, stats } = build("MODULE 'mymath'\nPROC main()\n  WriteF('\\d\\n', gcd(48,36))\nENDPROC\n");
  a.equal(errors.length, 0);
  a.equal(stats.modules.length, 1, 'one binary module linked');
  a.equal(stats.modules[0].name, 'mymath');
  a.equal(stats.modules[0].procs, 3, 'gcd, fib, ipow');
  a.ok(stats.modules[0].codeBytes > 0, 'module code measured');
});
