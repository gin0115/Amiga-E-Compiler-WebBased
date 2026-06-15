// Run-verification of EVERY binary CLASS module against the real EC oracle.
// For each class module, auto-generate a program that does `NEW obj.ctor(...)`
// (constructor dispatch + descriptor build + allocate) then `END obj`
// (destructor dispatch + dispose), compile it with BOTH EC (oracle) and ecomp,
// RUN both under vamos, and compare stdout. ecomp must behave identically to EC
// — including when both error — so any ecomp-only crash/divergence is a real
// dispatch/ABI bug.
//
//   node tools/oop-corpus.js [substring-filter]
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
const EC = join(RES, 'ec33a/ec33a');
const MODROOT = join(process.cwd(), 'modules');
const FAKE = '*.library=mode:fake,version:40+dos.library=mode:auto+exec.library=mode:auto';
const FILTER = process.argv[2] || '';

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith('.m')) out.push(p);
  }
  return out;
}
function vamos(args, ms = 20000) {
  try { return execFileSync(VAMOS, args, { timeout: ms, encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) {
    if (e.killed) return 'TIMEOUT';
    return 'ERR ' + ((e.stdout ?? '') + (e.stderr ?? '')).split('\n').find(l => /ERROR|error|abort/.test(l)) ?? 'ERR';
  }
}
const ecBuild = (w, mods, file) => vamos(['-q', '-V', `work:${w}`, '-V', `mods:${mods}`, '-V', `bin:${EC}`,
  '-a', 'emodules:mods:', '--cwd', 'work:', 'bin:EC', file]);
const run = (w, bin) => vamos(['-q', '-C', '68020', '-O', FAKE, '-V', `work:${w}`, '--cwd', 'work:', `work:${bin}`]);
// normalise vamos chatter to a stable token so EC vs ecomp compare on behaviour
const norm = s => s == null ? '' : s.startsWith('TIMEOUT') ? 'TIMEOUT'
  : /ERROR in CPU|Invalid Memory|vamos failed|abort/.test(s) ? 'CRASH'
  : s.replace(/^\d\d:\d\d:\d\d\.\d+.*$/gm, '').trim();

// classes: { module-import-name, className, ctorArgs }
const classes = [];
for (const f of walk(MODROOT)) {
  let m; try { m = readEmod(readFileSync(f), f); } catch { continue; }
  for (const [cn, o] of m.objects) {
    if (!(o.methods && o.methods.length)) continue;
    const ctor = o.methods.find(me => me.name === cn);
    const impName = relative(MODROOT, f).replace(/\.m$/, '');
    classes.push({ mod: impName, cls: cn, ctorArgs: ctor ? ctor.args : 0 });
  }
}
const filtered = classes.filter(c => (c.mod + ' ' + c.cls).toLowerCase().includes(FILTER.toLowerCase()));
console.log(`${filtered.length} classes (of ${classes.length}) ${FILTER ? `matching "${FILTER}"` : ''}\n`);

let match = 0, differ = 0, ecFail = 0;
const diffs = [];
for (const c of filtered) {
  const w = mkdtempSync(join(tmpdir(), `ooc-`));
  const args = Array(c.ctorArgs).fill('NIL').join(',');
  const main = `MODULE '${c.mod}'\n\nPROC main()\n  DEF o=NIL:PTR TO ${c.cls}\n  NEW o.${c.cls}(${args})\n  END o\n  WriteF('ok\\n')\nENDPROC\n`;
  writeFileSync(join(w, 'ref.e'), main, 'latin1');

  // oracle: EC compiles using ecomp's full module tree (MODROOT) on the path
  ecBuild(w, MODROOT, 'ref.e');
  let ec = existsSync(join(w, 'ref')) ? norm(run(w, 'ref')) : '<ecbuild>';

  let ours = '<ecomp>';
  try {
    const { program } = parse(main, 'main.e');
    const sem = analyze(program, { resolveModule: makeResolver(w, [MODROOT]) });
    if (sem.errors.length) ours = '<sem:' + sem.errors[0].msg + '>';
    else {
      const { bin, errors } = compileProgram(program, sem);
      if (errors.length) ours = '<cg:' + errors[0].msg + '>';
      else { writeFileSync(join(w, 'ours'), bin); ours = norm(run(w, 'ours')); }
    }
  } catch (e) { ours = '<' + e.message + '>'; }

  if (ec === '<ecbuild>') { ecFail++; console.log(`SKIP ${c.mod.padEnd(40)} (EC could not build)`); continue; }
  if (ec === ours) { match++; console.log(`MATCH ${c.mod.padEnd(40)} ${JSON.stringify(ec).slice(0, 40)}`); }
  else { differ++; diffs.push(c.mod); console.log(`DIFF  ${c.mod.padEnd(40)} EC=${JSON.stringify(ec).slice(0,30)} ecomp=${JSON.stringify(ours).slice(0,40)}`); }
}
console.log(`\nmatch ${match} | differ ${differ} | EC-couldn't-build ${ecFail}  (of ${filtered.length})`);
if (diffs.length) console.log('DIFFERS:', diffs.join(', '));
