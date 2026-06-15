// Head-to-head: compile a program that uses a 3rd-party binary module with
// BOTH the original compiler (ECDEMO under vamos) and ecomp, and report whether
// each produces a binary. Drives the code-module-linking work test-first.
//
//   node tools/compare-compile.js <source.e> [moduleDir-with-extra-.m]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, symlinkSync, copyFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sem.js';
import { compileProgram } from '../src/codegen.js';
import { makeResolver } from './modules.js';

const VAMOS = join(homedir(), '.local/bin/vamos');
const RES = '/media/glynn/2024/devilbox_public/ai-detective/amiga-e/research/extracted';
const BIN = join(RES, 'amigae33a/E_v3.3a/Bin');
const MODS = join(RES, 'amigae33a/E_v3.3a/Modules.lha.x/Modules');
const ECMODS = join(process.cwd(), 'modules');   // ecomp's shipped module set

const srcPath = process.argv[2];
const src = readFileSync(srcPath, 'latin1');
console.log(`\n=== ${basename(srcPath)} ===`);
console.log(src.split('\n').slice(0, 12).map(l => '  | ' + l).join('\n'));

// ---- oracle: ECDEMO. EasyGUI.m etc. must be on the EMODULES path, so build a
// merged module dir = system modules + ecomp's tools/* (where EasyGUI lives). ----
const merged = mkdtempSync(join(tmpdir(), 'mods-'));
for (const f of readdirSync(MODS)) { try { symlinkSync(join(MODS, f), join(merged, f)); } catch {} }
// flatten ecomp's subdir modules (tools/EasyGUI.m -> EasyGUI.m) onto the path
for (const sub of readdirSync(ECMODS)) {
  const p = join(ECMODS, sub);
  if (statSync(p).isDirectory()) {
    for (const m of readdirSync(p)) if (m.endsWith('.m')) {
      try { copyFileSync(join(p, m), join(merged, m)); } catch {}
    }
  }
}

const ow = mkdtempSync(join(tmpdir(), 'oracle-'));
writeFileSync(join(ow, 'ref.e'), src, 'latin1');
let oracleOk = false, oracleMsg = '';
try {
  const o = execFileSync(VAMOS, ['-q', '-V', `work:${ow}`, '-V', `mods:${merged}`, '-V', `bin:${BIN}`,
    '-a', 'emodules:mods:', '--cwd', 'work:', 'bin:ECDEMO', 'ref.e'],
    { timeout: 60000, encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] });
  oracleMsg = o.trim().split('\n').slice(-2).join(' ');
  oracleOk = existsSync(join(ow, 'ref'));
} catch (e) { oracleMsg = (e.stdout ?? '') + (e.stderr ?? ''); }
console.log(`\nECDEMO (oracle): ${oracleOk ? 'COMPILED ✓' : 'failed'}  ${oracleMsg.slice(0, 120)}`);

// ---- ours: ecomp ----
let ecompOk = false, ecompMsg = '';
try {
  const { program, errors: pe } = parse(src, basename(srcPath));
  if (pe.length) throw new Error('parse: ' + pe.map(x => x.msg).slice(0, 3).join('; '));
  const sem = analyze(program, { resolveModule: makeResolver(ECMODS) });
  if (sem.errors.length) throw new Error('sem: ' + sem.errors.map(x => x.msg).slice(0, 3).join('; '));
  const { bin, errors } = compileProgram(program, sem);
  if (errors.length) throw new Error('codegen: ' + errors.map(x => x.msg).slice(0, 3).join('; '));
  ecompOk = bin && bin.length > 0;
  ecompMsg = `${bin.length} bytes`;
  for (const w of sem.warnings ?? []) ecompMsg += `\n    warn: ${w.msg}`;
} catch (e) { ecompMsg = e.message; }
console.log(`ecomp (ours):   ${ecompOk ? 'COMPILED ✓' : 'failed'}  ${ecompMsg.slice(0, 200)}`);

console.log(`\nboth compile: ${oracleOk && ecompOk ? 'YES' : 'NO'}`);
