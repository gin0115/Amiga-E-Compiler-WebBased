// Reader for original Amiga E binary modules ("EMOD", as shipped with
// E v3.3a — the v40 NDK module set). Format reverse-engineered from ECX's
// ecmodtrans.e (ecmod2ecxmod) and validated against real ShowModule output.
//
// Section stream after the EMOD magic, each headed by a 16-bit job code:
//   5 SYS     header: skip 4, osvers.w, skip 4, w, w, skip 2, version.w, skip 4
//   1 CONST   entries: [namelen.w][value.l][name…] until namelen 0
//   2 OBJ     [namelen.w][pad.l][name…] then members
//             [namelen.w][val.w][offset.w][name…] (namelen 0 = private slot)
//             until namelen 0, then [size.w]; v7+ optional method table (skipped)
//   6 LIB     [libname\0][basename\0] then vector entries from -30 step -6:
//             $10 = skipped/zero-arg slot, else [name>0x20…][regbytes<0x10…]
//             where reg 0..7 = D0..D7, 8..15 = A0..A7; $FF ends the section
//   0 DONE
//
// Code modules (e.g. tools/EasyGUI.m) additionally carry:
//   3 CODE    [size.l in LONGWORDS][raw 68k bytes (size*4)]
//   7 RELOC   [count.l][reloc.l * count]; high bit set => "ifunc" reloc
//             (offset = r & $FFFFFF; jsr.l at code+offset-2 that real E patches
//             to bsr.l into the runtime intrinsic table; ifuncNum = code[off+3]-10),
//             else a normal absolute reloc (offset of a 32-bit ptr to rebase)
//   4 PROCS   [namelen.w][name][offset.l][tag.w]; tag 1 = PROC then
//             [narg.w][skip.w][ndefaults.w][defval.l * ndefaults][extra.w][extra],
//             tag 2 = LABEL (offset only). namelen <= 0 ends the section.
//   8 GLOBS   optional SKIPMARK ($8000 word => skip 6); entries until len.w < 0:
//             len > 0 = xref (external symbol: [name (len)] then
//             [coff.l][pad.w(v>=10)]* terminated by coff.l 0),
//             len == 0 = drel (module-private global: same coff list)
//   9 MODINFO / 10 DEBUG / 11 MACROS  — not needed for linking; we stop there
//             (marking partial) once code/procs/relocs/globs are captured.

export function readEmod(buf, name = '<module>') {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = {
    name, version: 0, osvers: 0,
    consts: new Map(), objects: new Map(), lib: null,
    // code-module fields (null/empty for pure interface modules):
    code: null, codeWords: 0,
    procs: [],                          // {name, offset, kind:'proc'|'label', args}
    relocs: [],                         // {offset, kind:'abs'|'ifunc', ifuncNum}
    globs: { xrefs: [], drels: [] },    // xrefs:{name,refs[]}  drels:{refs[]}
    globalsCount: 0,
    isCodeModule: false,
    partial: false, error: null,
  };
  if (buf.length < 6 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'EMOD') {
    out.error = 'not an EMOD file';
    return out;
  }
  let o = 4;
  const end = buf.length;
  const w = () => { const v = dv.getInt16(o, false); o += 2; return v; };
  const sw = w;                                          // signed 16-bit read
  const uw = () => { const v = dv.getUint16(o, false); o += 2; return v; };
  const peekw = () => dv.getUint16(o, false);            // non-advancing
  const l = () => { const v = dv.getInt32(o, false); o += 4; return v; };
  const str = len => {
    let s = '';
    for (let i = 0; i < len && buf[o + i]; i++) s += String.fromCharCode(buf[o + i]);
    o += len;
    return s;
  };

  try {
    while (o < end - 1) {
      const job = uw();
      if (job === 0) break;                      // JOB_DONE
      if (job === 5) {                           // JOB_SYS
        o += 4;
        out.osvers = w();
        o += 4;
        w(); w();
        o += 2;
        out.version = w();
        o += 4;
        if (out.version > 10) o += 4;
      } else if (job === 1) {                    // JOB_CONST
        if (out.version >= 6) o += 4;
        for (;;) {
          const len = uw();
          if (!len) break;
          const value = l();
          const cname = str(len);
          out.consts.set(cname, value);
        }
      } else if (job === 2) {                    // JOB_OBJ
        if (out.version >= 6) o += 4;
        const nlen = uw();
        o += 4;
        const oname = str(nlen);
        const members = new Map();
        let privates = 0;
        for (;;) {
          const mlen = uw();
          if (!mlen) break;
          const val = uw();
          const off = uw();
          if (mlen > 0) {
            const mname = str(mlen);
            members.set(mname, { offset: off, val });
          } else {
            privates++;
          }
          if (out.version >= 6) {
            const c = w();
            if (c < 0) {
              const tlen = uw();
              str(tlen);
            }
          }
        }
        const size = uw();
        out.objects.set(oname, { name: oname, members, size, privates });
        if (out.version >= 7) {
          // optional method table — skip it (we don't model methods)
          if (uw()) {
            o += 4;
            let ml = uw(); o += ml + 4;
            while (sw() !== -1) {
              o += 2;
              ml = uw(); o += ml;
              uw();                              // arg count (no displacement)
              ml = uw(); o += ml * 4;
            }
            while (sw() !== -1) o += 4;
          }
        }
      } else if (job === 3) {                    // JOB_CODE
        const words = l();
        out.codeWords = words;
        out.code = buf.subarray(o, o + words * 4);
        out.isCodeModule = true;
        o += words * 4;
      } else if (job === 7) {                    // JOB_RELOC
        const count = l();
        for (let i = 0; i < count; i++) {
          const r = l() >>> 0;
          if (r & 0x80000000) {
            const offset = r & 0xffffff;
            // the call site is `jsr.l <…NN>` where the low byte NN is the
            // intrinsic table number (WriteF=10, Mul=11, …) — see ifuncs.js
            const ifuncNum = out.code ? out.code[offset + 3] : null;
            out.relocs.push({ offset, kind: 'ifunc', ifuncNum });
          } else {
            out.relocs.push({ offset: r, kind: 'abs' });
          }
        }
      } else if (job === 4) {                    // JOB_PROCS
        for (;;) {
          const namelen = sw();
          if (namelen <= 0) break;
          const pname = str(namelen);
          const offset = l();
          const tag = uw();
          if (tag === 1) {
            const args = uw();
            uw();                                // skip word
            const ndef = uw();
            o += ndef * 4;                       // default values
            const extra = uw();
            o += extra;
            out.procs.push({ name: pname, offset, kind: 'proc', args });
          } else if (tag === 2) {
            out.procs.push({ name: pname, offset, kind: 'label', args: 0 });
          } else {
            out.partial = true;
            out.error = `procs: unexpected tag ${tag}`;
            return out;
          }
        }
      } else if (job === 8) {                    // JOB_GLOBS
        if ((peekw() & 0xffff) === 0x8000) o += 6;
        for (;;) {
          const len = sw();
          if (len < 0) break;
          const refs = [];
          const nm = len > 0 ? str(len) : null;
          for (;;) {
            const coff = l();
            if (coff === 0) break;
            if (out.version >= 10) o += 2;       // pad word; LONG refs only
            refs.push(coff);
          }
          if (len > 0) {
            out.globs.xrefs.push({ name: nm, refs });
          } else {
            out.globs.drels.push({ refs });
            out.globalsCount += refs.length;
          }
        }
      } else if (job === 6) {                    // JOB_LIB
        let libname = '';
        while (o < end && buf[o]) libname += String.fromCharCode(buf[o++]);
        o++;
        let basename = '';
        while (o < end && buf[o]) basename += String.fromCharCode(buf[o++]);
        o++;
        const funcs = [];
        let off = -30;
        while (o < end && buf[o] !== 0xff) {
          if (buf[o] === 0x10) { o++; off -= 6; continue; }
          let fname = '';
          while (o < end && buf[o] > 0x20) fname += String.fromCharCode(buf[o++]);
          const regs = [];
          if (buf[o] !== 0x10) {
            while (o < end && buf[o] < 0x10) regs.push(buf[o++]);
          } else {
            o++;
          }
          funcs.push({ name: fname, offset: off, regs });
          off -= 6;
        }
        out.lib = { libname, basename, funcs };
        break;                                   // LIB consumes to end
      } else if (job === 9) {                    // JOB_MODINFO — submodule xref
        o += 4;                                  // info; not needed for linking
        let mlen;
        while ((mlen = uw()) !== 0) {            // submodule name length
          o += mlen;                             // skip name
          let sym;
          while ((sym = uw()) !== 0) {           // symbol type
            const idlen = uw();
            o += idlen;                          // skip id
            if (sym === 2) {                     // proc/label: numrefs longs
              uw();                              // flag word
              const numrefs = uw();
              o += numrefs * 4;
            } else {                             // other: naccess 6-byte records
              const naccess = uw();
              o += naccess * 6;
            }
          }
        }
      } else {
        // JOB_DEBUG (10) / MACROS (11) / unknown — not needed for linking;
        // code/procs/relocs/globs/consts/objects are captured before these.
        out.partial = true;
        break;
      }
    }
  } catch (err) {
    out.partial = true;
    out.error = err.message;
  }
  return out;
}

// register byte → register name (0..7 = D0..D7, 8..15 = A0..A7)
export function regName(r) {
  return r < 8 ? `d${r}` : `a${r - 8}`;
}
