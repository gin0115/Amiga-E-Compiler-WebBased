// Run-verification of binary-module CLASS dispatch (vtable) against real EC.
// For each case: EC builds a class `OPT MODULE` into a binary .m, then a main
// program exercises it via NEW / method calls / END — compiled once with EC
// (oracle) and once with ecomp, both RUN under vamos, stdout compared. This
// proves ecomp's runtime vtable dispatch (docs/oop-dispatch.md) matches EC's,
// not merely that it compiles.
//
//   node tools/oop-verify.js
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
const MODROOT = join(process.cwd(), 'modules');
const FAKE = '*.library=mode:fake,version:40+dos.library=mode:auto+exec.library=mode:auto';

function vamos(args) {
  try { return execFileSync(VAMOS, args, { timeout: 60000, encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return 'ERR ' + ((e.stdout ?? '') + (e.stderr ?? '')).split('\n')[0]; }
}
const ecBuild = (w, mods, file) => vamos(['-q', '-V', `work:${w}`, '-V', `mods:${mods}`, '-V', `bin:${EC}`,
  '-a', 'emodules:mods:', '--cwd', 'work:', 'bin:EC', file]);
const run = (w, bin) => vamos(['-q', '-C', '68020', '-O', FAKE, '-V', `work:${w}`, '--cwd', 'work:', `work:${bin}`]);

// each case: [name, module source (OPT MODULE), main body using the class]
const CASES = [
  ['ctor_method_member',
   `OPT MODULE
EXPORT OBJECT vec
  x:LONG
  y:LONG
ENDOBJECT
EXPORT PROC vec(a,b) OF vec
  self.x := a
  self.y := b
ENDPROC
EXPORT PROC sum() OF vec IS self.x+self.y
EXPORT PROC scale(k) OF vec
  self.x := self.x*k
  self.y := self.y*k
ENDPROC`,
   `  DEF v=NIL:PTR TO vec
  NEW v.vec(10,32)
  WriteF('sum=\\d\\n', v.sum())
  v.scale(3)
  WriteF('scaled=\\d v=\\d\\n', v.sum(), IF v THEN 1 ELSE 0)
  END v
  WriteF('after=\\d\\n', IF v THEN 1 ELSE 0)`],

  ['destructor',
   `OPT MODULE
EXPORT OBJECT box
  id:LONG
ENDOBJECT
EXPORT PROC box(n) OF box
  self.id := n
ENDPROC
EXPORT PROC end() OF box
  WriteF('destroying \\d\\n', self.id)
ENDPROC
EXPORT PROC tag() OF box IS self.id`,
   `  DEF b=NIL:PTR TO box
  NEW b.box(7)
  WriteF('tag=\\d\\n', b.tag())
  END b
  WriteF('done\\n')`],

  ['multi_instance',
   `OPT MODULE
EXPORT OBJECT counter
  n:LONG
ENDOBJECT
EXPORT PROC counter(start) OF counter
  self.n := start
ENDPROC
EXPORT PROC bump() OF counter
  self.n := self.n+1
ENDPROC
EXPORT PROC val() OF counter IS self.n`,
   `  DEF a=NIL:PTR TO counter, b=NIL:PTR TO counter
  NEW a.counter(100)
  NEW b.counter(200)
  a.bump()
  a.bump()
  b.bump()
  WriteF('a=\\d b=\\d\\n', a.val(), b.val())
  END a
  END b`],
];

let pass = 0, fail = 0;
for (const [name, mod, body] of CASES) {
  const w = mkdtempSync(join(tmpdir(), `oop-${name}-`));
  const modn = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
  // the class module's first EXPORT OBJECT name is the class; derive module name
  // from a stable per-case name so the resolver/EC find it.
  const cls = (mod.match(/EXPORT OBJECT (\w+)/) || [])[1];
  writeFileSync(join(w, `${modn}.e`), mod.replace(/EXPORT OBJECT \w+/, `EXPORT OBJECT ${cls}`), 'latin1');
  ecBuild(w, MODROOT, `${modn}.e`);
  if (!existsSync(join(w, `${modn}.m`))) { console.log(`SKIP ${name}: EC could not build module`); continue; }

  const main = `MODULE '${modn}'\n\nPROC main()\n${body}\nENDPROC\n`;
  writeFileSync(join(w, 'ref.e'), main, 'latin1');

  // oracle: EC links + runs (module on the emodules path = w)
  let ecOut = '<ec compile failed>';
  ecBuild(w, w, 'ref.e');
  if (existsSync(join(w, 'ref'))) ecOut = run(w, 'ref');

  // ecomp links + runs the same module
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

  const ok = ecOut === ourOut && !ecOut.startsWith('<') && !ecOut.startsWith('ERR');
  if (ok) { console.log(`PASS ${name.padEnd(20)} ${JSON.stringify(ecOut)}`); pass++; }
  else { console.log(`FAIL ${name.padEnd(20)} EC=${JSON.stringify(ecOut)} ecomp=${JSON.stringify(ourOut)}`); fail++; }
}
console.log(`\n${pass}/${pass + fail} OOP class cases verified identical to EC`);
process.exit(fail ? 1 : 0);
