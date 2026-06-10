// Inline-assembly assembler (ch_15): encodes the asm statement lines the
// parser captured as raw text. E identifiers resolve through the code
// generator: locals/args → d16(A5), globals → d16(A4), labels → pc16.
// Corpus-frequency mnemonic set; exotic instructions report errors.

const SIZES = { B: 0, W: 1, L: 2 };
const MOVESZ = { 0: 1, 1: 3, 2: 2 };  // size field for MOVE opcodes
const CC = { RA: 0, SR: 1, HI: 2, LS: 3, CC: 4, HS: 4, CS: 5, LO: 5, NE: 6,
  EQ: 7, VC: 8, VS: 9, PL: 10, MI: 11, GE: 12, LT: 13, GT: 14, LE: 15 };

export class AsmText {
  // env: {resolveVar(name) -> {an, disp} | null, label(name) -> string,
  //       constVal(name) -> number|null}
  constructor(a, env) {
    this.a = a;
    this.env = env;
    this.errors = [];
  }

  err(msg) { this.errors.push(msg); }

  // tokenize an operand string into an EA descriptor
  ea(tok) {
    tok = tok.trim();
    let m;
    if ((m = tok.match(/^D([0-7])$/i))) return { mode: 0, reg: +m[1] };
    if ((m = tok.match(/^A([0-7])$/i))) return { mode: 1, reg: +m[1] };
    if ((m = tok.match(/^SP$/i))) return { mode: 1, reg: 7 };
    if ((m = tok.match(/^\(A([0-7])\)$/i))) return { mode: 2, reg: +m[1] };
    if ((m = tok.match(/^\(A([0-7])\)\+$/i))) return { mode: 3, reg: +m[1] };
    if ((m = tok.match(/^-\(A([0-7])\)$/i))) return { mode: 4, reg: +m[1] };
    if (/^\(SP\)$/i.test(tok)) return { mode: 2, reg: 7 };
    if (/^\(SP\)\+$/i.test(tok)) return { mode: 3, reg: 7 };
    if (/^-\(SP\)$/i.test(tok)) return { mode: 4, reg: 7 };
    if ((m = tok.match(/^(-?[\w$]+)\(SP\)$/i))) {
      const d = this.num(m[1]);
      if (d === null) { this.err(`bad displacement ${m[1]}`); return null; }
      return { mode: 5, reg: 7, ext: [d & 0xffff] };
    }
    if ((m = tok.match(/^(-?[\w$]+)\(A([0-7])\)$/i))) {
      const d = this.num(m[1]);
      if (d === null) { this.err(`bad displacement ${m[1]}`); return null; }
      return { mode: 5, reg: +m[2], ext: [d & 0xffff] };
    }
    if ((m = tok.match(/^([\w$]+)\(PC\)$/i))) {
      return { mode: 7, reg: 2, pcLabel: this.env.label(m[1]) };
    }
    if ((m = tok.match(/^#(.+)$/))) {
      const v = this.num(m[1]);
      if (v === null) { this.err(`bad immediate ${m[1]}`); return null; }
      return { mode: 7, reg: 4, imm: v };
    }
    if ((m = tok.match(/^\$?[0-9a-fA-F]+$/)) && /^\$/.test(tok)) {
      const v = parseInt(tok.slice(1), 16);
      return { mode: 7, reg: 1, ext: [(v >>> 16) & 0xffff, v & 0xffff] };
    }
    // E identifier: variable (frame/globals) or code label
    const v = this.env.resolveVar(tok);
    if (v) return { mode: 5, reg: v.an, ext: [v.disp & 0xffff] };
    const c = this.env.constVal(tok);
    if (c !== null && c !== undefined) return { mode: 7, reg: 4, imm: c };
    return { mode: 7, reg: 2, pcLabel: this.env.label(tok) };  // label, pc-rel
  }

  num(s) {
    s = s.trim();
    let neg = false;
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    let v = null;
    if (/^\$[0-9a-fA-F]+$/.test(s)) v = parseInt(s.slice(1), 16);
    else if (/^%[01]+$/.test(s)) v = parseInt(s.slice(1), 2);
    else if (/^[0-9]+$/.test(s)) v = parseInt(s, 10);
    else if (/^"."$/.test(s)) v = s.charCodeAt(1);
    else {
      const c = this.env.constVal(s);
      if (c !== null && c !== undefined) v = c;
    }
    if (v === null) return null;
    return neg ? -v : v;
  }

  emitEa(ea, size) {
    const a = this.a;
    if (ea.imm !== undefined) {
      if (size === 2) a.w32(ea.imm);
      else a.w16(ea.imm & 0xffff);
      return;
    }
    if (ea.pcLabel) {
      a.fixups.push({ at: a.pc, label: ea.pcLabel, kind: 'pc16' });
      a.w16(0);
      return;
    }
    for (const w of ea.ext ?? []) a.w16(w);
  }

  eaBits(ea) { return ea.mode << 3 | ea.reg; }

  line(text, lineNo) {
    const a = this.a;
    // parser space-joins tokens: normalize 'MOVE . L D0 , a' style input
    const t = text.trim().replace(/\s*\.\s*/g, '.');
    if (!t) return;
    const m = t.match(/^([A-Za-z]+)(?:\.([BWLS]))?\s*(.*)$/);
    if (!m) { this.err(`unparseable asm: ${t}`); return; }
    let mn = m[1].toUpperCase();
    let size = m[2] ? (m[2].toUpperCase() === 'S' ? 0 : SIZES[m[2].toUpperCase()]) : 2;
    const ops = m[3] ? this.splitOps(m[3].replace(/\s+/g, '')) : [];
    const get = i => this.ea(ops[i]);

    const stdSize = size << 6;
    switch (mn) {
      case 'NOP': a.w16(0x4e71); return;
      case 'RTS': a.w16(0x4e75); return;
      case 'RTE': a.w16(0x4e73); return;
      case 'MOVEQ': {
        const v = this.num(ops[0].replace(/^#/, ''));
        const d = get(1);
        if (v === null || !d || d.mode !== 0) { this.err(`bad MOVEQ: ${t}`); return; }
        a.w16(0x7000 | d.reg << 9 | (v & 0xff));
        return;
      }
      case 'MOVE': case 'MOVEA': {
        const s = get(0), d = get(1);
        if (!s || !d) return;
        a.w16(MOVESZ[size] << 12 | d.reg << 9 | d.mode << 6 | this.eaBits(s));
        this.emitEa(s, size);
        this.emitEa(d, size);
        return;
      }
      case 'LEA': {
        const s = get(0), d = get(1);
        if (!s || !d || d.mode !== 1) { this.err(`bad LEA: ${t}`); return; }
        a.w16(0x41c0 | d.reg << 9 | this.eaBits(s));
        this.emitEa(s, size);
        return;
      }
      case 'PEA': {
        const s = get(0);
        a.w16(0x4840 | this.eaBits(s));
        this.emitEa(s, size);
        return;
      }
      case 'CLR': case 'TST': case 'NEG': case 'NOT': {
        const base = { CLR: 0x4200, TST: 0x4a00, NEG: 0x4400, NOT: 0x4600 }[mn];
        const s = get(0);
        if (!s) return;
        a.w16(base | stdSize | this.eaBits(s));
        this.emitEa(s, size);
        return;
      }
      case 'JSR': case 'JMP': {
        const s = get(0);
        if (!s) return;
        a.w16((mn === 'JSR' ? 0x4e80 : 0x4ec0) | this.eaBits(s));
        this.emitEa(s, size);
        return;
      }
      case 'EXT': a.w16((size === 2 ? 0x48c0 : 0x4880) | get(0).reg); return;
      case 'SWAP': a.w16(0x4840 | get(0).reg); return;
      case 'EXG': {
        const x = get(0), y = get(1);
        if (x.mode === 0 && y.mode === 0) a.w16(0xc140 | x.reg << 9 | y.reg);
        else if (x.mode === 1 && y.mode === 1) a.w16(0xc148 | x.reg << 9 | y.reg);
        else a.w16(0xc188 | x.reg << 9 | y.reg);
        return;
      }
      case 'ADDQ': case 'SUBQ': {
        const v = this.num(ops[0].replace(/^#/, ''));
        const d = get(1);
        if (v === null || v < 1 || v > 8 || !d) { this.err(`bad ${mn}: ${t}`); return; }
        a.w16((mn === 'ADDQ' ? 0x5000 : 0x5100) | (v === 8 ? 0 : v) << 9 | stdSize | this.eaBits(d));
        this.emitEa(d, size);
        return;
      }
      case 'ADD': case 'SUB': case 'CMP': case 'AND': case 'OR': {
        const base = { ADD: 0xd000, SUB: 0x9000, CMP: 0xb000, AND: 0xc000, OR: 0x8000 }[mn];
        const s = get(0), d = get(1);
        if (!s || !d) return;
        if (d.mode === 1) {            // ADDA/SUBA/CMPA
          a.w16(base | d.reg << 9 | (size === 2 ? 7 : 3) << 6 | this.eaBits(s));
          this.emitEa(s, size);
          return;
        }
        if (s.imm !== undefined) {     // immediate forms ADDI/SUBI/CMPI/ANDI/ORI
          const ib = { ADD: 0x0600, SUB: 0x0400, CMP: 0x0c00, AND: 0x0200, OR: 0x0000 }[mn];
          a.w16(ib | stdSize | this.eaBits(d));
          this.emitEa(s, size);
          this.emitEa(d, size);
          return;
        }
        if (d.mode === 0) {            // <ea>,Dn
          a.w16(base | d.reg << 9 | stdSize | this.eaBits(s));
          this.emitEa(s, size);
        } else if (s.mode === 0) {     // Dn,<ea>
          a.w16(base | s.reg << 9 | (4 + size) << 6 | this.eaBits(d));
          this.emitEa(d, size);
        } else this.err(`bad ${mn}: ${t}`);
        return;
      }
      case 'ADDA': case 'SUBA': case 'CMPA': {
        const base = { ADDA: 0xd000, SUBA: 0x9000, CMPA: 0xb000 }[mn];
        const s = get(0), d = get(1);
        a.w16(base | d.reg << 9 | (size === 2 ? 7 : 3) << 6 | this.eaBits(s));
        this.emitEa(s, size);
        return;
      }
      case 'CMPI': case 'ADDI': case 'SUBI': case 'ANDI': case 'ORI': case 'EORI': {
        const ib = { CMPI: 0x0c00, ADDI: 0x0600, SUBI: 0x0400, ANDI: 0x0200, ORI: 0x0000, EORI: 0x0a00 }[mn];
        const s = get(0), d = get(1);
        a.w16(ib | stdSize | this.eaBits(d));
        this.emitEa(s, size);
        this.emitEa(d, size);
        return;
      }
      case 'EOR': {
        const s = get(0), d = get(1);
        if (s.imm !== undefined) {
          a.w16(0x0a00 | stdSize | this.eaBits(d));
          this.emitEa(s, size);
          this.emitEa(d, size);
        } else {
          a.w16(0xb100 | s.reg << 9 | stdSize | this.eaBits(d));
          this.emitEa(d, size);
        }
        return;
      }
      case 'MULS': case 'MULU': case 'DIVS': case 'DIVU': {
        const base = { MULS: 0xc1c0, MULU: 0xc0c0, DIVS: 0x81c0, DIVU: 0x80c0 }[mn];
        const s = get(0), d = get(1);
        a.w16(base | d.reg << 9 | this.eaBits(s));
        this.emitEa(s, 1);
        return;
      }
      case 'BTST': case 'BSET': case 'BCLR': case 'BCHG': {
        const op = { BTST: 0, BCHG: 1, BCLR: 2, BSET: 3 }[mn];
        const s = get(0), d = get(1);
        if (s.imm !== undefined) {
          a.w16(0x0800 | op << 6 | this.eaBits(d));
          a.w16(s.imm & 0xff);
          this.emitEa(d, size);
        } else {
          a.w16(0x0100 | s.reg << 9 | op << 6 | this.eaBits(d));
          this.emitEa(d, size);
        }
        return;
      }
      case 'ASL': case 'ASR': case 'LSL': case 'LSR': case 'ROL': case 'ROR': {
        const dir = (mn[1] === 'S' ? mn[2] : mn[2]) === 'L' ? 0x100 : 0;
        const kind = { AS: 0, LS: 1, RO: 3 }[mn.slice(0, 2)];
        const s = get(0), d = get(1);
        if (!d) {                      // single operand: shift by 1
          a.w16(0xe000 | 1 << 9 | dir | stdSize | kind << 3 | s.reg);
          return;
        }
        if (s.imm !== undefined) {
          const q = s.imm === 8 ? 0 : s.imm;
          a.w16(0xe000 | q << 9 | dir | stdSize | kind << 3 | d.reg);
        } else {
          a.w16(0xe000 | s.reg << 9 | dir | stdSize | 0x20 | kind << 3 | d.reg);
        }
        return;
      }
      case 'MOVEM': {
        // MOVEM.L regs,-(SP) / MOVEM.L (SP)+,regs
        const toMem = ops[1] && !/^[DAda]/.test(ops[1].trim()[0]);
        const regsTok = toMem ? ops[0] : ops[1];
        const eaTok = toMem ? ops[1] : ops[0];
        const mask = this.regMask(regsTok, toMem && /^-\(/.test(eaTok.trim()));
        const eaD = this.ea(eaTok);
        if (mask === null || !eaD) { this.err(`bad MOVEM: ${t}`); return; }
        a.w16((toMem ? 0x4880 : 0x4c80) | (size === 2 ? 0x40 : 0) | this.eaBits(eaD));
        a.w16(mask);
        this.emitEa(eaD, size);
        return;
      }
      case 'DBRA': case 'DBF': {
        const d = get(0);
        a.w16(0x51c8 | d.reg);
        a.fixups.push({ at: a.pc, label: this.env.label(ops[1].trim()), kind: 'bra16' });
        a.w16(0);
        return;
      }
      default: {
        // branches: BRA/BSR/Bcc
        let bm;
        if ((bm = mn.match(/^B(RA|SR|HI|LS|CC|HS|CS|LO|NE|EQ|VC|VS|PL|MI|GE|LT|GT|LE)$/))) {
          const cond = bm[1] === 'RA' ? 0 : bm[1] === 'SR' ? 1 : CC[bm[1]];
          a.w16(0x6000 | cond << 8);
          a.fixups.push({ at: a.pc, label: this.env.label(ops[0].trim()), kind: 'bra16' });
          a.w16(0);
          return;
        }
        let sm;
        if ((sm = mn.match(/^S(NE|EQ|HI|LS|CC|CS|PL|MI|GE|LT|GT|LE|VC|VS|T|F)$/))) {
          const d = get(0);
          a.w16(0x50c0 | CC[sm[1] === 'T' ? 'RA' : sm[1] === 'F' ? 'SR' : sm[1]] << 8 | this.eaBits(d));
          this.emitEa(d, 0);
          return;
        }
        this.err(`unsupported instruction ${mn} (line ${lineNo ?? '?'})`);
      }
    }
  }

  splitOps(s) {
    // split on commas not inside parens
    const out = [];
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  regMask(s, predec) {
    let mask = 0;
    for (const part of s.split('/')) {
      const m = part.trim().match(/^([DA])([0-7])(?:-([DA])([0-7]))?$/i);
      if (!m) return null;
      const base = m[1].toUpperCase() === 'A' ? 8 : 0;
      const from = base + +m[2];
      const to = m[3] ? (m[3].toUpperCase() === 'A' ? 8 : 0) + +m[4] : from;
      for (let r = from; r <= to; r++) mask |= 1 << r;
    }
    if (predec) {
      let rev = 0;
      for (let i = 0; i < 16; i++) if (mask & 1 << i) rev |= 1 << (15 - i);
      return rev;
    }
    return mask;
  }
}
