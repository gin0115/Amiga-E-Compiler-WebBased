// Run-verification of the WriteF \h (hex) format specifier against EC, plus
// other/bitfield (lshr). ecomp's __format engine handled \d/\s/\c but not \h,
// emitting the literal "\h"; now it converts to uppercase hex with no leading
// zeros, matching E's WriteF \h.
//
//   node tools/hex-verify.js
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

const MAIN = `MODULE 'other/bitfield'
PROC main()
  WriteF('\\h \\h \\h \\h \\h\\n', $FF0, 255, $ABCDEF, 0, 10)
  WriteF('lshr=\\h\\n', lshr($FF00, 4))
ENDPROC
`;

if (!existsSync(VAMOS) || !existsSync(EC)) { console.log('SKIP: vamos/EC oracle not available'); process.exit(0); }

const w = mkdtempSync(join(tmpdir(), 'hexv-'));
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
console.log(`${ok ? 'PASS' : 'FAIL'} WriteF \\h hex + other/bitfield  EC=${JSON.stringify(ec)} ecomp=${JSON.stringify(ours)}`);
process.exit(ok ? 0 : 1);
