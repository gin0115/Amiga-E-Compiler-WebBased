// Run-verification of BINARY-PROC DEFAULT ARGUMENTS against the EC oracle.
//
// tools/file's readfile/3 and writefile/3 take args WITH DEFAULTS but are
// normally called with fewer (readfile('name')). A binary proc reads ALL its
// declared params from fixed stack offsets, so the caller must push the default
// values for omitted trailing args. ecomp previously discarded the .m's default
// values and pushed only the provided args, misaligning the stack — readfile
// then read an empty filename, locked the current dir, and threw "OPEN".
//
//   node tools/file-verify.js
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

// writefile/3 + readfile/3 both called with fewer args than declared -> exercises
// the default-arg push at the call site.
const MAIN = `MODULE 'tools/file'
PROC main() HANDLE
  DEF buf[20]:STRING, m=NIL, len, n
  StrCopy(buf, 'one\\ntwo\\nthree\\n')
  writefile('fv.txt', buf, EstrLen(buf))
  m, len := readfile('fv.txt')
  n := countstrings(m, len)
  WriteF('len=\\d strings=\\d\\n', len, n)
  IF m THEN freefile(m)
EXCEPT DO
  WriteF('exc=\\d\\n', exception)
ENDPROC
`;

if (!existsSync(VAMOS) || !existsSync(EC)) { console.log('SKIP: vamos/EC oracle not available'); process.exit(0); }

const w = mkdtempSync(join(tmpdir(), 'filev-'));
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
console.log(`${ok ? 'PASS' : 'FAIL'} binary-proc default args (tools/file)  EC=${JSON.stringify(ec)} ecomp=${JSON.stringify(ours)}`);
process.exit(ok ? 0 : 1);
