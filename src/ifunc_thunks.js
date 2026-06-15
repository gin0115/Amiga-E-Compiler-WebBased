// Runtime implementations of E's intrinsic functions ("ifuncs"), emitted as
// callable thunks (label `ifunc_<Name>`) that a linked binary code module
// reaches via the patched `bsr.l` at each ifunc call site.
//
// Ported directly from ec68kifuncs.asm — the intrinsics from Wouter van
// Oortmerssen's EC_733.S source (zlib license; also GPL per strlen.com/amiga-e).
// Calling convention (verified against I_MUL/I_DIV): args pushed left-to-right,
// so the first arg is deepest — arg1 at 8(A7), arg2 at 4(A7) after the bsr.l
// pushes the return address; result in D0; caller cleans the stack. Target is
// the A1200 (68020), matching the "020 version" routines.
//
// © Wouter van Oortmerssen 1991-1997, used with permission. Each thunk mirrors
// the original routine; add more as modules require them.
import { Asm, D0, D1, D2, D3, A0, A1, A2, A3, A4, A5, A6, A7 } from './asm68k.js';
const { MI, PL, EQ, GT } = Asm.COND;

// Generic marshaller: an ifunc whose behaviour ecomp already implements as a
// fixed-register runtime routine (args in D0,D1,D2…; result in D0 — see
// Codegen.callFixed). The module pushes `n` args left-to-right (arg0 deepest),
// so arg i sits at (n-i)*4(A7) after the bsr.l return address; load each into
// D[i] and tail into the routine. Caller cleans the stack.
const wrap = (label, n) => a => {
  for (let i = 0; i < n; i++) a.movel_disp_d((n - i) * 4, A7, i);
  a.bsr(label);
  a.rts();
};

export const IFUNC_THUNKS = {
  // I_MUL: MOVE.L 8(A7),D0 / MOVE.L 4(A7),D1 / MULS.L D1,D0 / RTS
  Mul(a) { a.movel_disp_d(8, A7, D0); a.movel_disp_d(4, A7, D1); a.mulsl_dd(D1, D0); a.rts(); },
  // I_DIV: ... DIVS.L D1,D0 / RTS
  Div(a) { a.movel_disp_d(8, A7, D0); a.movel_disp_d(4, A7, D1); a.divsl_dd(D1, D0); a.rts(); },
  // I_AND: MOVE.L 8(A7),D0 / AND.L 4(A7),D0 / RTS
  And(a) { a.movel_disp_d(8, A7, D0); a.movel_disp_d(4, A7, D1); a.andl_dd(D1, D0); a.rts(); },
  // I_OR
  Or(a) { a.movel_disp_d(8, A7, D0); a.movel_disp_d(4, A7, D1); a.orl_dd(D1, D0); a.rts(); },
  // I_EOR: MOVE.L 4(A7),D0 / MOVE.L 8(A7),D1 / EOR.L D1,D0 / RTS
  Eor(a) { a.movel_disp_d(4, A7, D0); a.movel_disp_d(8, A7, D1); a.eorl_dd(D1, D0); a.rts(); },
  // I_SHL: ... ASL.L D1,D0
  Shl(a) { a.movel_disp_d(8, A7, D0); a.movel_disp_d(4, A7, D1); a.asll_d(D1, D0); a.rts(); },
  // I_SHR: ... ASR.L D1,D0
  Shr(a) { a.movel_disp_d(8, A7, D0); a.movel_disp_d(4, A7, D1); a.asrl_d(D1, D0); a.rts(); },
  // I_LONG: MOVE.L 4(A7),A0 / MOVE.L (A0),D0 / RTS
  Long(a) { a.movel_disp_a(4, A7, A0); a.movel_ind_d(A0, D0); a.rts(); },
  // I_INT: MOVE.L 4(A7),A0 / MOVE.W (A0),D0 / EXT.L D0 / RTS
  Int(a) { a.movel_disp_a(4, A7, A0); a.movew_ind_d(A0, D0); a.extl(D0); a.rts(); },
  // I_CHAR: MOVE.L 4(A7),A0 / MOVEQ #0,D0 / MOVE.B (A0),D0 / RTS
  Char(a) { a.movel_disp_a(4, A7, A0); a.moveq(0, D0); a.moveb_ind_d(A0, D0); a.rts(); },
  // I_MIN: D0=4(A7), D1=8(A7); CMP.L D0,D1; BMI .1; RTS; .1: MOVE.L D1,D0; RTS
  Min(a) {
    a.movel_disp_d(4, A7, D0); a.movel_disp_d(8, A7, D1); a.cmpl_dd(D0, D1);
    a.bcc(MI, '_ifn_min1'); a.rts(); a.label('_ifn_min1'); a.movel_dd(D1, D0); a.rts();
  },
  // I_MAX: ... BPL .1 ...
  Max(a) {
    a.movel_disp_d(4, A7, D0); a.movel_disp_d(8, A7, D1); a.cmpl_dd(D0, D1);
    a.bcc(PL, '_ifn_max1'); a.rts(); a.label('_ifn_max1'); a.movel_dd(D1, D0); a.rts();
  },
  // I_SIGN: D0=4(A7); BMI .1; BEQ .2; MOVEQ #1,D0; RTS; .1: MOVEQ #-1,D0; RTS; .2: RTS
  Sign(a) {
    a.movel_disp_d(4, A7, D0); a.bcc(MI, '_ifn_sign1'); a.bcc(EQ, '_ifn_sign2');
    a.moveq(1, D0); a.rts();
    a.label('_ifn_sign1'); a.moveq(-1, D0); a.rts();
    a.label('_ifn_sign2'); a.rts();                 // D0 is already 0
  },
  // I_STRLEN: A0=4(A7); D1=A0; .1: TST.B (A0)+; BNE .1; SUBQ.L #1,A0; D0=A0; SUB.L D1,D0; RTS
  StrLen(a) {
    a.movel_disp_a(4, A7, A0); a.movel_ad(A0, D1);
    a.label('_ifn_strlen1'); a.tstb_postinc(A0); a.bne('_ifn_strlen1');
    a.subql_a(1, A0); a.movel_ad(A0, D0); a.subl_dd(D1, D0); a.rts();
  },

  // ---- heap + exceptions: thin wrappers around ecomp's own runtime, so a
  // linked module shares the program's single heap chain and exception chain.
  // New(size) -> ptr  (I_NEW allocs size+8 and links the AllocMem chain; __new does exactly this)
  New(a) { a.movel_disp_d(4, A7, D0); a.bsr('__new'); a.rts(); },
  FastNew(a) { a.movel_disp_d(4, A7, D0); a.bsr('__new'); a.rts(); },
  // NewR(size) / NewM(size, memf): like New but Raise("MEM") on failure
  NewR(a) {
    a.movel_disp_d(4, A7, D0); a.bsr('__new'); a.tstl(D0); a.bne('_ifn_newr_ok');
    a.movel_imm(0x4d454d, D0); a.bsr('__raise'); a.label('_ifn_newr_ok'); a.rts();
  },
  NewM(a) {
    a.movel_disp_d(8, A7, D0); a.bsr('__new'); a.tstl(D0); a.bne('_ifn_newm_ok');
    a.movel_imm(0x4d454d, D0); a.bsr('__raise'); a.label('_ifn_newm_ok'); a.rts();
  },
  // Dispose(ptr) ; FastDispose(ptr,size) — ecomp's __dispose reads size from the block header
  Dispose(a) { a.movel_disp_d(4, A7, D0); a.bsr('__dispose'); a.rts(); },
  FastDispose(a) { a.movel_disp_d(8, A7, D0); a.bsr('__dispose'); a.rts(); },
  // Raise(e) — set the exception value and unwind to the innermost HANDLE frame
  Raise(a) { a.movel_disp_d(4, A7, D0); a.bsr('__raise'); a.rts(); },
  // Throw(e, info) — also fills exceptioninfo (slot 24), then raises
  Throw(a) {
    a.movel_disp_d(4, A7, D0); a.movel_d_disp(D0, 24, A4);
    a.movel_disp_d(8, A7, D0); a.bsr('__raise'); a.rts();
  },
  // ReThrow — re-raise the current exception (slot 20)
  ReThrow(a) { a.movel_disp_d(20, A4, D0); a.bsr('__raise'); a.rts(); },

  // ---- simple string/list accessors (verbatim from ec68kifuncs.asm) ----
  // I_NOT (#Not_OLD): MOVE.L 4(A7),D0 / NOT.L D0 / RTS
  Not(a) { a.movel_disp_d(4, A7, D0); a.notl(D0); a.rts(); },
  // I_ESTRMAX (StrMax): A0=4(A7); D0=0; MOVE.W -4(A0),D0; RTS
  StrMax(a) { a.movel_disp_a(4, A7, A0); a.moveq(0, D0); a.movew_disp_d(-4, A0, D0); a.rts(); },
  // I_LISTLEN / I_LISTMAX: list length at -2(list), max at -4(list)
  ListLen(a) { a.movel_disp_a(4, A7, A0); a.moveq(0, D0); a.movew_disp_d(-2, A0, D0); a.rts(); },
  ListMax(a) { a.movel_disp_a(4, A7, A0); a.moveq(0, D0); a.movew_disp_d(-4, A0, D0); a.rts(); },
  // I_LISTITEM: D0=4(A7); LSL.L #2,D0; A0=8(A7); D0=(A0+D0); RTS
  ListItem(a) {
    a.movel_disp_d(4, A7, D0); a.asll_imm(2, D0);
    a.movel_disp_a(8, A7, A0); a.addal_d(D0, A0); a.movel_ind_d(A0, D0); a.rts();
  },

  // ---- string + graphics intrinsics: marshal stack args into D0.. and call
  // ecomp's existing runtime routines (arg counts match the IFUNCDEF table). ----
  StrCopy: wrap('__strcopy', 3),
  StrAdd: wrap('__stradd', 3),
  StrCmp: wrap('__strcmp', 3),
  OstrCmp: wrap('__ostrcmp', 3),
  InStr: wrap('__instr', 3),
  TrimStr: wrap('__trimstr', 1),
  UpperStr: wrap('__upperstr', 1),
  LowerStr: wrap('__lowerstr', 1),
  MidStr: wrap('__midstr', 4),
  RightStr: wrap('__rightstr', 3),
  SetStr: wrap('__setstr', 2),
  ReadStr: wrap('__readstr', 2),
  SetStdRast: wrap('__setstdrast', 1),
  Colour: wrap('__colour', 2),
  Plot: wrap('__plot', 3),
  Line: wrap('__line', 5),
  Box: wrap('__box', 5),

  // ---- more verbatim ports from ec68kifuncs.asm ----
  // I_VERSION (KickVersion): TRUE if running Kickstart >= requested version
  KickVersion(a) {
    a.movel_absw_a(4, A6); a.moveq(0, D1); a.movew_disp_d(20, A6, D1);
    a.movel_disp_d(4, A7, D0); a.cmpl_dd(D0, D1); a.bcc(MI, '_ifn_kv1');
    a.moveq(-1, D0); a.rts(); a.label('_ifn_kv1'); a.moveq(0, D0); a.rts();
  },
  // I_PUTLONG/PUTINT/PUTCHAR: store at (ptr)
  PutLong(a) { a.movel_disp_a(8, A7, A0); a.movel_disp_d(4, A7, D0); a.movel_d_ind(D0, A0); a.rts(); },
  PutInt(a) { a.movel_disp_a(8, A7, A0); a.movew_disp_d(6, A7, D0); a.movew_d_ind(D0, A0); a.rts(); },
  PutChar(a) { a.movel_disp_a(8, A7, A0); a.moveb_disp_d(7, A7, D0); a.moveb_d_ind(D0, A0); a.rts(); },
  // I_ABS: MOVE.L 4(A7),D0 / BPL .1 / NEG.L D0 / .1: RTS
  Abs(a) { a.movel_disp_d(4, A7, D0); a.bcc(PL, '_ifn_abs1'); a.negl(D0); a.label('_ifn_abs1'); a.rts(); },
  // I_NEXT: node.next is at -8(node)
  Next(a) {
    a.movel_disp_d(4, A7, D0); a.beq('_ifn_next1');
    a.movel_da(D0, A0); a.movel_disp_d(-8, A0, D0); a.label('_ifn_next1'); a.rts();
  },
  // I_FORWARD: walk a list num steps (each node header is 8 bytes back)
  Forward(a) {
    a.lea_disp(8, A7, A0); a.movel_disp_d(4, A7, D1); a.addql(1, D1);
    a.label('_ifn_fwd'); a.movel_ind_d(A0, D0); a.beq('_ifn_fwd1');
    a.movel_da(D0, A0); a.subql_a(8, A0); a.subql(1, D1); a.bne('_ifn_fwd');
    a.label('_ifn_fwd1'); a.rts();
  },
  // I_BOUNDS: clamp value (12(A7)) to [lower 8(A7), higher 4(A7)]
  Bounds(a) {
    a.movel_disp_d(12, A7, D0); a.movel_disp_d(4, A7, D1); a.cmpl_dd(D1, D0);
    a.bcc(MI, '_ifn_bnd1'); a.movel_dd(D1, D0); a.bra('_ifn_bndx');
    a.label('_ifn_bnd1'); a.movel_disp_d(8, A7, D1); a.cmpl_dd(D1, D0);
    a.bcc(PL, '_ifn_bndx'); a.movel_dd(D1, D0); a.label('_ifn_bndx'); a.rts();
  },
  // I_EVAL: call a function pointer
  Eval(a) { a.movel_disp_a(4, A7, A0); a.jsr_ind(A0); a.rts(); },
  // I_EVEN / I_ODD: test low bit, return E boolean
  Even(a) {
    a.movel_disp_d(4, A7, D0); a.moveq(1, D1); a.andl_dd(D1, D0); a.beq('_ifn_even1');
    a.moveq(0, D0); a.rts(); a.label('_ifn_even1'); a.moveq(-1, D0); a.rts();
  },
  Odd(a) {
    a.movel_disp_d(4, A7, D0); a.moveq(1, D1); a.andl_dd(D1, D0); a.bne('_ifn_odd1');
    a.moveq(0, D0); a.rts(); a.label('_ifn_odd1'); a.moveq(-1, D0); a.rts();
  },

  // I_WRITEF — the format engine. EC-compiled modules store format strings
  // pre-translated for exec RawDoFmt (that's why the original uses it), so we
  // format via RawDoFmt into a buffer and dos Write it to stdout. 1-for-1 with
  // ec68kifuncs.asm I_WRITEF, adapted to ecomp's A4 slots (stdout=0, dosbase=4)
  // and a LINK-frame scratch buffer instead of EC's -64(A4).
  // Stack: 4(A7)=arg-block size in bytes, 8(A7)=args (RawDoFmt data stream),
  // 8(A7)+size = format string. Returns the byte count written in D0.
  WriteF(a) {
    a.lea_disp(8, A7, A1);                 // A1 = RawDoFmt data stream (args)
    a.lea_disp(8, A7, A0);                 // A0 = &(args + size) = &fmt
    a.movel_disp_d(4, A7, D0); a.addal_d(D0, A0);
    a.movel_ind_d(A0, D1); a.movel_da(D1, A0);   // A0 = fmt
    a.movem_push(0x3030);                  // save d2,d3,a2,a3 (A0/A1 untouched)
    a.link(A5, 256);
    a.lea_disp(-256, A5, A3);              // A3 = output buffer (putdata)
    a.movel_ad(A3, D2);                    // D2 = buffer start (RawDoFmt preserves d2-d7/a2-a6)
    a.lea_pc('_ifn_wf_put', A2);           // A2 = PutChProc
    a.movel_absw_a(4, A6);                 // exec
    a.jsr_disp(-522, A6);                  // RawDoFmt
    a.movel_da(D2, A0);                    // strlen the result
    a.label('_ifn_wf_len'); a.tstb_postinc(A0); a.bne('_ifn_wf_len');
    a.movel_ad(A0, D3); a.subl_dd(D2, D3); a.subql(1, D3);   // D3 = len (excl nul)
    a.movel_disp_d(0, A4, D1);             // stdout handle
    a.beq('_ifn_wf_done');                 // WB / no console: drop output
    a.movel_disp_a(4, A4, A6);             // dosbase
    a.jsr_disp(-48, A6);                   // Write(D1, D2, D3)
    a.label('_ifn_wf_done');
    a.movel_dd(D3, D0);                    // return length
    a.unlk(A5);
    a.movem_pop(0x0c0c);
    a.rts();
    a.label('_ifn_wf_put'); a.moveb_d_postinc(D0, A3); a.rts();   // RawDoFmt PutCh
  },

  // I_STRINGF — like WriteF but formats into an estring. RawDoFmt into a buffer,
  // then copy into the estring via ecomp's __strcopy (estr, buf, -1=all).
  // Stack: 4(A7)=size, 8(A7)=args, 8+size=fmt, 12+size=estr. After movem (16)
  // the original offsets shift by 16.
  StringF(a) {
    a.movem_push(0x3030);                  // save d2,d3,a2,a3
    a.movel_disp_d(20, A7, D0);            // size (orig 4(A7))
    a.lea_disp(28, A7, A0); a.addal_d(D0, A0); a.movel_ind_d(A0, D3);  // D3 = estr
    a.lea_disp(24, A7, A1);                // A1 = args
    a.lea_disp(24, A7, A0); a.addal_d(D0, A0); a.movel_ind_d(A0, D1); a.movel_da(D1, A0); // A0 = fmt
    a.link(A5, 256);
    a.lea_disp(-256, A5, A3); a.movel_ad(A3, D2);   // D2 = buffer
    a.lea_pc('_ifn_sf_put', A2);
    a.movel_absw_a(4, A6); a.jsr_disp(-522, A6);    // RawDoFmt -> buffer
    a.movel_dd(D2, D1);                    // D1 = buffer (str)
    a.movel_dd(D3, D0);                    // D0 = estr
    a.moveq(-1, D2);                       // D2 = len (-1 = all)
    a.bsr('__strcopy');
    a.unlk(A5);
    a.movem_pop(0x0c0c);
    a.rts();
    a.label('_ifn_sf_put'); a.moveb_d_postinc(D0, A3); a.rts();
  },

  // ---- pool allocators: String()/List()/DisposeLink()/FastDisposeList ----
  // 1-for-1 with ec68kifuncs.asm, using ecomp's __estrpool slot (= EC's
  // -120(A4)) + exec AllocPooled(-708)/FreePooled(-714). 12-byte block header
  // [allocsize.l][link.l][maxlen.w len.w]; data follows, so estring -4=maxlen,
  // -2=len matches ecomp's own estrings.
  String(a, cg) {
    const pool = cg.globalSlot('__estrpool');
    a.movel_disp_d(4, A7, D0); a.addql(8, D0); a.addql(8, D0);   // size+16
    a.moveq(-4, D1); a.andl_dd(D1, D0);                          // round to *4
    a.movel_d_push(D0);
    a.movel_disp_a(pool, A4, A0); a.movel_absw_a(4, A6); a.jsr_disp(-708, A6);  // AllocPooled
    a.movel_pop_d(D1); a.tstl(D0); a.beq('_ifn_str_d');
    a.movel_da(D0, A0); a.movel_d_ind(D1, A0); a.clrl_disp(4, A0);
    a.movel_disp_d(4, A7, D1); a.swap(D1); a.movel_d_disp(D1, 8, A0);   // maxlen<<16
    a.lea_disp(12, A0, A0); a.movel_ad(A0, D0);
    a.label('_ifn_str_d'); a.rts();
  },
  List(a, cg) {
    const pool = cg.globalSlot('__estrpool');
    a.movel_disp_d(4, A7, D0); a.asll_imm(2, D0); a.addql(8, D0); a.addql(4, D0);  // num*4+12
    a.movel_d_push(D0);
    a.movel_disp_a(pool, A4, A0); a.movel_absw_a(4, A6); a.jsr_disp(-708, A6);
    a.movel_pop_d(D1); a.tstl(D0); a.beq('_ifn_lst_d');
    a.movel_da(D0, A0); a.movel_d_ind(D1, A0); a.clrl_disp(4, A0);
    a.movel_disp_d(4, A7, D1); a.swap(D1); a.movel_d_disp(D1, 8, A0);   // maxitems<<16
    a.lea_disp(12, A0, A0); a.movel_ad(A0, D0);
    a.label('_ifn_lst_d'); a.rts();
  },
  // DisposeLink: free a chain of pool blocks linked through -8(data)
  DisposeLink(a, cg) {
    const pool = cg.globalSlot('__estrpool');
    a.movel_disp_a(4, A7, A3);
    a.label('_ifn_dl'); a.movel_ad(A3, D0); a.beq('_ifn_dl_done');
    a.lea_disp(-12, A3, A1); a.movel_disp_a(-8, A3, A3);
    a.movel_disp_a(pool, A4, A0); a.movel_ind_d(A1, D0);
    a.movel_absw_a(4, A6); a.jsr_disp(-714, A6);                 // FreePooled
    a.bra('_ifn_dl'); a.label('_ifn_dl_done'); a.rts();
  },
  // FastDisposeList: FastNew lists live in the heap chain (FastNew -> __new)
  FastDisposeList(a) { a.movel_disp_d(4, A7, D0); a.bsr('__dispose'); a.rts(); },

  // I_SETLIST: set list length (clamped to max at -4)
  SetList(a) {
    a.moveq(0, D0); a.movew_disp_d(6, A7, D0); a.movel_disp_a(8, A7, A0);
    a.moveq(0, D1); a.movew_disp_d(-4, A0, D1); a.cmpl_dd(D1, D0);
    a.bcc(GT, '_ifn_setl1'); a.movew_d_disp(D0, -2, A0); a.label('_ifn_setl1'); a.rts();
  },
  // I_LISTCOPY: copy LEN items src->dest (LEN=-1 => src length), clamp to dest max
  ListCopy(a) {
    a.movew_disp_d(6, A7, D0); a.extl(D0);                 // len (signed)
    a.movel_disp_a(8, A7, A0); a.movel_disp_a(12, A7, A1); a.movel_aa(A1, A2);
    a.moveq(-1, D1); a.cmpl_dd(D1, D0); a.bne('_ifn_lc1');
    a.moveq(0, D0); a.movew_disp_d(-2, A0, D0);            // len := src length
    a.label('_ifn_lc1');
    a.moveq(0, D1); a.movew_disp_d(-4, A1, D1); a.cmpl_dd(D1, D0);
    a.bcc(MI, '_ifn_lc2'); a.movel_dd(D1, D0);             // clamp to dest max
    a.label('_ifn_lc2');
    a.moveq(1, D1); a.cmpl_dd(D1, D0); a.bcc(MI, '_ifn_lc3');  // len<1 -> done
    a.movew_d_disp(D0, -2, A1); a.subql(1, D0);
    a.label('_ifn_lc_l'); a.movel_postinc_postinc(A0, A1); a.dbra(D0, '_ifn_lc_l');
    a.label('_ifn_lc3'); a.movel_ad(A2, D0); a.rts();
  },
  // I_LISTADD: append LEN items src->dest (LEN=-1 => src length), up to dest free
  ListAdd(a) {
    a.movew_disp_d(6, A7, D0); a.extl(D0);
    a.movel_disp_a(8, A7, A0); a.movel_disp_a(12, A7, A1); a.movel_aa(A1, A2);
    a.moveq(-1, D1); a.cmpl_dd(D1, D0); a.bne('_ifn_la1');
    a.moveq(0, D0); a.movew_disp_d(-2, A0, D0);            // count := src length
    a.label('_ifn_la1');
    a.moveq(0, D1); a.movew_disp_d(-4, A1, D1);            // dest max
    a.moveq(0, D2); a.movew_disp_d(-2, A1, D2); a.subl_dd(D2, D1);   // D1 = free = max-len
    a.cmpl_dd(D1, D0); a.bcc(MI, '_ifn_la2'); a.movel_dd(D1, D0);    // clamp count to free
    a.label('_ifn_la2');
    a.moveq(1, D1); a.cmpl_dd(D1, D0); a.bcc(MI, '_ifn_la3');        // count<1 -> done
    a.moveq(0, D1); a.movew_disp_d(-2, A1, D1);            // D1 = old length
    a.movel_dd(D1, D3); a.addl_dd(D0, D3); a.movew_d_disp(D3, -2, A1);  // new len = old+count
    a.asll_imm(2, D1); a.addal_d(D1, A1);                 // A1 = base + oldlen*4 (append point)
    a.subql(1, D0);
    a.label('_ifn_la_l'); a.movel_postinc_postinc(A0, A1); a.dbra(D0, '_ifn_la_l');
    a.label('_ifn_la3'); a.movel_ad(A2, D0); a.rts();
  },
};
