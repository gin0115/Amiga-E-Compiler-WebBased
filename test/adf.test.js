// ADF (OFS) writer tests, focused on file EXTENSION blocks: a file header /
// extension block holds at most 72 data-block pointers, so any file bigger than
// ~34KB (72 * 488 bytes) must chain the rest through file extension blocks
// (T_LIST). Before this was implemented, addFile() threw and the IDE could not
// deliver larger programs (e.g. the 42KB EasyGUI examples) to a bootable floppy.
import { test, setFile } from './harness.js';
import { AdfWriter, bootableAdf } from '../src/adf.js';

setFile('adf.test.js');

const BSIZE = 512, DATA_BYTES = 488, HT_SIZE = 72;
const ROOT = 880;
const T_HEADER = 2, T_DATA = 8, T_LIST = 16;

// minimal OFS reader over the produced image
function reader(img) {
  const dv = new DataView(img.buffer, img.byteOffset, img.length);
  const r32 = (blk, i) => dv.getUint32(blk * BSIZE + i * 4, false);
  const bcplName = (blk) => {
    const off = blk * BSIZE + 0x1b0, len = img[off];
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(img[off + 1 + i]);
    return s;
  };
  // find an entry by name under a dir block (follows hash chain)
  const find = (dir, name) => {
    for (let slot = 6; slot < 6 + HT_SIZE; slot++) {
      let b = r32(dir, slot);
      while (b) {
        if (bcplName(b) === name) return b;
        b = r32(b, 124);
      }
    }
    return 0;
  };
  // collect every data-block pointer from the header + extension chain
  const dataPtrs = (header) => {
    const ptrs = [];
    const pull = (blk) => {
      const hi = r32(blk, 2);
      for (let i = 0; i < hi; i++) ptrs.push(r32(blk, 77 - i));
    };
    pull(header);
    let ext = r32(header, 126);
    const exts = [];
    while (ext) {
      if (r32(ext, 0) !== T_LIST) throw new Error('extension block bad type');
      exts.push(ext);
      pull(ext);
      ext = r32(ext, 126);
    }
    return { ptrs, exts };
  };
  // reconstruct file bytes by following the OFS next-data chain (long 4)
  const readFile = (header) => {
    const out = [];
    let db = r32(header, 4);
    while (db) {
      const n = r32(db, 3);
      for (let i = 0; i < n; i++) out.push(img[db * BSIZE + 24 + i]);
      db = r32(db, 4);
    }
    return Uint8Array.from(out);
  };
  return { r32, bcplName, find, dataPtrs, readFile };
}

function pattern(n) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 7 + 3) & 0xff;
  return a;
}

test('small file (<=72 blocks) round-trips with no extension block', (assert) => {
  const data = pattern(20 * DATA_BYTES + 17);   // 21 blocks
  const w = new AdfWriter('SMALL');
  const header = w.addFile('prog', data);
  const img = w.finish();
  const R = reader(img);
  const h = R.find(ROOT, 'prog');
  assert.equal(h, header);
  assert.equal(R.r32(h, 126), 0, 'no extension block expected');
  assert.equal(R.r32(h, 2), 21, 'high_seq = block count');
  assert.deepEqual(R.readFile(h), data);
});

test('large file (>72 blocks) chains through extension blocks', (assert) => {
  const nblocks = 164;                            // 72 + 72 + 20 -> two ext blocks
  const data = pattern((nblocks - 1) * DATA_BYTES + 100);
  const w = new AdfWriter('BIG');
  const header = w.addFile('prog', data);
  const img = w.finish();
  const R = reader(img);
  const h = R.find(ROOT, 'prog');
  assert.equal(R.r32(h, 0), T_HEADER);
  assert.equal(R.r32(h, 2), HT_SIZE, 'header holds exactly 72 pointers');
  assert.notEqual(R.r32(h, 126), 0, 'extension block expected');
  const { ptrs, exts } = R.dataPtrs(h);
  assert.equal(exts.length, 2, 'two extension blocks');
  assert.equal(ptrs.length, nblocks, 'all data blocks referenced');
  // every extension block points back to the file header as its parent
  for (const e of exts) assert.equal(R.r32(e, 125), h);
  // byte-exact reconstruction
  assert.deepEqual(R.readFile(h), data);
  assert.equal(R.r32(h, 81), data.length, 'byte_size recorded');
});

test('bootableAdf delivers a 42KB program (the EasyGUI-sized case)', (assert) => {
  const bin = pattern(42004);                     // ~86 blocks -> 1 extension block
  const img = bootableAdf(bin, { volume: 'EGTEST', command: 'prog' });
  const R = reader(img);
  const h = R.find(ROOT, 'prog');
  assert.notEqual(h, 0, 'prog present in root');
  assert.notEqual(R.r32(h, 126), 0, 'needs an extension block');
  assert.deepEqual(R.readFile(h), bin, 'program bytes intact');
  // startup-sequence still lands under s/
  const s = R.find(ROOT, 's');
  assert.notEqual(s, 0);
  assert.notEqual(R.find(s, 'startup-sequence'), 0);
});
