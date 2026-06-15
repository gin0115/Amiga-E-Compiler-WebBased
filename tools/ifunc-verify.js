// Per-intrinsic run-verification against the real EC oracle, 1-for-1.
// For each case: compile a tiny OPT MODULE with the REAL compiler (EC) into a
// binary .m, then build a main program that links it and prints a result —
// once with EC (oracle) and once with ecomp — RUN both under vamos, and compare
// stdout. This proves the ported ifunc thunk behaves identically to EC's, not
// merely that it compiles.
//
//   node tools/ifunc-verify.js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sem.js';
import { compileProgram } from '../src/codegen.js';
import { makeResolver } from './modules.js';

const VAMOS = join(homedir(), '.local/bin/vamos');
const RES = '/media/glynn/2024/devilbox_public/ai-detective/amiga-e/research/extracted';
const EC = join(RES, 'ec33a/ec33a');
const FAKE = '*.library=mode:fake,version:40+dos.library=mode:auto+exec.library=mode:auto'
  + '+mathieeesingbas.library=mode:auto+mathieeesingtrans.library=mode:auto';

function vamos(args) {
  try {
    return execFileSync(VAMOS, args, { timeout: 60000, encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return 'ERR ' + ((e.stdout ?? '') + (e.stderr ?? '')).split('\n')[0]; }
}
const ecCompile = (w, mods, src, out) => {
  writeFileSync(join(w, `${out}.e`), src, 'latin1');
  vamos(['-q', '-V', `work:${w}`, '-V', `mods:${mods}`, '-V', `bin:${EC}`, '-a', 'emodules:mods:',
    '--cwd', 'work:', 'bin:EC', `${out}.e`]);
  return existsSync(join(w, out));
};
const run = (w, bin) => vamos(['-q', '-C', '68020', '-O', FAKE, '-V', `work:${w}`, '--cwd', 'work:', `work:${bin}`]);

// each case: a module exporting one PROC that exercises the intrinsic, and a
// main expression that calls it. `MODROOT` (ecomp's set) is on the emodules
// path so EC can find dos/exec/etc.
const MODROOT = join(process.cwd(), 'modules');
const CASES = [
  ['Mul', 'EXPORT PROC f(x) IS x*3', 'f(14)'],
  ['Div', 'EXPORT PROC f(x) IS x/3', 'f(126)'],
  ['And', 'EXPORT PROC f(a,b) IS a AND b', 'f(12,10)'],
  ['Or', 'EXPORT PROC f(a,b) IS a OR b', 'f(12,10)'],
  ['Abs', 'EXPORT PROC f(x) IS Abs(x)', 'f(-77)'],
  ['Shl', 'EXPORT PROC f(x) IS Shl(x,3)', 'f(5)'],
  ['Shr', 'EXPORT PROC f(x) IS Shr(x,2)', 'f(80)'],
  ['Min', 'EXPORT PROC f(a,b) IS Min(a,b)', 'f(9,4)'],
  ['Max', 'EXPORT PROC f(a,b) IS Max(a,b)', 'f(9,4)'],
  ['Sign', 'EXPORT PROC f(x) IS Sign(x)', 'f(-5)'],
  ['Even', 'EXPORT PROC f(x) IS Even(x)', 'f(8)'],
  ['Odd', 'EXPORT PROC f(x) IS Odd(x)', 'f(8)'],
  ['StrLen', "EXPORT PROC f() IS StrLen('hello')", 'f()'],
  ['Bounds', 'EXPORT PROC f(v) IS Bounds(v,10,20)', 'f(99)'],
  ['New_Dispose', 'EXPORT PROC f()\n  DEF p\n  p:=New(16)\n  Dispose(p)\nENDPROC IF p THEN 1 ELSE 0', 'f()'],
  // module prints via WriteF itself; main just calls it (void) — set 4th elem
  ['WriteF', "EXPORT PROC f()\n  WriteF('a=\\d b=\\s c=\\d\\n', 42, 'mid', 99)\nENDPROC", 'f()', true],
  ['StringF', "EXPORT PROC f()\n  DEF s[40]:STRING\n  StringF(s, 'x=\\d/\\d', 7, 3)\n  WriteF('\\s\\n', s)\nENDPROC", 'f()', true],
  ['String', "EXPORT PROC f()\n  DEF s\n  s:=String(20)\n  StrCopy(s,'pooled')\n  WriteF('\\s/\\d\\n', s, StrMax(s))\nENDPROC", 'f()', true],
  ['DisposeLink', "EXPORT PROC f()\n  DEF s\n  s:=String(10)\n  StrCopy(s,'hi')\n  DisposeLink(s)\nENDPROC IF s THEN 1 ELSE 0", 'f()'],
  ['Val', "EXPORT PROC f() IS Val('00255',NIL)", 'f()'],
  ['List', "EXPORT PROC f()\n  DEF l\n  l:=List(5)\n  WriteF('lmax=\\d\\n', ListMax(l))\nENDPROC", 'f()', true],
  ['SetList', "EXPORT PROC f()\n  DEF a[5]:LIST\n  SetList(a,3)\n  WriteF('\\d\\n', ListLen(a))\nENDPROC", 'f()', true],
  ['ListAdd', "EXPORT PROC f()\n  DEF a[5]:LIST\n  ListAdd(a,[7,8,9])\n  WriteF('\\d,\\d,\\d/\\d\\n', a[0],a[1],a[2],ListLen(a))\nENDPROC", 'f()', true],
  ['ListCopy', "EXPORT PROC f()\n  DEF a[5]:LIST,b[5]:LIST\n  ListAdd(a,[1,2])\n  ListCopy(b,a)\n  WriteF('\\d,\\d/\\d\\n', b[0],b[1],ListLen(b))\nENDPROC", 'f()', true],
  ['Mod', 'EXPORT PROC f(a,b) IS Mod(a,b)', 'f(17,5)'],
  ['CtrlC', 'EXPORT PROC f() IS CtrlC()', 'f()'],
  ['AstrCopy', "EXPORT PROC f()\n  DEF s[20]:STRING\n  AstrCopy(s,'hello',20)\n  WriteF('\\s/\\d\\n', s, StrLen(s))\nENDPROC", 'f()', true],
  ['CleanUp', "EXPORT PROC f()\n  WriteF('before\\n')\n  CleanUp(0)\n  WriteF('after\\n')\nENDPROC", 'f()', true],
  ['RealF', "EXPORT PROC f()\n  DEF s[20]:STRING\n  RealF(s,3.14159,2)\n  WriteF('\\s|', s)\n  RealF(s,2.5,3)\n  WriteF('\\s|', s)\n  RealF(s,42.0,0)\n  WriteF('\\s\\n', s)\nENDPROC", 'f()', true],
];

let pass = 0, fail = 0;
for (const [name, mod, callExpr, voidCall] of CASES) {
  const w = mkdtempSync(join(tmpdir(), `ifv-${name}-`));
  const modn = 'tm' + name.toLowerCase().replace(/[^a-z0-9]/g, '');  // unique per case
  // 1. EC builds the binary module
  writeFileSync(join(w, `${modn}.e`), `OPT MODULE\n${mod}\n`, 'latin1');
  vamos(['-q', '-V', `work:${w}`, '-V', `mods:${MODROOT}`, '-V', `bin:${EC}`, '-a', 'emodules:mods:',
    '--cwd', 'work:', 'bin:EC', `${modn}.e`]);
  if (!existsSync(join(w, `${modn}.m`))) { console.log(`SKIP ${name}: EC could not build module`); continue; }

  const body = voidCall ? `  ${callExpr}` : `  WriteF('\\d\\n', ${callExpr})`;
  const main = `MODULE '${modn}'\n\nPROC main()\n${body}\nENDPROC\n`;

  // 2. oracle: EC links the module + runs (module must be on the emodules path)
  copyFileSync(join(w, `${modn}.m`), join(MODROOT, `${modn}.m`));
  let ecOut = '<ec compile failed>';
  if (ecCompile(w, MODROOT, main, 'ref')) ecOut = run(w, 'ref');

  // 3. ecomp links the same module + runs
  let ourOut = '<ecomp failed>';
  try {
    const { program } = parse(main, 'main.e');
    const sem = analyze(program, { resolveModule: makeResolver(w) });
    if (sem.errors.length) ourOut = '<sem: ' + sem.errors[0].msg + '>';
    else {
      const { bin, errors } = compileProgram(program, sem);
      if (errors.length) ourOut = '<codegen: ' + errors[0].msg + '>';
      else { writeFileSync(join(w, 'ours'), bin); ourOut = run(w, 'ours'); }
    }
  } catch (e) { ourOut = '<' + e.message + '>'; }

  try { execFileSync('rm', ['-f', join(MODROOT, `${modn}.m`)]); } catch {}

  const ok = ecOut === ourOut && !ecOut.startsWith('<') && !ecOut.startsWith('ERR');
  if (ok) { console.log(`PASS ${name.padEnd(14)} EC=${JSON.stringify(ecOut)} ecomp=${JSON.stringify(ourOut)}`); pass++; }
  else { console.log(`FAIL ${name.padEnd(14)} EC=${JSON.stringify(ecOut)} ecomp=${JSON.stringify(ourOut)}`); fail++; }
}
console.log(`\n${pass}/${pass + fail} intrinsics verified identical to EC`);
process.exit(fail ? 1 : 0);
