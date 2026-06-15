import { test } from './harness.js';
import { readEmod } from '../src/emod.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mod = name => readEmod(
  new Uint8Array(readFileSync(join(here, '..', 'modules', name))), name);

// tools/EasyGUI.m is the canonical CODE module: SYS + CODE + RELOC + PROCS +
// GLOBS + OBJ(methods) + CONST + MODINFO. Every value below is ground truth.
const eg = mod('tools/EasyGUI.m');

test('code module: header + clean parse', a => {
  a.equal(eg.version, 10);
  a.equal(eg.osvers, 37);
  a.equal(eg.isCodeModule, true);
  a.equal(eg.partial, false);
  a.equal(eg.error, null);
});

test('code module: CODE section', a => {
  a.equal(eg.codeWords, 6008);
  a.ok(eg.code instanceof Uint8Array);
  a.equal(eg.code.length, 24032);          // 6008 * 4
  a.equal(eg.code[0], 0x4e);               // LINK A5,#..  (0x4E55) prologue
  a.equal(eg.code[1], 0x55);
});

test('code module: PROCS export table', a => {
  a.equal(eg.procs.length, 49);
  const egA = eg.procs.find(p => p.name === 'easyguiA');
  a.ok(egA, 'easyguiA present');
  a.equal(egA.kind, 'proc');
  a.equal(egA.args, 3);
  a.equal(egA.offset, 1478);
  a.ok(egA.offset < eg.code.length);
  // the source-level call easygui(...) maps to the A-mangled vararg entry;
  // there is no bare `easygui` symbol
  a.equal(eg.procs.find(p => p.name === 'easygui'), undefined);
  const fb = eg.procs.find(p => p.name === 'easygui_fallbackA');
  a.ok(fb && fb.args === 3 && fb.offset === 1652);
});

test('code module: RELOC (1 abs + 91 ifunc)', a => {
  a.equal(eg.relocs.length, 92);
  const abs = eg.relocs.filter(r => r.kind === 'abs');
  const ifn = eg.relocs.filter(r => r.kind === 'ifunc');
  a.equal(abs.length, 1);
  a.equal(ifn.length, 91);
  a.equal(abs[0].offset, 0x6ee);
  // each ifunc reloc fixes up a `jsr abs.l` (0x4EB9) two bytes before its offset
  const one = ifn[0];
  a.equal(eg.code[one.offset - 2], 0x4e);
  a.equal(eg.code[one.offset - 1], 0xb9);
  // the raw low byte at offset+3 is the intrinsic table number (WriteF=10…)
  a.equal(one.ifuncNum, eg.code[one.offset + 3]);
  a.ok(one.ifuncNum >= 10);
});

test('code module: GLOBS xrefs + drels', a => {
  a.equal(eg.globs.xrefs.length, 2);
  const wb = eg.globs.xrefs.find(x => x.name === 'workbenchbase');
  const gt = eg.globs.xrefs.find(x => x.name === 'gadtoolsbase');
  a.ok(wb && wb.refs.length === 4);
  a.ok(gt && gt.refs.length === 18);
  a.equal(eg.globs.drels.length, 1);
  a.equal(eg.globs.drels[0].refs.length, 16);
  a.equal(eg.globalsCount, 16);
  // every code ref lands inside the code section
  for (const x of eg.globs.xrefs) for (const off of x.refs) a.ok(off < eg.code.length);
});

test('code module: interface (consts/objects) still captured', a => {
  // EasyGUI also exports constants (ROWS, BUTTON, …) and structs
  a.ok(eg.consts.size > 100);
  a.ok(eg.objects.size >= 3);
});

// Regression: a pure interface module yields no code-module fields and the
// same const/object surface as before.
test('interface module: no code fields', a => {
  const it = mod('intuition/intuition.m');
  a.equal(it.isCodeModule, false);
  a.equal(it.code, null);
  a.equal(it.codeWords, 0);
  a.equal(it.procs.length, 0);
  a.equal(it.relocs.length, 0);
  a.ok(it.consts.size > 0);
  a.ok(it.objects.has('window'));          // classic intuition struct
});
