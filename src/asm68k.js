// Minimal M68000 assembler: emits big-endian machine code into a growable
// buffer with label/fixup support. Only the encodings the code generator
// needs — each helper is unit-tested against known opcode values.

export const D0 = 0, D1 = 1, D2 = 2, D3 = 3, D4 = 4, D5 = 5, D6 = 6, D7 = 7;
export const A0 = 0, A1 = 1, A2 = 2, A3 = 3, A4 = 4, A5 = 5, A6 = 6, A7 = 7;

export class Asm {
  constructor() {
    this.bytes = [];
    this.labels = new Map();      // name -> offset
    this.fixups = [];             // {at, label, kind} kind: 'bra16'|'pc16'|'abs32'
    this.relocs = [];             // byte offsets of 32-bit fields needing HUNK_RELOC32
  }

  get pc() { return this.bytes.length; }

  w16(v) { this.bytes.push((v >> 8) & 0xff, v & 0xff); }
  w32(v) { this.w16(v >>> 16); this.w16(v & 0xffff); }
  w8(v) { this.bytes.push(v & 0xff); }

  label(name) {
    if (this.labels.has(name)) throw new Error(`duplicate label ${name}`);
    this.labels.set(name, this.pc);
  }
  // register a label at an explicit offset (e.g. a proc entry inside an
  // appended binary-module code blob)
  labelAt(name, offset) {
    if (this.labels.has(name)) throw new Error(`duplicate label ${name}`);
    this.labels.set(name, offset);
  }
  // append raw bytes (a linked module's CODE section)
  blob(bytes) { for (let i = 0; i < bytes.length; i++) this.bytes.push(bytes[i]); }
  // record that the 32-bit field already written at `offset` is an absolute
  // address needing a HUNK_RELOC32 entry (used when copying a module's RELOC list)
  reloc32At(offset) { this.relocs.push(offset); }
  // register a 32-bit PC-relative fixup at an existing offset (a module's
  // ifunc call site, patched jsr.l -> bsr.l into a runtime thunk)
  bsr32At(offset, label) { this.fixups.push({ at: offset, label, kind: 'bsr32' }); }
  // jsr to an absolute long address resolved from a label; emits a reloc so the
  // loader rebases it. Reaches anywhere in the hunk (unlike the ±32KB bsr).
  jsr_abs(label) {
    this.w16(0x4eb9);                                   // jsr xxx.L
    this.fixups.push({ at: this.pc, label, kind: 'abs32' });
    this.w32(0);                                        // filled in finish()
  }

  // ---- moves ----
  moveq(imm, dn) {
    if (imm < -128 || imm > 127) throw new Error('moveq range');
    this.w16(0x7000 | dn << 9 | (imm & 0xff));
  }
  movel_imm(imm, dn) { this.w16(0x203c | dn << 9); this.w32(imm); }
  movel_dd(src, dst) { this.w16(0x2000 | dst << 9 | src); }            // move.l Ds,Dd
  movel_da(src, an) { this.w16(0x2040 | an << 9 | src); }              // movea.l Ds,Ad
  movel_ad(an, dn) { this.w16(0x2000 | dn << 9 | 1 << 3 | an); }       // move.l As,Dd
  movel_aa(src, dst) { this.w16(0x2040 | dst << 9 | 1 << 3 | src); }   // movea.l As,Ad
  movel_d_push(dn) { this.w16(0x2f00 | dn); }                          // move.l Dn,-(a7)
  movel_pop_d(dn) { this.w16(0x201f | dn << 9); }                      // move.l (a7)+,Dn
  movel_a_push(an) { this.w16(0x2f08 | an); }                          // move.l An,-(a7)
  movel_pop_a(an) { this.w16(0x205f | an << 9); }                      // movea.l (a7)+,An
  movel_d_disp(dn, d, an) { this.w16(0x2140 | an << 9 | dn); this.w16(d); } // move.l Dn,d16(Am) — wait, see test
  movel_disp_d(d, an, dn) { this.w16(0x2028 | dn << 9 | an); this.w16(d); } // move.l d16(Am),Dn
  movel_d_ind(dn, an) { this.w16(0x2080 | an << 9 | dn); }             // move.l Dn,(Am)
  movel_ind_d(an, dn) { this.w16(0x2010 | dn << 9 | an); }             // move.l (Am),Dn
  movel_absw_d(addr, dn) { this.w16(0x2038 | dn << 9); this.w16(addr); } // move.l addr.w,Dn
  movel_absw_a(addr, an) { this.w16(0x2078 | an << 9); this.w16(addr); } // movea.l addr.w,An
  moveb_ind_d(an, dn) { this.w16(0x1010 | dn << 9 | an); }             // move.b (Am),Dn
  moveb_postinc_d(an, dn) { this.w16(0x1018 | dn << 9 | an); }         // move.b (Am)+,Dn
  moveb_d_postinc(dn, an) { this.w16(0x10c0 | an << 9 | dn); }         // move.b Dn,(Am)+
  moveb_imm_postinc(imm, an) { this.w16(0x1cfc & 0 | 0x10fc | an << 9); this.w16(imm & 0xff); } // move.b #i,(Am)+

  // ---- lea / pea ----
  lea_pc(label, an) {
    this.w16(0x41fa | an << 9);
    this.fixups.push({ at: this.pc, label, kind: 'pc16' });
    this.w16(0);
  }
  lea_disp(d, src, an) { this.w16(0x41e8 | an << 9 | src); this.w16(d); } // lea d16(Am),An

  // ---- arithmetic ----
  addl_dd(src, dst) { this.w16(0xd080 | dst << 9 | src); }
  subl_dd(src, dst) { this.w16(0x9080 | dst << 9 | src); }
  cmpl_dd(src, dst) { this.w16(0xb080 | dst << 9 | src); }
  andl_dd(src, dst) { this.w16(0xc080 | dst << 9 | src); }
  orl_dd(src, dst) { this.w16(0x8080 | dst << 9 | src); }
  addl_aa(src, dst) { this.w16(0xd1c8 | dst << 9 | src); }              // adda.l As,Ad
  addql(q, dn) { this.w16(0x5080 | (q === 8 ? 0 : q) << 9 | dn); }
  addql_a(q, an) { this.w16(0x5088 | (q === 8 ? 0 : q) << 9 | an); }
  subql_a(q, an) { this.w16(0x5188 | (q === 8 ? 0 : q) << 9 | an); }
  addal_imm(imm, an) { this.w16(0xd1fc | an << 9); this.w32(imm); }
  negl(dn) { this.w16(0x4480 | dn); }
  notl(dn) { this.w16(0x4680 | dn); }
  extw(dn) { this.w16(0x4880 | dn); }
  extl(dn) { this.w16(0x48c0 | dn); }
  tstl(dn) { this.w16(0x4a80 | dn); }
  tstb(dn) { this.w16(0x4a00 | dn); }
  tstl_disp(d, an) { this.w16(0x4aa8 | an); this.w16(d); }  // tst.l d16(An)
  subql(q, dn) { this.w16(0x5180 | (q === 8 ? 0 : q) << 9 | dn); }
  movel_postinc_a(src, dst) { this.w16(0x2058 | dst << 9 | src); }  // movea.l (As)+,Ad
  asll_imm(q, dn) { this.w16(0xe180 | (q === 8 ? 0 : q) << 9 | dn); }
  asrl_imm(q, dn) { this.w16(0xe080 | (q === 8 ? 0 : q) << 9 | dn); }
  lsrl_imm(q, dn) { this.w16(0xe088 | (q === 8 ? 0 : q) << 9 | dn); }
  addxl_dd(src, dst) { this.w16(0xd180 | dst << 9 | src); }
  mulsw_dd(src, dst) { this.w16(0xc1c0 | dst << 9 | src); }  // muls.w Ds,Dd (16x16->32)
  divsw_dd(src, dst) { this.w16(0x81c0 | dst << 9 | src); }  // divs.w Ds,Dd (32/16->16q,16r)
  swap(dn) { this.w16(0x4840 | dn); }
  asll_d(dq, dn) { this.w16(0xe1a0 | dq << 9 | dn); }   // asl.l Dq,Dn
  asrl_d(dq, dn) { this.w16(0xe0a0 | dq << 9 | dn); }   // asr.l Dq,Dn
  eorl_dd(src, dst) { this.w16(0xb180 | src << 9 | dst); } // eor.l Ds,Dd

  // ---- immediate byte/word ops and extra moves for the runtime ----
  // 68020 32x32->32 long mul/div (used by ported EC intrinsic thunks I_MUL/I_DIV)
  mulsl_dd(src, dst) { this.w16(0x4c00 | src); this.w16(0x0800 | dst << 12); }  // muls.l Ds,Dd
  divsl_dd(src, dst) { this.w16(0x4c40 | src); this.w16(0x0800 | dst << 12); }  // divs.l Ds,Dd
  cmpib_imm(imm, dn) { this.w16(0x0c00 | dn); this.w16(imm & 0xff); }   // cmpi.b #i,Dn
  addib_imm(imm, dn) { this.w16(0x0600 | dn); this.w16(imm & 0xff); }   // addi.b #i,Dn
  movew_d_push(dn) { this.w16(0x3f00 | dn); }                           // move.w Dn,-(a7)
  movew_pop_d(dn) { this.w16(0x301f | dn << 9); }                       // move.w (a7)+,Dn
  subl_ad(an, dn) { this.w16(0x9088 | dn << 9 | an); }                  // sub.l An,Dn
  movel_disp_a(d, src, dst) { this.w16(0x2068 | dst << 9 | src); this.w16(d); } // movea.l d16(As),Ad
  movel_a_disp(src, d, an) { this.w16(0x2148 | an << 9 | src); this.w16(d); }   // move.l As,d16(Ad)
  addql_disp(q, d, an) { this.w16(0x50a8 | (q === 8 ? 0 : q) << 9 | an); this.w16(d); } // addq.l #q,d16(An)
  subql_disp(q, d, an) { this.w16(0x51a8 | (q === 8 ? 0 : q) << 9 | an); this.w16(d); } // subq.l #q,d16(An)

  // ---- byte/word memory access for CHAR/INT members and arrays ----
  moveb_disp_d(d, an, dn) { this.w16(0x1028 | dn << 9 | an); this.w16(d); }   // move.b d16(Am),Dn
  movew_disp_d(d, an, dn) { this.w16(0x3028 | dn << 9 | an); this.w16(d); }   // move.w d16(Am),Dn
  moveb_d_disp(dn, d, an) { this.w16(0x1140 | an << 9 | dn); this.w16(d); }   // move.b Dn,d16(Am)
  movew_d_disp(dn, d, an) { this.w16(0x3140 | an << 9 | dn); this.w16(d); }   // move.w Dn,d16(Am)
  movew_imm_disp(imm, d, an) { this.w16(0x317c | an << 9); this.w16(imm); this.w16(d); } // move.w #i,d16(An)
  clrb_disp(d, an) { this.w16(0x4228 | an); this.w16(d); }                    // clr.b d16(An)
  clrw_disp(d, an) { this.w16(0x4268 | an); this.w16(d); }                    // clr.w d16(An)
  clrl_disp(d, an) { this.w16(0x42a8 | an); this.w16(d); }                    // clr.l d16(An)
  jmp_ind(an) { this.w16(0x4ed0 | an); }                                      // jmp (An)
  moveb_ind_postinc(src, dst) { this.w16(0x10d8 | dst << 9 | src); }          // move.b (As)+,(Ad)+
  moveb_d_ind(dn, an) { this.w16(0x1080 | an << 9 | dn); }                    // move.b Dn,(Am)
  movew_d_ind(dn, an) { this.w16(0x3080 | an << 9 | dn); }                    // move.w Dn,(Am)
  movew_ind_d(an, dn) { this.w16(0x3010 | dn << 9 | an); }                    // move.w (Am),Dn
  movew_predec_d(an, dn) { this.w16(0x3020 | dn << 9 | an); }                 // move.w -(Am),Dn
  addal_d(dn, an) { this.w16(0xd1c0 | an << 9 | dn); }                        // adda.l Dn,Am
  cmpb_dd(src, dst) { this.w16(0xb000 | dst << 9 | src); }                    // cmp.b Ds,Dd
  clrb_ind(an) { this.w16(0x4210 | an); }                                     // clr.b (An)
  cmpb_postinc_d(an, dn) { this.w16(0xb018 | dn << 9 | an); }                 // cmp.b (Am)+,Dn
  tstb_postinc(an) { this.w16(0x4a18 | an); }                                 // tst.b (An)+
  cmpml_postinc(src, dst) { this.w16(0xb188 | dst << 9 | src); }              // cmpm.l (As)+,(Ad)+

  // ---- compare-to-boolean (E TRUE = -1) ----
  scc(cond, dn) { this.w16(0x50c0 | cond << 8 | dn); }
  static COND = { T: 0, F: 1, HI: 2, LS: 3, CC: 4, CS: 5, NE: 6, EQ: 7, VC: 8, VS: 9, PL: 10, MI: 11, GE: 12, LT: 13, GT: 14, LE: 15 };

  // ---- flow ----
  bcc(cond, label) {
    this.w16(0x6000 | cond << 8);
    this.fixups.push({ at: this.pc, label, kind: 'bra16' });
    this.w16(0);
  }
  bra(label) { this.bcc(0, label); }
  bsr(label) { this.bcc(1, label); }
  beq(label) { this.bcc(7, label); }
  bne(label) { this.bcc(6, label); }
  jsr_disp(d, an) { this.w16(0x4ea8 | an); this.w16(d); }
  jsr_ind(an) { this.w16(0x4e90 | an); }                    // jsr (An)
  rts() { this.w16(0x4e75); }
  link(an, size) { this.w16(0x4e50 | an); this.w16(-size & 0xffff); }
  unlk(an) { this.w16(0x4e58 | an); }
  dbra(dn, label) {
    this.w16(0x51c8 | dn);
    this.fixups.push({ at: this.pc, label, kind: 'bra16' });
    this.w16(0);
  }
  movem_push(mask) { this.w16(0x48e7); this.w16(mask); }   // movem.l <mask>,-(a7) — mask bit15=D0
  movem_pop(mask) { this.w16(0x4cdf); this.w16(mask); }    // movem.l (a7)+,<mask> — mask bit0=D0

  // data
  ascii(s) { for (let i = 0; i < s.length; i++) this.w8(s.charCodeAt(i)); }
  asciiz(s) { this.ascii(s); this.w8(0); }
  align() { if (this.bytes.length & 1) this.w8(0); }
  space(n) { for (let i = 0; i < n; i++) this.w8(0); }

  finish() {
    for (const f of this.fixups) {
      const target = this.labels.get(f.label);
      if (target === undefined) throw new Error(`undefined label ${f.label}`);
      if (f.kind === 'abs32') {
        // absolute long address of the target within the hunk; the loader
        // relocates it by the load address via the HUNK_RELOC32 entry.
        this.bytes[f.at] = (target >>> 24) & 0xff;
        this.bytes[f.at + 1] = (target >>> 16) & 0xff;
        this.bytes[f.at + 2] = (target >>> 8) & 0xff;
        this.bytes[f.at + 3] = target & 0xff;
        this.relocs.push(f.at);
        continue;
      }
      if (f.kind === 'bsr32') {
        // 32-bit PC-relative displacement (bsr.l into a runtime ifunc thunk);
        // self-relative, so no reloc needed. Reaches anywhere in the hunk.
        const disp = target - f.at;
        this.bytes[f.at] = (disp >>> 24) & 0xff;
        this.bytes[f.at + 1] = (disp >>> 16) & 0xff;
        this.bytes[f.at + 2] = (disp >>> 8) & 0xff;
        this.bytes[f.at + 3] = disp & 0xff;
        continue;
      }
      // bra16/pc16: 16-bit displacement relative to the extension word
      const disp = target - f.at;
      if (disp < -32768 || disp > 32767) throw new Error(`fixup out of range: ${f.label}`);
      this.bytes[f.at] = (disp >> 8) & 0xff;
      this.bytes[f.at + 1] = disp & 0xff;
    }
    this.align();
    this.relocs.sort((a, b) => a - b);
    return new Uint8Array(this.bytes);
  }
}

// movem register mask helpers (for push form, bit15 = D0 ... bit0 = A7)
export function pushMask(...regs) {
  let m = 0;
  for (const r of regs) m |= 1 << (15 - r);
  return m;
}
export function popMask(...regs) {
  let m = 0;
  for (const r of regs) m |= 1 << r;
  return m;
}
