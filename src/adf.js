// Bootable ADF (OFS / DOS\0) floppy image writer, pure browser JS.
// Layout per the AmigaDOS disk format: bootblock with the classic
// dos.library FindResident bootcode, root block 880, one bitmap block,
// then file/dir blocks allocated upward from 882.
const BLOCKS = 1760, BSIZE = 512;
const T_HEADER = 2, T_DATA = 8, T_LIST = 16;
const ST_ROOT = 1, ST_USERDIR = 2, ST_FILE = -3;
const HT_SIZE = 72, DATA_BYTES = 488;
const ROOT = 880, BITMAP = 881;

// classic 1.x bootcode: FindResident('dos.library') -> rt_Init
const BOOTCODE = [
  0x43, 0xfa, 0x00, 0x18,             // lea dosname(pc),a1
  0x4e, 0xae, 0xff, 0xa0,             // jsr -96(a6)  FindResident
  0x4a, 0x80,                         // tst.l d0
  0x67, 0x0a,                         // beq.s fail
  0x20, 0x40,                         // movea.l d0,a0
  0x20, 0x68, 0x00, 0x16,             // movea.l 22(a0),a0  rt_Init
  0x70, 0x00,                         // moveq #0,d0
  0x4e, 0x75,                         // rts
  0x70, 0xff,                         // fail: moveq #-1,d0
  0x4e, 0x75,                         // rts
  0x64, 0x6f, 0x73, 0x2e, 0x6c, 0x69, 0x62, 0x72, 0x61, 0x72, 0x79, 0x00, // 'dos.library\0'
];

function hashName(name) {
  let h = name.length;
  for (let i = 0; i < name.length; i++) {
    let c = name.charCodeAt(i);
    if (c >= 0x61 && c <= 0x7a) c -= 0x20; // toupper
    h = (h * 13 + c) & 0x7ff;
  }
  return h % HT_SIZE;
}

export class AdfWriter {
  constructor(volumeName = 'ECOMP') {
    this.img = new Uint8Array(BLOCKS * BSIZE);
    this.dv = new DataView(this.img.buffer);
    this.nextFree = 882;
    this.used = new Set([ROOT, BITMAP]);
    this.volumeName = volumeName;
    this.rootEntries = [];   // {name, block}
  }

  alloc() {
    const b = this.nextFree++;
    if (b >= BLOCKS) throw new Error('disk full');
    this.used.add(b);
    return b;
  }

  w32(block, longIdx, v) { this.dv.setUint32(block * BSIZE + longIdx * 4, v >>> 0, false); }
  r32(block, longIdx) { return this.dv.getUint32(block * BSIZE + longIdx * 4, false); }

  setBcplName(block, byteOff, name) {
    this.img[block * BSIZE + byteOff] = name.length;
    for (let i = 0; i < name.length; i++) this.img[block * BSIZE + byteOff + 1 + i] = name.charCodeAt(i);
  }

  normalChecksum(block) {
    this.w32(block, 5, 0);
    let sum = 0;
    for (let i = 0; i < 128; i++) sum = (sum + this.r32(block, i)) >>> 0;
    this.w32(block, 5, (-sum) >>> 0);
  }

  // hash a name into a header block's table, chaining on collision.
  // Always refresh the mutated block's checksum (root's is redone in finish)
  insertEntry(dirBlock, name, block) {
    const slot = 6 + hashName(name);
    const existing = this.r32(dirBlock, slot);
    if (existing) {
      // walk the chain, append at the end (long 124 = hash_chain)
      let b = existing;
      while (this.r32(b, 124)) b = this.r32(b, 124);
      this.w32(b, 124, block);
      this.normalChecksum(b);
    } else {
      this.w32(dirBlock, slot, block);
      if (dirBlock !== ROOT) this.normalChecksum(dirBlock);
    }
  }

  addDir(name, parent = ROOT) {
    const b = this.alloc();
    this.w32(b, 0, T_HEADER);
    this.w32(b, 1, b);
    this.setBcplName(b, 0x1b0, name);
    this.w32(b, 125, parent);
    this.w32(b, 127, ST_USERDIR);
    this.insertEntry(parent, name, b);
    this.normalChecksum(b);
    if (parent === ROOT) this.parentNeedsSum = true;
    return b;
  }

  addFile(name, data, parent = ROOT) {
    const header = this.alloc();
    const nblocks = Math.ceil(data.length / DATA_BYTES) || 1;
    const dataBlocks = [];
    for (let i = 0; i < nblocks; i++) dataBlocks.push(this.alloc());
    // A header/extension block holds at most HT_SIZE (72) data-block pointers;
    // files larger than that chain the rest through file extension blocks.
    const nExt = nblocks > HT_SIZE ? Math.ceil((nblocks - HT_SIZE) / HT_SIZE) : 0;
    const extBlocks = [];
    for (let i = 0; i < nExt; i++) extBlocks.push(this.alloc());
    for (let i = 0; i < nblocks; i++) {
      const db = dataBlocks[i];
      const chunk = data.subarray(i * DATA_BYTES, Math.min((i + 1) * DATA_BYTES, data.length));
      this.w32(db, 0, T_DATA);
      this.w32(db, 1, header);            // header_key = the file header (always)
      this.w32(db, 2, i + 1);
      this.w32(db, 3, chunk.length);
      this.w32(db, 4, i + 1 < nblocks ? dataBlocks[i + 1] : 0);
      this.img.set(chunk, db * BSIZE + 24);
      this.normalChecksum(db);
    }
    // file header: first up-to-72 data pointers (table runs BACKWARDS from 77)
    const inHeader = Math.min(nblocks, HT_SIZE);
    this.w32(header, 0, T_HEADER);
    this.w32(header, 1, header);
    this.w32(header, 2, inHeader);        // high_seq: pointers in THIS block
    this.w32(header, 4, dataBlocks[0]);
    for (let i = 0; i < inHeader; i++) this.w32(header, 77 - i, dataBlocks[i]);
    this.w32(header, 81, data.length);    // byte_size (+0x144)
    this.setBcplName(header, 0x1b0, name);
    this.w32(header, 125, parent);
    this.w32(header, 126, nExt ? extBlocks[0] : 0);  // extension (+0x1f8)
    this.w32(header, 127, ST_FILE >>> 0);
    this.insertEntry(parent, name, header);
    this.normalChecksum(header);
    // file extension blocks: each chains up to 72 further data pointers
    for (let e = 0; e < nExt; e++) {
      const ext = extBlocks[e];
      const start = HT_SIZE + e * HT_SIZE;
      const cnt = Math.min(HT_SIZE, nblocks - start);
      this.w32(ext, 0, T_LIST);
      this.w32(ext, 1, ext);              // own block
      this.w32(ext, 2, cnt);              // high_seq
      for (let i = 0; i < cnt; i++) this.w32(ext, 77 - i, dataBlocks[start + i]);
      this.w32(ext, 125, header);         // parent = the file header
      this.w32(ext, 126, e + 1 < nExt ? extBlocks[e + 1] : 0);  // next extension
      this.w32(ext, 127, ST_FILE >>> 0);
      this.normalChecksum(ext);
    }
    return header;
  }

  finish() {
    // bootblock
    this.img[0] = 0x44; this.img[1] = 0x4f; this.img[2] = 0x53; this.img[3] = 0;
    this.dv.setUint32(8, ROOT, false);
    this.img.set(BOOTCODE, 12);
    let bsum = 0;
    this.dv.setUint32(4, 0, false);
    for (let i = 0; i < 256; i++) {
      const v = this.dv.getUint32(i * 4, false);
      const before = bsum;
      bsum = (bsum + v) >>> 0;
      if (bsum < before) bsum = (bsum + 1) >>> 0; // carry wraparound
    }
    this.dv.setUint32(4, (~bsum) >>> 0, false);

    // root block
    this.w32(ROOT, 0, T_HEADER);
    this.w32(ROOT, 3, HT_SIZE);
    this.w32(ROOT, 78, 0xffffffff);
    this.w32(ROOT, 79, BITMAP);
    this.setBcplName(ROOT, 0x1b0, this.volumeName);
    this.w32(ROOT, 127, ST_ROOT);
    this.normalChecksum(ROOT);

    // bitmap: bit set = free, bit n = block n+2; 1758 bits = 55 longs
    // (long 0 of the block is the checksum)
    const mapLongs = Math.ceil((BLOCKS - 2) / 32);
    const base = BITMAP * BSIZE + 4;
    for (let i = 0; i < mapLongs; i++) this.dv.setUint32(base + i * 4, 0xffffffff, false);
    for (let b = 2; b < BLOCKS; b++) {
      if (!this.used.has(b)) continue;
      const bit = b - 2;
      const off = base + (bit >> 5) * 4;
      let v = this.dv.getUint32(off, false);
      v &= ~(1 << (bit & 31));
      this.dv.setUint32(off, v >>> 0, false);
    }
    // clear the invalid trailing bits of the last map long
    for (let bit = BLOCKS - 2; bit < mapLongs * 32; bit++) {
      const off = base + (bit >> 5) * 4;
      let v = this.dv.getUint32(off, false);
      v &= ~(1 << (bit & 31));
      this.dv.setUint32(off, v >>> 0, false);
    }
    this.dv.setUint32(BITMAP * BSIZE, 0, false);
    let sum = 0;
    for (let i = 0; i < 128; i++) sum = (sum + this.r32(BITMAP, i)) >>> 0;
    this.w32(BITMAP, 0, (-sum) >>> 0);

    return this.img;
  }
}

// Build a bootable disk that runs `binary` at boot via startup-sequence.
export function bootableAdf(binary, { volume = 'ECOMP', command = 'prog' } = {}) {
  const w = new AdfWriter(volume);
  w.addFile(command, binary);
  const s = w.addDir('s');
  const seq = new TextEncoder().encode(`${command}\n`);
  w.addFile('startup-sequence', seq, s);
  return w.finish();
}
