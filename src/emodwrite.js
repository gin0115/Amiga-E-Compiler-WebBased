// EMOD (.m) module writer — interface modules (constants + objects), byte
// layout mimicking real ec v3.3a output (validated by feeding our modules
// back to the original compiler).

export function writeEmod({ consts = [], objects = [] }) {
  const bytes = [];
  const w8 = v => bytes.push(v & 0xff);
  const w16 = v => { w8(v >> 8); w8(v); };
  const w32 = v => { w16(v >>> 16); w16(v); };
  const name = s => {
    const padded = s + '\0' + (((s.length + 1) & 1) ? '\0' : '');
    for (const ch of padded) w8(ch.charCodeAt(0));
    return padded.length;
  };
  const padLen = s => (s.length + 2) & ~1;

  for (const ch of 'EMOD') w8(ch.charCodeAt(0));
  // SYS header exactly as ec emits it (version 10 = the v40 format)
  w16(5);
  w32(0); w16(0); w32(0x1000); w16(0); w16(0); w16(0); w16(10); w32(0);

  for (const o of objects) {
    w16(2);
    const nlen = padLen(o.name);
    let size = 2 + 4 + nlen;
    for (const m of o.members) size += 2 + 2 + 2 + padLen(m.name) + 2;
    size += 2 + 2 + 2;                  // terminator, objsize, method flag
    w32(size);
    w16(nlen);
    w16(0xffff); w16(0);
    name(o.name);
    for (const m of o.members) {
      w16(padLen(m.name));
      w16(m.val);
      w16(m.offset);
      name(m.name);
      w16(0);                           // member type word (plain)
    }
    w16(0);
    w16(o.size);
    w16(0);                             // no methods
  }

  if (consts.length) {
    w16(1);
    let size = 2;                       // terminator
    for (const c of consts) size += 2 + 4 + padLen(c.name);
    w32(size);
    for (const c of consts) {
      w16(padLen(c.name));
      w32(c.value);
      name(c.name);
    }
    w16(0);
  }

  w16(0);                               // JOB_DONE
  if (bytes.length & 3) w16(0);
  return new Uint8Array(bytes);
}
