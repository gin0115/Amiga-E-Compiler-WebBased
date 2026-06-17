import { test } from './harness.js';
import { Asm, pushMask, popMask, D0, D1, D2, D3, D4, A0, A1, A2, A5, A6, A7 } from '../src/asm68k.js';
import { writeHunk } from '../src/hunk.js';

function bytes(fn) {
  const a = new Asm();
  fn(a);
  return [...a.finish()].map(b => b.toString(16).padStart(2, '0')).join(' ');
}

// big-endian longwords of a hunk image
function longs(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const r = [];
  for (let i = 0; i + 4 <= u8.length; i += 4) r.push(dv.getUint32(i, false) >>> 0);
  return r;
}

test('moveq', a => {
  a.equal(bytes(x => { x.moveq(1, D0); x.moveq(-1, D1); }), '70 01 72 ff');
});

test('move.l immediate and register moves', a => {
  a.equal(bytes(x => x.movel_imm(0x2710, D0)), '20 3c 00 00 27 10');
  a.equal(bytes(x => { x.movel_dd(D0, D1); x.movel_da(D0, A6); x.movel_ad(A6, D0); }), '22 00 2c 40 20 0e');
});

test('stack push/pop', a => {
  a.equal(bytes(x => { x.movel_d_push(D0); x.movel_pop_d(D0); }), '2f 00 20 1f');
  a.equal(bytes(x => { x.movel_d_push(D2); x.movel_pop_d(D1); }), '2f 02 22 1f');
});

test('memory via address registers', a => {
  a.equal(bytes(x => { x.movel_d_ind(D0, A0); x.movel_ind_d(A0, D0); }), '20 80 20 10');
  a.equal(bytes(x => x.movel_disp_d(8, A5, D0)), '20 2d 00 08');
  a.equal(bytes(x => x.movel_d_disp(D0, -4, A5)), '2b 40 ff fc');
  a.equal(bytes(x => x.movel_absw_a(4, A6)), '2c 78 00 04');
});

test('lea absolute-long with fixup (far-reach)', a => {
  // lea s.L,a1 — absolute long (43 f9) + 32-bit address resolved to s's hunk
  // offset (6, just after the 6-byte instruction). Reaches the whole hunk.
  a.equal(bytes(x => { x.lea_pc('s', A1); x.label('s'); x.ascii('AB'); }), '43 f9 00 00 00 06 41 42');
});

test('arithmetic', a => {
  a.equal(bytes(x => { x.addl_dd(D1, D0); x.subl_dd(D1, D0); x.cmpl_dd(D1, D0); }), 'd0 81 90 81 b0 81');
  a.equal(bytes(x => { x.andl_dd(D1, D0); x.orl_dd(D1, D0); }), 'c0 81 80 81');
  a.equal(bytes(x => { x.negl(D0); x.tstl(D0); x.extw(D0); x.extl(D0); }), '44 80 4a 80 48 80 48 c0');
  a.equal(bytes(x => { x.addql(1, D2); x.addql(8, D0); }), '52 82 50 80');
});

test('jsr displacement (library calls)', a => {
  // jsr -552(a6) = OpenLibrary — matches the 4e ae fd d8 in real binaries
  a.equal(bytes(x => x.jsr_disp(-552, A6)), '4e ae fd d8');
  a.equal(bytes(x => x.jsr_disp(-60, A6)), '4e ae ff c4');
});

test('flow: rts, link/unlk, branches', a => {
  a.equal(bytes(x => x.rts()), '4e 75');
  a.equal(bytes(x => { x.link(A5, 8); x.unlk(A5); }), '4e 55 ff f8 4e 5d');
  // forward beq over a moveq: disp counted from extension word
  a.equal(bytes(x => { x.beq('end'); x.moveq(0, D0); x.label('end'); x.rts(); }),
    '67 00 00 04 70 00 4e 75');
  // backward bra: disp relative to extension word address (2+2=4 → 0-4=-4)
  a.equal(bytes(x => { x.label('top'); x.moveq(0, D0); x.bra('top'); }), '70 00 60 00 ff fc');
});

test('scc + ext to E booleans', a => {
  a.equal(bytes(x => { x.cmpl_dd(D1, D0); x.scc(Asm.COND.EQ, D0); x.extw(D0); x.extl(D0); }),
    'b0 81 57 c0 48 80 48 c0');
});

test('movem and dbra for runtime helpers', a => {
  a.equal(bytes(x => x.movem_push(pushMask(D2, D3, D4))), '48 e7 38 00');
  a.equal(bytes(x => x.movem_pop(popMask(D2, D3, D4))), '4c df 00 1c');
  a.equal(bytes(x => { x.label('l'); x.dbra(D3, 'l'); }), '51 cb ff fe');
});

test('shifts and addx (mul/div helpers)', a => {
  a.equal(bytes(x => { x.asll_imm(1, D2); x.lsrl_imm(1, D1); x.addxl_dd(D4, D4); }),
    'e3 82 e2 89 d9 84');
});

test('byte ops for string runtime', a => {
  a.equal(bytes(x => { x.moveb_postinc_d(A0, D0); x.moveb_d_postinc(D0, A2); }), '10 18 14 c0');
});

test('data and alignment', a => {
  a.equal(bytes(x => x.asciiz('Hi\n')), '48 69 0a 00');
  a.equal(bytes(x => x.ascii('A')), '41 00'); // padded to even
});

test('byte/word memory ops', a => {
  a.equal(bytes(x => { x.moveb_disp_d(3, A0, D0); x.movew_disp_d(2, A0, D1); }), '10 28 00 03 32 28 00 02');
  a.equal(bytes(x => { x.moveb_d_disp(D0, 3, A0); x.movew_d_disp(D1, -2, A5); }), '11 40 00 03 3b 41 ff fe');
  a.equal(bytes(x => x.movew_imm_disp(80, -86, A5)), '3b 7c 00 50 ff aa');
  a.equal(bytes(x => { x.clrb_disp(4, A5); x.clrw_disp(-2, A0); }), '42 2d 00 04 42 68 ff fe');
  a.equal(bytes(x => { x.addal_d(D0, A0); x.moveb_ind_postinc(A0, A2); }), 'd1 c0 14 d8');
  a.equal(bytes(x => { x.mulsw_dd(D1, D0); x.divsw_dd(D1, D0); }), 'c1 c1 81 c1');
});

test('undefined label throws', a => {
  const x = new Asm();
  x.bra('nowhere');
  let threw = false;
  try { x.finish(); } catch { threw = true; }
  a.ok(threw);
});

// ---- Stage 1: relocations + absolute calls (binary-module linking) ----

test('jsr_abs emits jsr xxx.L with the absolute target and a reloc', a => {
  const x = new Asm();
  x.labelAt('mod', 0x1234);
  x.jsr_abs('mod');
  const code = x.finish();
  a.equal([...code].map(b => b.toString(16).padStart(2, '0')).join(' '),
    '4e b9 00 00 12 34');
  a.deepEqual(x.relocs, [2]);          // the 32-bit field sits at offset 2
});

test('blob + labelAt: a call resolves into appended module code', a => {
  const x = new Asm();
  x.jsr_abs('proc_foo');               // field at offset 2
  x.rts();                             // 4e 75 at offset 6
  const base = x.pc;                   // 8
  x.blob(new Uint8Array([0x4e, 0x75])); // module body (rts) at 8
  x.labelAt('proc_foo', base);
  const code = x.finish();
  a.equal([...code].map(b => b.toString(16).padStart(2, '0')).join(' '),
    '4e b9 00 00 00 08 4e 75 4e 75');
  a.deepEqual(x.relocs, [2]);
});

test('reloc32At records a module-internal reloc', a => {
  const x = new Asm();
  x.blob(new Uint8Array([0, 0, 0, 0]));
  x.reloc32At(0);
  x.finish();
  a.deepEqual(x.relocs, [0]);
});

test('writeHunk: no relocs => no HUNK_RELOC32 (unchanged single-hunk image)', a => {
  const code = new Uint8Array([0x4e, 0x75, 0, 0]); // 1 long
  const out = longs(writeHunk(code));
  // header(3f3),0,1,0,0,1, CODE(3e9),1,<rts pad>, END(3f2)
  a.deepEqual(out, [0x3f3, 0, 1, 0, 0, 1, 0x3e9, 1, 0x4e750000, 0x3f2]);
});

test('writeHunk: relocs => HUNK_RELOC32 block', a => {
  const code = new Uint8Array(8);      // 2 longs
  const out = longs(writeHunk(code, [4, 0]));
  // ... CODE,2,<8 bytes=2 longs>, RELOC32(3ec), count 2, hunk 0, offs 0 & 4, end 0, END
  a.deepEqual(out, [
    0x3f3, 0, 1, 0, 0, 2, 0x3e9, 2, 0, 0,
    0x3ec, 2, 0, 0, 4, 0, 0x3f2,
  ]);
});
