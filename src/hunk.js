// AmigaOS hunk executable writer. One code hunk, no relocations: all our
// data references are PC-relative, so loadseg() can place us anywhere.
const HUNK_HEADER = 0x3f3;
const HUNK_CODE = 0x3e9;
const HUNK_END = 0x3f2;

export function writeHunk(code) {
  const padded = new Uint8Array((code.length + 3) & ~3);
  padded.set(code);
  const longs = padded.length / 4;
  const out = new Uint8Array(4 * 8 + padded.length + 4);
  const dv = new DataView(out.buffer);
  let o = 0;
  const w = v => { dv.setUint32(o, v >>> 0, false); o += 4; };
  w(HUNK_HEADER);
  w(0);        // no resident library names
  w(1);        // hunk table size
  w(0);        // first hunk
  w(0);        // last hunk
  w(longs);    // memory size of hunk 0
  w(HUNK_CODE);
  w(longs);
  out.set(padded, o); o += padded.length;
  dv.setUint32(o, HUNK_END, false);
  return out;
}
