// Regression guard: binary-module Mul/Div/Mod ifunc thunks must be 68000-safe
// and match EC. ecomp once emitted the 68020-only muls.l/divs.l for these thunks
// (and BSR.L for ifunc relocs), so output linking a binary module that calls
// Mul/Div/Mod crashed on a plain 68000 where EC's runs fine. This test compiles
// a module using Mul/Div/Mod with EC, links it from ecomp, and runs BOTH under a
// 68000 (no -C 68020), comparing signed results.
//
//   node tools/cpu68000-verify.js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sem.js';
import { compileProgram } from '../src/codegen.js';
import { makeResolver } from './modules.js';

const VAMOS = join(homedir(), '.local/bin/vamos');
const RES = '/media/glynn/2024/devilbox_public/ai-detective/amiga-e/research/extracted';
const EC = join(RES, 'ec33a/ec33a');
const MODS = join(process.cwd(), 'modules');
const FAKE = '*.library=mode:fake,version:40+dos.library=mode:auto+exec.library=mode:auto';

function vamos(args) {
  try { return execFileSync(VAMOS, args, { timeout: 60000, encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { return 'ERR ' + ((e.stdout ?? '') + (e.stderr ?? '')).split('\n')[0]; }
}
const ecBuild = (w, f) => vamos(['-q', '-V', `work:${w}`, '-V', `mods:${MODS}`, '-a', 'emodules:work:+mods:',
  '-V', `bin:${EC}`, '--cwd', 'work:', 'bin:EC', f]);
// NB: NO -C 68020 — run on a plain 68000 to catch 68020-only instructions.
const run = (w, b) => vamos(['-q', '-O', FAKE, '-V', `work:${w}`, '--cwd', 'work:', `work:${b}`]);

const MOD = `OPT MODULE
EXPORT PROC tmul(a,b) IS Mul(a,b)
EXPORT PROC tdiv(a,b) IS Div(a,b)
EXPORT PROC tmod(a,b) IS Mod(a,b)
`;
const MAIN = `MODULE 'mdm'
PROC main()
  WriteF('mul \\d \\d \\d\\n', tmul(100000,3), tmul(-7,8), tmul(-5,-6))
  WriteF('div \\d \\d \\d \\d\\n', tdiv(1000000,7), tdiv(-1000000,7), tdiv(1000000,-7), tdiv(-100,-7))
  WriteF('mod \\d \\d \\d\\n', tmod(17,5), tmod(-17,5), tmod(17,-5))
ENDPROC
`;

if (!existsSync(VAMOS) || !existsSync(EC)) { console.log('SKIP: vamos/EC oracle not available'); process.exit(0); }

const w = mkdtempSync(join(tmpdir(), 'cpu68k-'));
writeFileSync(join(w, 'mdm.e'), MOD, 'latin1');
writeFileSync(join(w, 'main.e'), MAIN, 'latin1');
ecBuild(w, 'mdm.e');
if (!existsSync(join(w, 'mdm.m'))) { console.log('SKIP: EC could not build mdm.m'); process.exit(0); }

let ec = '<ec build failed>';
ecBuild(w, 'main.e');
if (existsSync(join(w, 'main'))) ec = run(w, 'main');
if (ec.startsWith('<') || ec.startsWith('ERR')) { console.log(`SKIP: EC oracle could not build/run (${ec})`); process.exit(0); }

let ours = '<ecomp failed>';
try {
  const { program } = parse(MAIN, 'main.e');
  const sem = analyze(program, { resolveModule: makeResolver(w, [MODS]) });
  if (sem.errors.length) ours = '<sem: ' + sem.errors[0].msg + '>';
  else {
    const { bin, errors } = compileProgram(program, sem);
    if (errors.length) ours = '<cg: ' + errors[0].msg + '>';
    else { writeFileSync(join(w, 'ours'), bin); ours = run(w, 'ours'); }
  }
} catch (e) { ours = '<' + e.message + '>'; }

const ok = ec === ours;
console.log(`${ok ? 'PASS' : 'FAIL'} binary-module Mul/Div/Mod on 68000  EC=${JSON.stringify(ec)} ecomp=${JSON.stringify(ours)}`);
process.exit(ok ? 0 : 1);
