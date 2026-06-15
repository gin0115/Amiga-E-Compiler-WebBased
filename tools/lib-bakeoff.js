// 3rd-party library link bake-off: for each of N binary code-module libraries,
// auto-generate a minimal program that imports it and calls one exported PROC,
// then compile that program with BOTH the registered original compiler
// (EC under vamos, the oracle) and ecomp. Tabulate who compiles.
//
// This is the test-driven scoreboard for code-module linking: as ifunc relocs,
// GLOBS/library binding, etc. land, more libs flip from ecomp-FAIL to ecomp-OK.
//
//   node tools/lib-bakeoff.js [count]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { readEmod } from '../src/emod.js';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sem.js';
import { compileProgram } from '../src/codegen.js';
import { makeResolver } from './modules.js';

const VAMOS = join(homedir(), '.local/bin/vamos');
const RES = '/media/glynn/2024/devilbox_public/ai-detective/amiga-e/research/extracted';
const EC = join(RES, 'ec33a/ec33a');                 // registered (non-demo) compiler dir
const MODROOT = join(process.cwd(), 'modules');      // ecomp's module set (full subdir layout)
const COUNT = Number(process.argv[2] || 24);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith('.m')) out.push(p);
  }
  return out;
}

// pick code-module libraries that export a callable PROC; prefer the GUI/tool
// libraries (subdir modules) since those are the real 3rd-party ones
const libs = [];
for (const p of walk(MODROOT).sort()) {
  const m = readEmod(new Uint8Array(readFileSync(p)), p);
  if (!m.isCodeModule || !m.code) continue;
  const proc = m.procs.find(x => x.kind === 'proc' && x.args <= 8);
  if (!proc) continue;
  const name = relative(MODROOT, p).replace(/\.m$/, '');   // e.g. tools/EasyGUI
  libs.push({ name, proc: proc.name, args: proc.args, path: p });
  if (libs.length >= COUNT) break;
}

function genSrc(lib) {
  const argv = Array(lib.args).fill('0').join(', ');
  return `OPT OSVERSION=37\nMODULE '${lib.name}'\n\nPROC main()\n  ${lib.proc}(${argv})\nENDPROC\n`;
}

function oracleCompiles(src) {
  const w = mkdtempSync(join(tmpdir(), 'bake-o-'));
  writeFileSync(join(w, 'ref.e'), src, 'latin1');
  try {
    execFileSync(VAMOS, ['-q', '-V', `work:${w}`, '-V', `mods:${MODROOT}`, '-V', `bin:${EC}`,
      '-a', 'emodules:mods:', '--cwd', 'work:', 'bin:EC', 'ref.e'],
      { timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { /* ignore — check artifact */ }
  return existsSync(join(w, 'ref'));
}

function ecompCompiles(src) {
  try {
    const { program, errors: pe } = parse(src, 'm.e');
    if (pe.length) return { ok: false, why: 'parse' };
    const sem = analyze(program, { resolveModule: makeResolver(MODROOT) });
    if (sem.errors.length) return { ok: false, why: sem.errors[0].msg };
    const { bin, errors } = compileProgram(program, sem);
    if (errors.length) return { ok: false, why: errors[0].msg };
    return { ok: !!(bin && bin.length), why: '' };
  } catch (e) { return { ok: false, why: e.message }; }
}

console.log(`Library link bake-off — ${libs.length} libraries\n`);
console.log('lib'.padEnd(26), 'proc'.padEnd(20), 'oracle', 'ecomp', 'why (ecomp fail)');
console.log('-'.repeat(96));
let bothOk = 0, oracleOk = 0;
for (const lib of libs) {
  const src = genSrc(lib);
  const o = oracleCompiles(src);
  const e = ecompCompiles(src);
  if (o) oracleOk++;
  if (o && e.ok) bothOk++;
  console.log(
    lib.name.padEnd(26),
    `${lib.proc}/${lib.args}`.padEnd(20),
    (o ? ' ✓   ' : ' ✗   '),
    (e.ok ? ' ✓  ' : ' ✗  '),
    e.ok ? '' : e.why.slice(0, 44));
}
console.log('-'.repeat(96));
console.log(`oracle compiles: ${oracleOk}/${libs.length} | both compile: ${bothOk}/${libs.length}`);
