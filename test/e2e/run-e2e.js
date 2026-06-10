// End-to-end tests: drive the real CLI (tools/ecc.js) as a subprocess on
// fixture .e files and assert on exit codes and produced artifacts.
// Runs without the research corpus or vamos — suitable for CI.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ECC = join(here, '..', '..', 'tools', 'ecc.js');
const FIX = join(here, 'fixtures');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
function run(args, opts = {}) {
  // capture stderr too: expected-failure fixtures print diagnostics, which
  // must not leak into the CI log as if they were our own errors
  try {
    const out = execFileSync('node', [ECC, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const u32 = (buf, off) => buf.readUInt32BE(off);

const work = mkdtempSync(join(tmpdir(), 'ecomp-e2e-'));

check('compiles hello.e to an AmigaOS hunk executable', () => {
  const out = join(work, 'hello');
  const r = run([`--source=${join(FIX, 'hello.e')}`, `--out=${out}`]);
  assert(r.status === 0, `exit ${r.status}: ${r.out}`);
  const bin = readFileSync(out);
  assert(u32(bin, 0) === 0x3f3, 'missing HUNK_HEADER');
  assert(u32(bin, 24) === 0x3e9, 'missing HUNK_CODE');
  assert(u32(bin, bin.length - 4) === 0x3f2, 'missing HUNK_END');
  assert(bin.includes(Buffer.from('Hello, e2e!')), 'string data missing');
  assert(bin.includes(Buffer.from('Wouter van Oortmerssen')), 'credit missing');
});

check('-o positional form still works', () => {
  const out = join(work, 'hello2');
  const r = run([join(FIX, 'hello.e'), '-o', out]);
  assert(r.status === 0, `exit ${r.status}`);
  assert(existsSync(out), 'no output');
});

check('compilation is deterministic', () => {
  const a = join(work, 'd1'), b = join(work, 'd2');
  run([`--source=${join(FIX, 'hello.e')}`, `--out=${a}`]);
  run([`--source=${join(FIX, 'hello.e')}`, `--out=${b}`]);
  assert(readFileSync(a).equals(readFileSync(b)), 'outputs differ between runs');
});

check('broad feature program compiles (modules/oop/floats/exceptions)', () => {
  const out = join(work, 'features');
  const r = run([`--source=${join(FIX, 'features.e')}`, `--out=${out}`]);
  assert(r.status === 0, `exit ${r.status}: ${r.out}`);
  assert(readFileSync(out).length > 1000, 'suspiciously small binary');
});

check('OPT MODULE source produces a readable EMOD .m', async () => {
  copyFileSync(join(FIX, 'iface.e'), join(work, 'iface.e'));
  const r = run([`--source=${join(work, 'iface.e')}`]);
  assert(r.status === 0, `exit ${r.status}: ${r.out}`);
  const m = readFileSync(join(work, 'iface.m'));
  assert(m.subarray(0, 4).toString() === 'EMOD', 'bad magic');
});

check('.m round-trips through our reader', async () => {
  const { readEmod } = await import('../../src/emod.js');
  const mod = readEmod(new Uint8Array(readFileSync(join(work, 'iface.m'))), 'iface');
  assert(mod.consts.get('E2E_MAGIC') === 4711, 'const lost');
  assert(mod.objects.get('pair')?.size === 8, 'object lost');
});

check('multi-file project: MODULE \'*helpermod\' from sibling source', () => {
  copyFileSync(join(FIX, 'usesmod.e'), join(work, 'usesmod.e'));
  copyFileSync(join(FIX, 'helpermod.e'), join(work, 'helpermod.e'));
  const out = join(work, 'usesmod.bin');
  const r = run([`--source=${join(work, 'usesmod.e')}`, `--out=${out}`]);
  assert(r.status === 0, `exit ${r.status}: ${r.out}`);
  assert(u32(readFileSync(out), 0) === 0x3f3, 'not a hunk executable');
});

check('parse errors exit 1 with file:line diagnostics', () => {
  const r = run([`--source=${join(FIX, 'broken.e')}`, `--out=${join(work, 'x')}`]);
  assert(r.status === 1, `expected exit 1, got ${r.status}`);
  assert(/broken\.e:\d+:\d+/.test(r.out), `no diagnostics in: ${r.out}`);
});

check('missing main() exits 1 with a clear message', () => {
  const r = run([`--source=${join(FIX, 'nomain.e')}`, `--out=${join(work, 'x2')}`]);
  assert(r.status === 1, `expected exit 1, got ${r.status}`);
  assert(/main/i.test(r.out), `message unclear: ${r.out}`);
});

check('--help exits 0, no args exits 1', () => {
  assert(run(['--help']).status === 0, '--help should exit 0');
  assert(run([]).status === 1, 'no args should exit 1');
});

check('--adf writes a bootable 880K floppy image', () => {
  const out = join(work, 'h3'), adf = join(work, 'h3.adf');
  const r = run([`--source=${join(FIX, 'hello.e')}`, `--out=${out}`, `--adf=${adf}`]);
  assert(r.status === 0, `exit ${r.status}: ${r.out}`);
  const img = readFileSync(adf);
  assert(img.length === 901120, `wrong ADF size ${img.length}`);
  assert(img.subarray(0, 3).toString() === 'DOS', 'not a DOS bootblock');
});

check('--quiet suppresses chatter', () => {
  const r = run([`--source=${join(FIX, 'hello.e')}`, `--out=${join(work, 'h4')}`, '--quiet']);
  assert(r.status === 0, `exit ${r.status}`);
  assert(r.out.trim() === '', `expected silence, got: ${r.out}`);
});

check('--moduledir finds .m modules in extra dirs', () => {
  // build the interface module in a separate dir, import it by plain name
  copyFileSync(join(FIX, 'iface.e'), join(work, 'iface2.e'));
  run([`--source=${join(work, 'iface2.e')}`]);
  const mdir = join(work, 'mods');
  mkdirSync(mdir, { recursive: true });
  copyFileSync(join(work, 'iface2.m'), join(mdir, 'iface2.m'));
  rmSync(join(work, 'iface2.m'));
  writeFileSync(join(work, 'usesiface.e'),
    "MODULE 'iface2'\nPROC main()\n  WriteF('\\d\\n', E2E_MAGIC)\nENDPROC\n");
  const r = run([`--source=${join(work, 'usesiface.e')}`, `--out=${join(work, 'ui')}`, `--moduledir=${mdir}`]);
  assert(r.status === 0, `exit ${r.status}: ${r.out}`);
});

check('--version prints a version', () => {
  const r = run(['--version']);
  assert(r.status === 0 && /ecc \(ecomp\) \d/.test(r.out), r.out);
});

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} e2e tests passed`);
process.exit(fail ? 1 : 0);
