// AmigaOS hunk executable writer. One code hunk. Our own code is PC-relative,
// but a linked binary module's CODE carries absolute references (and we call
// into it with jsr abs.L), so those 32-bit fields are listed in `relocs` and
// emitted as a HUNK_RELOC32 block for loadseg() to rebase.
const HUNK_HEADER = 0x3f3;
const HUNK_CODE = 0x3e9;
const HUNK_RELOC32 = 0x3ec;
const HUNK_END = 0x3f2;

export function writeHunk(code, relocs = []) {
  const padded = new Uint8Array((code.length + 3) & ~3);
  padded.set(code);
  const longs = padded.length / 4;

  // reloc offsets must be longword-aligned positions within the padded image
  const offs = [...relocs].sort((a, b) => a - b);

  const out = [];
  const w = v => {
    out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  };
  w(HUNK_HEADER);
  w(0);          // no resident library names
  w(1);          // hunk table size
  w(0);          // first hunk
  w(0);          // last hunk
  w(longs);      // memory size of hunk 0
  w(HUNK_CODE);
  w(longs);
  for (const b of padded) out.push(b);
  if (offs.length) {
    w(HUNK_RELOC32);
    w(offs.length);    // number of offsets
    w(0);              // they relocate against hunk 0 (our only hunk)
    for (const off of offs) w(off);
    w(0);              // end of reloc table (count 0)
  }
  w(HUNK_END);
  return new Uint8Array(out);
}
