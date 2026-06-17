// E-VO (modern Amiga E) stdlib builtins + runtime routines. Part of the
// optional EVO extension, reached only when the `evo` compiler flag is set:
// core codegen.js calls evoBuiltin() before its "not supported" error, and
// emitEvoRuntime() from emitRuntime(). Native (EC v3.3a) output is unchanged.
//
// E memory layouts these routines assume (oracle-verified, see core codegen):
//   estring : link.l @-8, maxlen.w @-4, len.w @-2, chars @0, NUL-terminated
//   elist   : maxlen.w @-4, len.w @-2, item.l @0 (4-byte items)
import {
  D0, D1, D2, D3, D4, D5, D6, D7, A0, A1, A2, A3, A4, A5, A6, A7,
} from '../asm68k.js';
import { Asm } from '../asm68k.js';
const COND = Asm.COND;

// Evaluate args[i] into D0. Helper bound to the codegen instance.
function arg(cg, e, i, ctx) { cg.exp(e.args[i], ctx); }

// Dispatch an E-VO stdlib builtin call. Returns true if handled. `cg` is the
// Codegen instance (exposes exp/uniq/a/globalSlot/err/…).
export function evoBuiltin(cg, name, e, ctx) {
  const a = cg.a;
  const fn = EVO_BUILTINS[name];
  if (!fn) return false;
  fn(cg, e, ctx, a);
  return true;
}

const EVO_BUILTINS = {
  // ---- Mem family ----
  // MemFill(addr, size, value): fill `size` bytes at addr with byte `value`.
  MemFill(cg, e, ctx, a) {
    arg(cg, e, 0, ctx); a.movel_d_push(D0);     // addr
    arg(cg, e, 1, ctx); a.movel_d_push(D0);     // size
    arg(cg, e, 2, ctx); a.movel_dd(D0, D1);     // value
    a.movel_pop_d(D2);                          // size
    a.movel_pop_a(A0);                          // addr
    const loop = cg.uniq('mfill'), done = cg.uniq('mfilld');
    a.label(loop);
    a.tstl(D2); a.bcc(COND.LE, done);
    a.moveb_d_postinc(D1, A0);                  // (A0)+ := val.b
    a.subql(1, D2);
    a.bra(loop);
    a.label(done);
  },
  // MemCompare(a, b, size): byte compare -> -1 / 0 / 1 (signed bytes).
  MemCompare(cg, e, ctx, a) {
    arg(cg, e, 0, ctx); a.movel_d_push(D0);     // a
    arg(cg, e, 1, ctx); a.movel_d_push(D0);     // b
    arg(cg, e, 2, ctx); a.movel_dd(D0, D2);     // size
    a.movel_pop_a(A1);                          // b
    a.movel_pop_a(A0);                          // a
    const loop = cg.uniq('mcmp'), eq = cg.uniq('mcmpe'),
      gt = cg.uniq('mcmpg'), done = cg.uniq('mcmpd');
    a.label(loop);
    a.tstl(D2); a.bcc(COND.LE, eq);             // ran out equal
    a.subql(1, D2);
    a.moveb_postinc_d(A0, D0); a.extw(D0); a.extl(D0);
    a.moveb_postinc_d(A1, D1); a.extw(D1); a.extl(D1);
    a.cmpl_dd(D1, D0);                          // a - b
    a.bcc(COND.EQ, loop);
    a.bcc(COND.GT, gt);
    a.moveq(-1, D0); a.bra(done);
    a.label(gt); a.moveq(1, D0); a.bra(done);
    a.label(eq); a.moveq(0, D0);
    a.label(done);
  },

  // ---- List allocation/length ---- (elist: maxlen.w@-4, len.w@-2, item.l@0)
  // List(n): allocate an n-item complex elist (len 0) -> ptr or NIL.
  List(cg, e, ctx, a) { arg(cg, e, 0, ctx); a.bsr('__newlist'); },
  // SetList(list, len): set the list length word.
  SetList(cg, e, ctx, a) {
    arg(cg, e, 0, ctx); a.movel_d_push(D0);
    arg(cg, e, 1, ctx); a.movel_dd(D0, D1);
    a.movel_pop_d(D0);
    a.movel_da(D0, A0);
    a.movew_d_disp(D1, -2, A0);
  },
};

// Emit the E-VO shared runtime routines (called once from emitRuntime).
export function emitEvoRuntime(cg) {
  const a = cg.a;
  // __newlist: d0 = item count -> d0 = complex elist ptr (or 0). Layout mirrors
  // __newstring: link.l@-8, maxlen.w@-4, len.w@-2, items@0 (4-byte items).
  const done = cg.uniq('nl_done');
  a.label('__newlist');
  a.movel_dd(D0, D4);                 // D4 = n (item count)
  a.asll_imm(2, D0);                  // n*4 bytes of items
  a.addql(8, D0);                     // + link.l + maxlen.w + len.w
  a.addql(4, D0);                     // + one spare slot (terminator headroom)
  a.bsr('__new');
  a.tstl(D0);
  a.beq(done);
  a.movel_da(D0, A0);
  a.movew_d_disp(D4, 4, A0);          // maxlen (link@0, len@6 stay 0)
  a.addql(8, D0);                     // -> items pointer
  a.label(done);
  a.rts();
}
