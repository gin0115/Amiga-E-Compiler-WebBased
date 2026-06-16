// Run-verification of CROSS-MODULE PROC calls against the EC oracle.
//
// A binary .m can call a PROC exported by ANOTHER binary module: e.g.
// tools/simplelex calls tools/ctype's isalnum(). EC records this in MODINFO as
// a kind=proc reference, and the call site is a placeholder `jsr abs.L $0` the
// linker binds to the target proc. ecomp previously bound only MODINFO *class*
// references (parent-class builders / descriptors) and skipped proc references,
// leaving the jsr unbound -> jump to address 0 -> crash.
//
// simplelex lexes an in-memory buffer; lexing identifiers calls isalnum, so a
// successful run proves the cross-module proc call resolved.
//
//   node tools/xproc-verify.js
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

const MAIN = `MODULE 'tools/simplelex'
PROC main()
  DEF buf[40]:STRING, t, at
  StrCopy(buf, 'foo 123 baz')
  lex_init(buf, StrLen(buf), TRUE, "#")
  t := lex(); WriteF('t1=\\d\\n', t)   -> IDENT (calls ctype isalnum)
  t := lex(); WriteF('t2=\\d\\n', t)   -> INTEGER
  t := lex(); WriteF('t3=\\d\\n', t)   -> IDENT
ENDPROC
`;

if (!existsSync(VAMOS) || !existsSync(EC)) { console.log('SKIP: vamos/EC oracle not available'); process.exit(0); }

const w = mkdtempSync(join(tmpdir(), 'xproc-'));
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
console.log(`${ok ? 'PASS' : 'FAIL'} cross-module proc call  EC=${JSON.stringify(ec)} ecomp=${JSON.stringify(ours)}`);
process.exit(ok ? 0 : 1);
