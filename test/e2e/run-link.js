// Binary code-module linking tests: compile a main program that imports a
// precompiled binary .m code module, link it with the CLI, RUN the produced
// AmigaOS binary under vamos, and compare stdout to a golden .expected file.
//
// Fixtures live in test/e2e/link/: a `<name>.e` main program, its
// `<name>.expected` golden output, and any `.m` binary modules it imports
// (copied alongside so the resolver finds them). The .m modules were built by
// the original 1997 compiler (ECDEMO); this exercises ecomp's LINKER, not its
// code generator, so vamos running the result is the proof.
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ECC = join(here, '..', '..', 'tools', 'ecc.js');
const DIR = join(here, 'link');
const FAKE = '*.library=mode:fake,version:40+dos.library=mode:auto+exec.library=mode:auto'
  + '+mathieeesingbas.library=mode:auto+mathieeesingtrans.library=mode:auto';

const candidates = [
  process.env.VAMOS_BIN, 'vamos', `${process.env.HOME}/.local/bin/vamos`,
  '/opt/pipx_bin/vamos', `${process.env.HOME}/.local/pipx/venvs/amitools/bin/vamos`,
];
let vamos = null;
for (const c of candidates.filter(Boolean)) {
  try { execSync(`"${c}" --help`, { stdio: 'ignore' }); vamos = c; break; } catch { /* next */ }
}
if (!vamos) {
  if (process.env.REQUIRE_VAMOS) {
    console.error('FAIL: vamos not found but REQUIRE_VAMOS is set');
    process.exit(1);
  }
  console.log('SKIPPED: vamos not installed — module-linking tests need it');
  process.exit(0);
}
console.log(`using vamos: ${vamos}`);

const files = readdirSync(DIR);
const mods = files.filter(f => f.endsWith('.m'));
let pass = 0, fail = 0;
const work = mkdtempSync(join(tmpdir(), 'ecomp-link-'));
for (const f of mods) copyFileSync(join(DIR, f), join(work, f));   // modules on the resolver path

for (const f of files.filter(f => f.endsWith('.e')).sort()) {
  const name = basename(f, '.e');
  let expected;
  try { expected = readFileSync(join(DIR, `${name}.expected`), 'latin1'); }
  catch { continue; }                                            // helper, no golden
  copyFileSync(join(DIR, f), join(work, f));
  try {
    execFileSync('node', [ECC, '--quiet', join(work, f), '-o', join(work, name)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    // -C 68020: the A1200 target; ported intrinsic thunks use 68020 ops (MULS.L…)
    const out = execFileSync(vamos, ['-q', '-C', '68020', '-O', FAKE, '-V', `work:${work}`, '--cwd', 'work:', `work:${name}`],
      { timeout: 30000, encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] });
    if (out === expected) { console.log(`PASS link ${name}`); pass++; }
    else { console.log(`FAIL link ${name}: got ${JSON.stringify(out)} want ${JSON.stringify(expected)}`); fail++; }
  } catch (e) {
    console.log(`FAIL link ${name}: ${e.message.split('\n')[0]}`);
    fail++;
  }
}
console.log(`\n${pass}/${pass + fail} link tests passed`);
process.exit(fail ? 1 : 0);
