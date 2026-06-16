// Run-verification of exec.library calls (sysbase) against the EC oracle.
//
// exec.library functions (AddTail/AddHead/Remove/Enqueue/…) read their base
// from a slot the lib interface names "sysbase". ecomp's fixed-offset globals
// table had execbase (-40, populated at startup) but NOT sysbase, so
// globalSlot('sysbase') allocated a fresh positive slot that startup never
// populated -> A6=0 -> jsr to garbage -> crash. Fixed by aliasing sysbase to
// the same -40 slot as execbase.
//
// Builds a priority list with tools/constructors (newlist/newnode) + AddTail
// and walks it — exercises the exec base.
//
//   node tools/exec-verify.js
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
const run = (w, b) => vamos(['-q', '-C', '68020', '-O', FAKE, '-V', `work:${w}`, '--cwd', 'work:', `work:${b}`]);

const MAIN = `MODULE 'tools/constructors', 'exec/lists', 'exec/nodes'
PROC main()
  DEF l:PTR TO lh, n:PTR TO ln
  l := newlist()
  AddTail(l, newnode(NIL, 'first', 0, 0))
  AddTail(l, newnode(NIL, 'second', 0, 0))
  AddTail(l, newnode(NIL, 'third', 0, 0))
  n := l.head
  WHILE n.succ
    WriteF('node: \\s\\n', n.name)
    n := n.succ
  ENDWHILE
ENDPROC
`;

if (!existsSync(VAMOS) || !existsSync(EC)) { console.log('SKIP: vamos/EC oracle not available'); process.exit(0); }

const w = mkdtempSync(join(tmpdir(), 'execv-'));
writeFileSync(join(w, 'main.e'), MAIN, 'latin1');

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
console.log(`${ok ? 'PASS' : 'FAIL'} exec.library calls (sysbase)  EC=${JSON.stringify(ec)} ecomp=${JSON.stringify(ours)}`);
process.exit(ok ? 0 : 1);
