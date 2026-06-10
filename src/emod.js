// Reader for original Amiga E binary modules ("EMOD", as shipped with
// E v3.3a — the v40 NDK module set). Format reverse-engineered from ECX's
// ecmodtrans.e (ecmod2ecxmod) and validated against real ShowModule output.
//
// Section stream after the EMOD magic, each headed by a 16-bit job code:
//   5 SYS     header: skip 4, osvers.w, skip 4, w, w, skip 2, version.w, skip 4
//   1 CONST   entries: [namelen.w][value.l][name…] until namelen 0
//   2 OBJ     [namelen.w][pad.l][name…] then members
//             [namelen.w][val.w][offset.w][name…] (namelen 0 = private slot)
//             until namelen 0, then [size.w]
//   6 LIB     [libname\0][basename\0] then vector entries from -30 step -6:
//             $10 = skipped/zero-arg slot, else [name>0x20…][regbytes<0x10…]
//             where reg 0..7 = D0..D7, 8..15 = A0..A7; $FF ends the section
//   0 DONE
// Other sections (CODE/PROCS/RELOC/GLOBS/DEBUG/MACROS) belong to code
// modules; we stop there and mark the result partial.

export function readEmod(buf, name = '<module>') {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = {
    name, version: 0, consts: new Map(), objects: new Map(),
    lib: null, partial: false, error: null,
  };
  if (buf.length < 6 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'EMOD') {
    out.error = 'not an EMOD file';
    return out;
  }
  let o = 4;
  const end = buf.length;
  const w = () => { const v = dv.getInt16(o, false); o += 2; return v; };
  const uw = () => { const v = dv.getUint16(o, false); o += 2; return v; };
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
        const osvers = w(); void osvers;
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
          // optional method tables — none in v40 NDK modules; bail if present
          if (uw()) { out.partial = true; out.error = 'methods not supported'; return out; }
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
      } else {
        out.partial = true;                      // code module sections
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
