// Behavioral tests: compile fixture programs with the CLI, RUN the produced
// AmigaOS binaries under vamos (open-source m68k emulation, pip install
// amitools — no ROM needed), and compare stdout to golden .expected files.
// The goldens were verified byte-identical against the original 1997
// compiler by the dev-only differential suite.
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ECC = join(here, '..', '..', 'tools', 'ecc.js');
const BEH = join(here, 'behavior');
const FAKE = '*.library=mode:fake,version:40+dos.library=mode:auto+exec.library=mode:auto'
  + '+mathieeesingbas.library=mode:auto+mathieeesingtrans.library=mode:auto';

let vamos = 'vamos';
try { execSync(`${vamos} --help`, { stdio: 'ignore' }); }
catch {
  try { vamos = `${process.env.HOME}/.local/bin/vamos`; execSync(`${vamos} --help`, { stdio: 'ignore' }); }
  catch {
    console.log('SKIPPED: vamos not installed (pip install amitools) — behavioral tests need it');
    process.exit(0);
  }
}

let pass = 0, fail = 0;
const work = mkdtempSync(join(tmpdir(), 'ecomp-beh-'));
for (const f of readdirSync(BEH).filter(f => f.endsWith('.e')).sort()) {
  const name = basename(f, '.e');
  let expected;
  try { expected = readFileSync(join(BEH, name + '.expected'), 'latin1'); }
  catch { continue; }   // helper modules have no .expected
  copyFileSync(join(BEH, f), join(work, f));
  for (const aux of readdirSync(BEH).filter(x => x.endsWith('.e') && x !== f)) {
    copyFileSync(join(BEH, aux), join(work, aux));
  }
  try {
    execFileSync('node', [ECC, `--source=${join(work, f)}`, `--out=${join(work, name)}`, '--quiet'],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const out = execFileSync(vamos,
      ['-q', '-O', FAKE, '-V', `work:${work}`, '--cwd', 'work:', `work:${name}`],
      { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    if (out === expected) { pass++; console.log(`PASS ${name}`); }
    else {
      fail++;
      console.log(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(out)}`);
    }
  } catch (e) {
    fail++;
    console.log(`FAIL ${name} (crashed): ${(e.stdout ?? '') + (e.stderr ?? '') || e.message}`);
  }
}
rmSync(work, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} behavioral tests passed`);
process.exit(fail ? 1 : 0);
