// Run-verification of CROSS-MODULE class inheritance against the EC oracle.
// A child class in one binary .m extends a parent class in another .m; the
// child's descriptor-builder calls the parent's builder (a cross-module call
// recorded in MODINFO, which ecomp must transitively link + bind). Build both
// modules with EC, then a main program with EC and ecomp, run both, compare.
//
//   node tools/xmod-verify.js
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
  try { return execFileSync(VAMOS, args, { timeout: 60000, encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return 'ERR ' + ((e.stdout ?? '') + (e.stderr ?? '')).split('\n')[0]; }
}
const ecBuild = (w, f) => vamos(['-q', '-V', `work:${w}`, '-V', `mods:${MODS}`, '-a', 'emodules:work:+mods:',
  '-V', `bin:${EC}`, '--cwd', 'work:', 'bin:EC', f]);
const run = (w, b) => vamos(['-q', '-C', '68020', '-O', FAKE, '-V', `work:${w}`, '--cwd', 'work:', `work:${b}`]);

const SHAPE = `OPT MODULE
EXPORT OBJECT shape
  kind:LONG
ENDOBJECT
EXPORT PROC shape(k) OF shape
  self.kind := k
ENDPROC
EXPORT PROC kindof() OF shape IS self.kind`;

const CIRCLE = `OPT MODULE
MODULE 'shape'
EXPORT OBJECT circle OF shape
  radius:LONG
ENDOBJECT
EXPORT PROC circle(r) OF circle
  self.shape(7)
  self.radius := r
ENDPROC
EXPORT PROC area() OF circle IS self.radius*self.radius*3`;

const MAIN = `MODULE 'circle'
PROC main()
  DEF c=NIL:PTR TO circle
  NEW c.circle(5)
  WriteF('kind=\\d area=\\d\\n', c.kindof(), c.area())
  END c
ENDPROC
`;

const w = mkdtempSync(join(tmpdir(), 'xmod-'));
writeFileSync(join(w, 'shape.e'), SHAPE, 'latin1');
writeFileSync(join(w, 'circle.e'), CIRCLE, 'latin1');
writeFileSync(join(w, 'main.e'), MAIN, 'latin1');
ecBuild(w, 'shape.e');
ecBuild(w, 'circle.e');
if (!existsSync(join(w, 'circle.m'))) { console.log('SKIP: EC could not build the modules'); process.exit(0); }

let ec = '<ec build failed>';
ecBuild(w, 'main.e');
if (existsSync(join(w, 'main'))) ec = run(w, 'main');

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

const ok = ec === ours && !ec.startsWith('<') && !ec.startsWith('ERR');
console.log(`${ok ? 'PASS' : 'FAIL'} cross-module inheritance  EC=${JSON.stringify(ec)} ecomp=${JSON.stringify(ours)}`);
process.exit(ok ? 0 : 1);
