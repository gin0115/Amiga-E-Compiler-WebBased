// Code generator: E AST → M68000 machine code → hunk executable.
// Tracer-bullet subset: integer/locals/globals, full operator chain
// (left-to-right like ec), control flow, own PROC calls, WriteF with
// \d \s \c format codes. Strings and globals live in the single code hunk,
// addressed PC-relative — no relocations needed.
//
// Conventions:
//   D0       expression accumulator / return value
//   A4       globals base (set once at startup; slot 0 stdout, 4 dosbase)
//   A5       frame pointer: locals at -4.. args at 8+..
//   A6       scratch for library bases at call sites
import { Asm } from './asm68k.js';
import { writeHunk } from './hunk.js';
import { AsmText } from './asmtext.js';
import { ifuncName } from './ifuncs.js';
import { IFUNC_THUNKS } from './ifunc_thunks.js';

const D0 = 0, D1 = 1, D2 = 2, D3 = 3, D4 = 4, D5 = 5, D6 = 6, D7 = 7;
const A0 = 0, A1 = 1, A2 = 2, A3 = 3, A4 = 4, A5 = 5, A6 = 6, A7 = 7;
const COND = Asm.COND;

// A4 points this many bytes into the globals area so the standard E runtime
// globals can live at EC's fixed NEGATIVE offsets (GLOBVARTAB; EC's GLOBOFF is
// -512). Precompiled binary modules bake these offsets in, so ecomp must match
// the ABI — see docs/oop-dispatch.md / EC733_v33a.S:16356. ecomp's own runtime
// and all program/module data globals live at positive offsets from A4.
const A4_ORIGIN = 512;

const CMP_COND = { '=': 'EQ', '<>': 'NE', '<': 'LT', '>': 'GT', '<=': 'LE', '>=': 'GE' };

function typeSize(t) {
  if (!t) return 1; // bare ARRAY defaults to ARRAY OF CHAR (ch_8)
  switch (t.base) {
    case 'CHAR': return 1;
    case 'INT': return 2;
    default: return 4;
  }
}

export class Codegen {
  constructor(sem) {
    this.sem = sem;
    this.a = new Asm();
    this.errors = [];
    this.strings = new Map();   // value -> label
    this.lists = [];            // static areas for immediate lists
    this.quotes = [];           // out-of-line code for quoted expressions
    this.nlabel = 0;
    // Standard E runtime globals at EC's fixed A4 offsets (GLOBVARTAB,
    // EC733_v33a.S:16356) so precompiled binary modules — which reference these
    // directly, with no GLOBS entry — find them. ecomp's own runtime globals
    // and all program/module data globals are allocated at POSITIVE offsets.
    this.globalSlots = new Map([
      ['stdout', -8], ['__stdout', -8], ['conout', -12], ['stdrast', -16],
      ['arg', -32], ['wbmessage', -36], ['execbase', -40], ['sysbase', -40],
      ['dosbase', -44], ['__dosbase', -44], ['intuitionbase', -48], ['gfxbase', -52],
      ['__mathbase', -56], ['__mathtrans', -60],
      ['exception', -84], ['stdin', -92], ['exceptioninfo', -96],
      // ecomp-internal runtime slots (positive side of A4; offsets unchanged
      // from before the ABI alignment so existing fixed references still hold)
      ['__heap', 8], ['__startsp', 12], ['__exitcode', 16], ['__ehead', 28],
    ]);
    this.globalSize = 32;
    this.globalTypes = new Map();
  }

  err(node, msg) { this.errors.push({ line: node?.line, msg }); }
  uniq(p) { return `${p}_${this.nlabel++}`; }

  strLabel(value) {
    if (!this.strings.has(value)) this.strings.set(value, this.uniq('str'));
    return this.strings.get(value);
  }

  globalSlot(name) {
    if (!this.globalSlots.has(name)) {
      this.globalSlots.set(name, this.globalSize);
      this.globalSize += 4;
    }
    return this.globalSlots.get(name);
  }

  compile(program) {
    const a = this.a;
    if ((program.opts ?? []).some(o => /^MODULE/.test(o))) {
      this.err(null, 'OPT MODULE sources produce no executable (module output not yet supported)');
      return null;
    }
    if (!program.procs.some(p => p.name === 'main' && !p.of)) {
      this.err(null, 'no PROC main()');
      return null;
    }
    this.globalInits = [];
    const allDecls = [...program.decls, ...(this.sem.importedDecls ?? [])];
    for (const d of allDecls) {
      if (d.kind === 'Def') for (const v of d.decls) {
        const slot = this.globalSlot(v.name);
        if (v.type) this.globalTypes.set(v.name, v.type);
        if (!v.size) continue;
        // sized globals get buffers in the globals area, wired at startup
        const count = this.sem.foldConst(v.size);
        if (count === null) { this.err(d, `size of global ${v.name} must be constant`); continue; }
        const base = v.type?.base;
        if (base === 'STRING' || base === 'LIST') {
          const esz = base === 'LIST' ? 4 : 1;
          const buf = this.globalSize;
          this.globalSize += (4 + count * esz + 2) & ~1;
          this.globalInits.push({ slot, buf, kind: 'STRING', count });
        } else if (base === 'ARRAY' || !base) {
          const buf = this.globalSize;
          this.globalSize += (count * typeSize(v.type?.of) + 1) & ~1;
          this.globalInits.push({ slot, buf, kind: 'ARRAY', count });
        } else {
          this.err(d, `unsupported sized global type ${base} for ${v.name}`);
        }
      }
    }
    // library base variables from imported modules (intuitionbase, aslbase…)
    for (const base of this.sem.libBases?.keys() ?? []) this.globalSlot(base);
    // E builtin globals filled by the startup code
    for (const g of ['arg', 'stdin', 'conout', 'stdrast', 'wbmessage']) this.globalSlot(g);
    // mathieeesingtrans.library is disk-based: only open when F-functions
    // are used (singbas is ROM-resident and cheap, opened always)
    this.usesTrans = /"name":"F(sin|cos|tan|exp|log|log10|pow|sqrt|atan|asin|acos)"/
      .test(JSON.stringify(program));
    // a linked binary module may itself call a transcendental intrinsic
    // (Fsin/Fcos/…) — open mathieeesingtrans for it too
    const TRANS = /^F(sin|cos|tan|exp|log|log10|pow|sqrt|atan|asin|acos|sincos)$/;
    for (const m of this.sem.binaryModules ?? []) {
      for (const r of m.relocs ?? []) {
        if (r.kind === 'ifunc' && TRANS.test(ifuncName(r.ifuncNum) ?? '')) this.usesTrans = true;
      }
    }
    this.emitStartup();
    this.emitRuntime();
    for (const p of program.procs) this.emitProc(p);
    for (const p of this.sem.importedProcs ?? []) {
      const label = p.of ? `proc_${p.of}$${p.name}` : `proc_${p.name}`;
      if (!this.a.labels.has(label)) this.emitProc(p);
    }
    this.emitBinaryModules();
    this.emitData();
    if (this.errors.length) return null;
    const code = a.finish();
    // diagnostics for verbose builds (ignored by callers that don't want them)
    this.stats = {
      codeBytes: code.length,
      relocCount: a.relocs.length,
      globalSize: this.globalSize,
      modules: (this.sem.binaryModules ?? []).map(m => ({
        name: m.name,
        codeBytes: m.code ? m.code.length : 0,
        procs: (m.procs ?? []).filter(p => p.kind !== 'label').length,
        relocs: (m.relocs ?? []).length,
      })),
    };
    return writeHunk(code, a.relocs);
  }

  // Classify a module's external-global base name: library (OpenLibrary),
  // resource (OpenResource), or null (E-runtime global / module-internal data,
  // bound to its own A4 slot). libname = strip 'base' + '.library' with a few
  // irregular overrides.
  static moduleOpenInfo(base) {
    const RESOURCE = {
      battclockbase: 'battclock.resource', battmembase: 'battmem.resource',
      diskbase: 'disk.resource', miscbase: 'misc.resource', potgobase: 'potgo.resource',
      cardresbase: 'card.resource', filesysresbase: 'FileSystem.resource',
    };
    const LIBOVERRIDE = {
      rexxsysbase: 'rexxsyslib.library', cxbase: 'commodities.library',
      gfxbase: 'graphics.library', sysbase: 'exec.library', execbase: 'exec.library',
    };
    if (RESOURCE[base]) return { kind: 'resource', name: RESOURCE[base] };
    if (LIBOVERRIDE[base]) return { kind: 'lib', name: LIBOVERRIDE[base] };
    if (/base$/.test(base)) return { kind: 'lib', name: base.replace(/base$/, '') + '.library' };
    return null;   // ctrlc, sin_table, *count, catalogList … bound to own slot
  }

  // Link binary code modules: append each module's CODE blob, resolve its
  // exported PROCs to labels inside it, emit the runtime intrinsic (ifunc)
  // thunks it calls, and fix up its relocations.
  emitBinaryModules() {
    const mods = this.sem.binaryModules ?? [];
    if (!mods.length) return;
    const a = this.a;

    // 1. which E intrinsics do the linked modules call? emit a thunk per name.
    // deprecated intrinsics keep a `#…_OLD` table name but share the base
    // implementation (e.g. #Not_OLD -> Not, #DisposeLink_OLD -> DisposeLink)
    const norm = n => n && n.replace(/^#/, '').replace(/_OLD$/, '');
    const needed = new Set();
    const missing = new Set();
    for (const m of mods) {
      for (const r of m.relocs) {
        if (r.kind !== 'ifunc') continue;
        const name = norm(ifuncName(r.ifuncNum));
        if (name && IFUNC_THUNKS[name]) needed.add(name);
        else missing.add(name ?? `#${r.ifuncNum}`);
      }
    }
    if (missing.size) {
      this.err({ line: 0 }, `intrinsics not yet ported: ${[...missing].join(', ')}`);
      return;
    }
    for (const name of needed) {
      const label = `ifunc_${name}`;
      if (a.labels.has(label)) continue;
      a.align();
      a.label(label);
      IFUNC_THUNKS[name](a, this);     // some thunks need globalSlot (e.g. the pool)
    }

    // 2. append each module's code, resolve its procs, fix up its relocations.
    for (const m of mods) {
      a.align();
      const base = a.pc;
      a.blob(m.code);
      for (const p of m.procs) {
        if (p.kind === 'proc' || p.kind === 'label') {
          const label = `proc_${p.name}`;
          if (!a.labels.has(label)) a.labelAt(label, base + p.offset);
        }
      }
      // class descriptor-builders live inside the module code at `delcode`
      // (PC-relative LEAs, so no relocs) — label them for NEW to call.
      for (const cls of this.sem.binaryClasses?.values() ?? []) {
        if (cls.module === m.name && cls.delcode != null) {
          const label = `moddescr_${cls.name}`;
          if (!a.labels.has(label)) a.labelAt(label, base + cls.delcode);
        }
      }
      for (const r of m.relocs) {
        if (r.kind === 'abs') {
          // rebase the absolute longword (a module-internal code/data pointer)
          // to its final position, and record a HUNK_RELOC32 entry.
          const at = base + r.offset;
          const cur = ((a.bytes[at] << 24) | (a.bytes[at + 1] << 16) |
            (a.bytes[at + 2] << 8) | a.bytes[at + 3]) >>> 0;
          const nv = (cur + base) >>> 0;
          a.bytes[at] = (nv >>> 24) & 0xff;
          a.bytes[at + 1] = (nv >>> 16) & 0xff;
          a.bytes[at + 2] = (nv >>> 8) & 0xff;
          a.bytes[at + 3] = nv & 0xff;
          a.reloc32At(at);
        } else if (r.kind === 'ifunc') {
          // The placeholder is `jsr abs.L $0` (0x4EB9). Keep that opcode — it's
          // 68000-safe — and bind its 32-bit operand to the runtime thunk's
          // absolute address with a HUNK_RELOC32. (Rewriting to bsr.L / 0x61FF
          // would be a 68020-only instruction, so ecomp output would crash on a
          // plain 68000 where EC's does not.)
          a.abs32At(base + r.offset, `ifunc_${norm(ifuncName(r.ifuncNum))}`);
        }
      }
      // bind external-global refs: patch each A4-relative displacement to the
      // shared slot for that symbol (library/resource base opened at startup,
      // or a runtime/data slot).
      for (const x of m.globs?.xrefs ?? []) {
        const slot = this.globalSlot(x.name);
        for (const off of x.refs) {
          const at = base + off;
          a.bytes[at] = (slot >> 8) & 0xff;
          a.bytes[at + 1] = slot & 0xff;
        }
      }
      // bind module-private global refs (GLOBS "drels"): each drel entry is ONE
      // module-private global variable (e.g. amigalib/random's RNG seed). EC
      // bakes all its refs with the same -516 placeholder displacement and
      // relocates them to the variable's assigned global-area slot. Allocate a
      // slot per drel entry (4 bytes — scalar LONG, the common case) and patch
      // every ref's 16-bit A4 displacement to it. The slot lands in the zeroed
      // __globals BSS, so the variable starts at 0 like EC's.
      const drels = m.globs?.drels ?? [];
      for (let j = 0; j < drels.length; j++) {
        const slot = this.globalSlot(`__drel_${m.name}_${j}`);
        for (const off of drels[j].refs) {
          const at = base + off;
          a.bytes[at] = (slot >> 8) & 0xff;
          a.bytes[at + 1] = slot & 0xff;
        }
      }
      // bind cross-module class-inheritance refs (MODINFO): each ref site is a
      // placeholder `jsr abs.L $0` calling the parent class's descriptor-builder
      // in another linked module. Patch to `bsr.L` into moddescr_<parent>, like
      // the ifunc relocs. (A class ref is to the parent's builder at delcode.)
      for (const mi of m.modinfo ?? []) {
        // cross-module PROC reference: a module that calls a proc exported by
        // another linked module (e.g. tools/simplelex calls tools/ctype's
        // isalnum). The call site is a placeholder `jsr abs.L $0`; bind it to
        // proc_<symbol> (resolved at finish(), like an ifunc thunk). Only bind
        // procs we actually linked.
        if (mi.kind === 'proc') {
          if (!this.sem.binaryProcs?.has(mi.symbol)) continue;
          for (const r of mi.refs) {
            const op = base + r.coff - 2;
            if (a.bytes[op] !== 0x4e || a.bytes[op + 1] !== 0xb9) continue;  // expect jsr abs.L
            // keep `jsr abs.L` (68000-safe); bind its operand to proc_<symbol>
            // with a reloc, rather than rewriting to the 68020-only bsr.L.
            a.abs32At(base + r.coff, `proc_${mi.symbol}`);
          }
          continue;
        }
        if (!this.sem.binaryClasses?.has(mi.symbol)) continue;   // only class parents we linked
        const target = `moddescr_${mi.symbol}`;
        for (const r of mi.refs) {
          const op = base + r.coff - 2;
          if (a.bytes[op] === 0x4e && a.bytes[op + 1] === 0xb9) {
            // flavor 1 — `jsr abs.L $0` calling the parent class's descriptor
            // BUILDER. Keep the 68000-safe jsr abs.L and bind its operand to the
            // builder label with a reloc (not the 68020-only bsr.L).
            a.abs32At(base + r.coff, target);
          } else {
            // flavor 2 — an instruction reading the parent class's descriptor
            // POINTER from a fixed A4 slot (e.g. `move.l ($0,A4),(A0)` when a
            // module method does `NEW <parentclass>`). The 16-bit A4
            // displacement at coff is a placeholder ($0); bind it to the
            // parent's descriptor slot (populated at startup by
            // emitDescriptorTable). globalSlot/binaryClassGlobals memoises, so
            // ordering vs emitDescriptorTable does not matter.
            const slot = this.binaryClassGlobals(this.sem.binaryClasses.get(mi.symbol)).ptrSlot;
            a.bytes[base + r.coff] = (slot >> 8) & 0xff;
            a.bytes[base + r.coff + 1] = slot & 0xff;
          }
        }
      }
      // bind OACC (object-access) refs: a SAME-MODULE class method doing
      // `NEW <class>` reads that class's descriptor pointer from a fixed A4 slot
      // via a `move.l ($0,A4),...` placeholder. Each OACC entry records the
      // 16-bit displacement location; patch it to the class's descriptor slot
      // (populated at startup by emitDescriptorTable). Cross-module descriptor
      // reads are handled above via MODINFO; OACC is the self/sibling case.
      for (const [, obj] of m.objects ?? []) {
        if (!obj.oacc?.length) continue;
        const cls = this.sem.binaryClasses?.get(obj.name);
        if (!cls) continue;
        const slot = this.binaryClassGlobals(cls).ptrSlot;
        for (const acc of obj.oacc) {
          a.bytes[base + acc.coff] = (slot >> 8) & 0xff;
          a.bytes[base + acc.coff + 1] = slot & 0xff;
        }
      }
    }
  }

  emitStartup() {
    const a = this.a;
    a.movel_a_push(A0);                // command line ptr (for `arg`)
    a.movem_push(0x3f3e);              // save d2-d7/a2-a6 for the shell
    a.movel_absw_a(4, A6);             // execbase
    // Workbench launch protocol (like real E): a process with pr_CLI = NIL
    // was started from WB and MUST collect its startup message — and reply
    // it at exit — or the machine crashes when it terminates.
    a.moveq(0, D7);                    // wbmessage (0 = CLI start)
    a.moveq(0, D0);
    a.movel_da(D0, A1);
    a.jsr_disp(-294, A6);              // FindTask(NIL)
    a.movel_da(D0, A2);
    a.tstl_disp(172, A2);              // pr_CLI
    a.bne('__from_cli');
    a.lea_disp(92, A2, A0);            // pr_MsgPort
    a.jsr_disp(-384, A6);              // WaitPort
    a.lea_disp(92, A2, A0);
    a.jsr_disp(-372, A6);              // GetMsg
    a.movel_dd(D0, D7);
    a.label('__from_cli');
    a.lea_pc('__dosname', A1);
    a.moveq(0, D0);
    a.jsr_disp(-552, A6);              // OpenLibrary('dos.library', 0)
    a.tstl(D0);
    a.beq('__quit');
    a.lea_pc('__globals', A4);
    a.addal_imm(A4_ORIGIN, A4);        // A4 -> origin; standard globals lie below
    a.movel_a_disp(A7, this.globalSlot('__startsp'), A4);  // SP for CleanUp() unwinding
    a.movel_d_disp(D0, this.globalSlot('dosbase'), A4);    // dosbase
    a.movel_disp_d(44, A7, D0);        // command line ptr (pushed at entry)
    a.movel_d_disp(D0, this.globalSlot('arg'), A4);
    a.movel_d_disp(D7, this.globalSlot('wbmessage'), A4);
    a.tstl(D7);
    a.beq('__arg_cli');
    a.lea_pc('__emptystr', A0);        // WB start: no command line
    a.movel_ad(A0, D0);
    a.movel_d_disp(D0, this.globalSlot('arg'), A4);
    a.label('__arg_cli');
    a.movel_disp_a(this.globalSlot('dosbase'), A4, A6);
    a.jsr_disp(-60, A6);               // Output()
    a.movel_d_disp(D0, this.globalSlot('stdout'), A4);     // stdout
    a.movel_disp_a(this.globalSlot('dosbase'), A4, A6);
    a.jsr_disp(-54, A6);               // Input()
    a.movel_d_disp(D0, this.globalSlot('stdin'), A4);
    if (this.globalSlots.has('execbase')) {
      a.movel_absw_d(4, D0);
      a.movel_d_disp(D0, this.globalSlots.get('execbase'), A4);
    }
    {
      // seed Rnd() from the clock: DateStamp into 12 scratch bytes
      const seedSlot = this.globalSlot('__seed');
      const scratch = this.globalSlot('__dsscratch');
      this.globalSlot('__dsscratch2');
      this.globalSlot('__dsscratch3');
      a.lea_disp(scratch, A4, A0);
      a.movel_ad(A0, D1);
      a.movel_disp_a(this.globalSlot('dosbase'), A4, A6);
      a.jsr_disp(-192, A6);              // DateStamp(d1)
      a.movel_disp_d(scratch + 4, A4, D0);
      a.movel_disp_d(scratch + 8, A4, D1);
      a.eorl_dd(D1, D0);
      a.movel_d_disp(D0, seedSlot, A4);
    }
    {
      // exec memory pool for the String()/List()/DisposeLink() intrinsics that
      // linked binary modules call (EC keeps this at -120(A4); CreatePool(NIL,
      // 4096, 256) matches the original runtime).
      const pool = this.globalSlot('__estrpool');
      a.moveq(0, D0);
      a.movel_imm(4096, D1);
      a.movel_imm(256, D2);
      a.movel_absw_a(4, A6);
      a.jsr_disp(-696, A6);              // CreatePool
      a.movel_d_disp(D0, pool, A4);
    }
    {
      // task stack lower bound, for the FreeStack() intrinsic (EC keeps it at
      // -64(A4)); read tc_SPLower (offset 58) from this task.
      const sp = this.globalSlot('__splower');
      a.moveq(0, D0); a.movel_da(D0, A1); a.movel_absw_a(4, A6);
      a.jsr_disp(-294, A6);              // FindTask(NIL)
      a.movel_da(D0, A0);
      a.movel_disp_d(58, A0, D0);        // tc_SPLower
      a.movel_d_disp(D0, sp, A4);
    }
    for (const gi of this.globalInits) {
      if (gi.kind === 'STRING') {
        a.movew_imm_disp(gi.count, gi.buf, A4);
        a.clrw_disp(gi.buf + 2, A4);
        a.clrb_disp(gi.buf + 4, A4);
        a.lea_disp(gi.buf + 4, A4, A0);
      } else {
        a.lea_disp(gi.buf, A4, A0);
      }
      a.movel_a_disp(A0, gi.slot, A4);
    }
    // E auto-opens intuition + graphics at startup, unconditionally
    // (verified by tracing real ec binaries); other library bases stay NIL
    // until the program OpenLibrary()s them itself
    const autoLibs = [
      ['intuitionbase', 'intuition.library'],
      ['gfxbase', 'graphics.library'],
      ['__mathbase', 'mathieeesingbas.library'],
    ];
    if (this.usesTrans) autoLibs.push(['__mathtrans', 'mathieeesingtrans.library']);
    for (const [base, lib] of autoLibs) {
      a.movel_absw_a(4, A6);
      a.lea_pc(this.strLabel(lib), A1);
      a.moveq(0, D0);
      a.jsr_disp(-552, A6);            // OpenLibrary
      a.movel_d_disp(D0, this.globalSlot(base), A4);
    }
    // Open the libraries/resources that linked binary modules reference as
    // external globals (GLOBS xrefs). Bases already auto-opened are skipped.
    this.openedLibSlots = [];
    {
      const autoBases = new Set(['intuitionbase', 'gfxbase', '__mathbase', '__mathtrans']);
      const seen = new Set();
      for (const m of this.sem.binaryModules ?? []) {
        for (const x of m.globs?.xrefs ?? []) {
          const info = Codegen.moduleOpenInfo(x.name);
          if (!info || autoBases.has(x.name) || seen.has(x.name)) continue;
          seen.add(x.name);
          const slot = this.globalSlot(x.name);
          a.movel_absw_a(4, A6);
          a.lea_pc(this.strLabel(info.name), A1);
          if (info.kind === 'resource') {
            a.jsr_disp(-498, A6);        // OpenResource(A1)
          } else {
            a.moveq(0, D0);
            a.jsr_disp(-552, A6);        // OpenLibrary(A1, 0)
            this.openedLibSlots.push(slot);
          }
          a.movel_d_disp(D0, slot, A4);
        }
      }
    }
    this.emitDescriptorTable();        // build all linked class descriptors
    a.bsr('proc_main');
    a.label('__exit');                 // CleanUp() lands here with SP restored
    a.bsr('__freeall');                // release NEW/New/String allocations
    for (const slot of this.openedLibSlots ?? []) {   // close module libraries
      a.movel_disp_a(slot, A4, A1);
      a.tstl_disp(slot, A4);
      a.beq(`__skipclose_${slot}`);
      a.movel_absw_a(4, A6);
      a.jsr_disp(-414, A6);            // CloseLibrary
      a.label(`__skipclose_${slot}`);
    }
    a.movel_disp_a(this.globalSlot('dosbase'), A4, A1);    // dosbase -> a1
    a.movel_absw_a(4, A6);
    a.jsr_disp(-414, A6);              // CloseLibrary
    a.movel_disp_d(this.globalSlot('wbmessage'), A4, D2);
    a.label('__quit2');                // d2 = wbmessage (or 0)
    a.tstl(D2);
    a.beq('__noreply');
    a.movel_absw_a(4, A6);
    a.jsr_disp(-132, A6);              // Forbid() — WB must not unload us early
    a.movel_da(D2, A1);
    a.movel_absw_a(4, A6);
    a.jsr_disp(-378, A6);              // ReplyMsg(wbmessage)
    a.label('__noreply');
    a.movel_disp_d(this.globalSlot('__exitcode'), A4, D0);  // exit code (CleanUp, else 0)
    a.movem_pop(0x7cfc);
    a.addql_a(4, A7);                  // drop saved command line ptr
    a.rts();
    a.label('__quit');                 // dos.library failed to open
    a.movel_dd(D7, D2);
    a.bra('__quit2');
  }

  emitRuntime() {
    const a = this.a;

    // __udivmod: d0/d1 unsigned -> quotient d0, remainder d1
    a.label('__udivmod');
    a.movem_push((1 << (15 - D2)) | (1 << (15 - D3)));
    a.movel_dd(D1, D2);
    a.moveq(0, D1);
    a.moveq(31, D3);
    a.label('__ud_loop');
    a.addl_dd(D0, D0);
    a.addxl_dd(D1, D1);
    a.cmpl_dd(D2, D1);
    a.bcc(COND.CS, '__ud_skip');
    a.subl_dd(D2, D1);
    a.addql(1, D0);
    a.label('__ud_skip');
    a.dbra(D3, '__ud_loop');
    a.movem_pop((1 << D2) | (1 << D3));
    a.rts();

    // __sdivmod: d0/d1 SIGNED -> quotient d0, remainder d1 (truncate toward
    // zero; remainder takes the dividend's sign). 68000-safe wrapper around the
    // unsigned __udivmod — used by the Mul/Div/Mod ifunc thunks instead of the
    // 68020-only muls.l/divs.l, so ecomp output runs on a plain 68000 like EC's.
    a.label('__sdivmod');
    a.movel_d_push(D4);              // D4 = quotient-sign flag
    a.movel_d_push(D5);              // D5 = remainder-sign flag (= dividend sign)
    a.moveq(0, D4);
    a.moveq(0, D5);
    a.tstl(D0);
    a.bcc(COND.PL, '__sd_dpos');     // dividend >= 0?
    a.negl(D0);                      // abs(dividend)
    a.moveq(-1, D4);                 // quotient negative so far
    a.moveq(-1, D5);                 // remainder negative
    a.label('__sd_dpos');
    a.tstl(D1);
    a.bcc(COND.PL, '__sd_npos');     // divisor >= 0?
    a.negl(D1);                      // abs(divisor)
    a.notl_d(D4);                    // toggle quotient sign
    a.label('__sd_npos');
    a.bsr('__udivmod');              // D0=quot, D1=rem (unsigned)
    a.tstl(D4);
    a.beq('__sd_q');
    a.negl(D0);                      // apply quotient sign
    a.label('__sd_q');
    a.tstl(D5);
    a.beq('__sd_done');
    a.negl(D1);                      // apply remainder sign
    a.label('__sd_done');
    a.movel_pop_d(D5);
    a.movel_pop_d(D4);
    a.rts();

    // __itoa: d0 -> decimal ascii at (a2)+
    a.label('__itoa');
    a.movem_push((1 << (15 - D3)));
    a.tstl(D0);
    a.bne('__it_nz');
    a.moveb_imm_postinc(48, A2);       // '0'
    a.bra('__it_done');
    a.label('__it_nz');
    a.bcc(COND.PL, '__it_pos');
    a.moveb_imm_postinc(45, A2);       // '-'
    a.negl(D0);
    a.label('__it_pos');
    a.moveq(0, D3);
    a.label('__it_loop');
    a.tstl(D0);
    a.beq('__it_emit');
    a.moveq(10, D1);
    a.bsr('__udivmod');
    a.addib_imm(48, D1);
    a.movew_d_push(D1);
    a.addql(1, D3);
    a.bra('__it_loop');
    a.label('__it_emit');
    a.tstl(D3);
    a.beq('__it_done');
    a.movew_pop_d(D1);
    a.moveb_d_postinc(D1, A2);
    a.subql(1, D3);
    a.bra('__it_emit');
    a.label('__it_done');
    a.movem_pop(1 << D3);
    a.rts();

    // __htoa: d0=value (unsigned) → uppercase hex to A2 (advances), no leading
    // zeros, matching E's WriteF \h. Digits pushed low→high, popped to reverse.
    a.label('__htoa');
    a.movel_d_push(D3);
    a.tstl(D0);
    a.bne('__ht_nz');
    a.moveb_imm_postinc(48, A2);       // '0'
    a.bra('__ht_done');
    a.label('__ht_nz');
    a.moveq(0, D3);                    // digit count
    a.label('__ht_loop');
    a.tstl(D0);
    a.beq('__ht_emit');
    a.movel_dd(D0, D1);
    a.andil_imm(15, D1);               // low nibble
    a.cmpib_imm(10, D1);
    a.bcc(COND.CS, '__ht_dig');        // <10 → '0'..'9'
    a.addib_imm(55, D1);               // 'A'-10
    a.bra('__ht_push');
    a.label('__ht_dig');
    a.addib_imm(48, D1);               // '0'
    a.label('__ht_push');
    a.movew_d_push(D1);
    a.addql(1, D3);
    a.lsrl_imm(4, D0);                 // unsigned >> 4
    a.bra('__ht_loop');
    a.label('__ht_emit');
    a.tstl(D3);
    a.beq('__ht_done');
    a.movew_pop_d(D1);
    a.moveb_d_postinc(D1, A2);
    a.subql(1, D3);
    a.bra('__ht_emit');
    a.label('__ht_done');
    a.movel_pop_d(D3);
    a.rts();

    // __format: core E format engine. a0=fmt, a1=args, a2=out; advances a2.
    a.label('__format');
    a.movem_push(0x0f00);              // save D4-D7 (field-width scratch)
    a.label('__wf_loop');
    a.moveb_postinc_d(A0, D0);
    a.tstb(D0);
    a.beq('__wf_done');
    a.cmpib_imm(0x5c, D0);             // backslash
    a.bne('__wf_lit');
    a.moveb_postinc_d(A0, D0);
    a.tstb(D0);
    a.beq('__wf_done');
    a.cmpib_imm(100, D0);              // 'd'
    a.beq('__wf_dec');
    a.cmpib_imm(115, D0);              // 's'
    a.beq('__wf_str');
    a.cmpib_imm(99, D0);               // 'c'
    a.beq('__wf_char');
    a.cmpib_imm(104, D0);              // 'h' — hex (uppercase, no leading zeros)
    a.beq('__wf_hex');
    a.moveb_imm_postinc(0x5c, A2);     // unknown: keep both chars
    a.label('__wf_lit');
    a.moveb_d_postinc(D0, A2);
    a.bra('__wf_loop');
    // args are pushed LEFT-to-RIGHT (E evaluation order), so successive
    // arguments live at DESCENDING stack addresses: fetch then subtract
    // \d[n] — decimal, zero-padded to MINIMUM width n (never truncated). A
    // negative sign is printed first, then the magnitude is padded, matching
    // EC: \d[6] of -42 -> "-000042".
    a.label('__wf_dec');
    a.bsr('__wf_getwidth');            // D5 = field width (0 if no [n])
    a.movel_ind_d(A1, D0);
    a.subql_a(4, A1);
    a.bcc(COND.PL, '__wf_dec_pos');    // value >= 0?
    a.moveb_imm_postinc(45, A2);       // '-'
    a.negl(D0);
    a.label('__wf_dec_pos');
    a.moveq(48, D4);                   // pad with '0'
    a.bsr('__wf_decdigits');           // D6 = digit count (D0 preserved)
    a.movel_dd(D6, D1);
    a.bsr('__wf_padto');               // emit max(0, width-count) pad chars
    a.bsr('__itoa');                   // render the magnitude
    a.bra('__wf_loop');
    // \h[n] — hex (uppercase), zero-padded to MINIMUM width n (never truncated).
    a.label('__wf_hex');
    a.bsr('__wf_getwidth');
    a.movel_ind_d(A1, D0);
    a.subql_a(4, A1);
    a.moveq(48, D4);                   // pad with '0'
    a.bsr('__wf_hexdigits');           // D6 = hex digit count (D0 preserved)
    a.movel_dd(D6, D1);
    a.bsr('__wf_padto');
    a.bsr('__htoa');
    a.bra('__wf_loop');
    // \s[n] — string in a FIXED field of width n: space-padded (right-justified)
    // if short, truncated to the first n chars if long. EC: \s[2] of 'hello' = "he".
    a.label('__wf_str');
    a.bsr('__wf_getwidth');
    a.movel_ind_d(A1, D0);
    a.subql_a(4, A1);
    a.moveq(32, D4);                   // pad with space
    a.movel_da(D0, A3);                // A3 = string
    a.bsr('__wf_strlen_a3');           // D6 = length (A3 preserved)
    a.movel_dd(D6, D1);
    a.bsr('__wf_padto');               // emit max(0, width-len) spaces
    a.movel_dd(D6, D1);                // chars to copy = len, unless...
    a.tstl(D5);
    a.beq('__wf_strc');                // no width -> copy whole string
    a.cmpl_dd(D5, D6);                 // len - width
    a.bcc(COND.LT, '__wf_strc');       // len < width -> copy len
    a.movel_dd(D5, D1);                // else copy width chars (truncate)
    a.label('__wf_strc');
    a.tstl(D1);
    a.bcc(COND.LE, '__wf_loop');       // copied enough -> next directive
    a.moveb_postinc_d(A3, D0);
    a.moveb_d_postinc(D0, A2);
    a.subql(1, D1);
    a.bra('__wf_strc');
    a.label('__wf_char');
    a.movel_ind_d(A1, D0);
    a.subql_a(4, A1);
    a.moveb_d_postinc(D0, A2);
    a.bra('__wf_loop');
    a.label('__wf_done');
    a.movem_pop(0x00f0);               // restore D4-D7
    a.rts();

    // ---- field-width helpers for \d[n] \h[n] \s[n] (shared by WriteF/StringF) ----
    // __wf_getwidth: parse an optional [n] at (a0). D5 = width (0 if absent),
    // a0 advanced past the spec. Clobbers D0/D1/D5.
    a.label('__wf_getwidth');
    a.moveq(0, D5);
    a.moveb_postinc_d(A0, D0);
    a.cmpib_imm(0x5b, D0);             // '['
    a.beq('__gw_loop');
    a.subql_a(1, A0);                  // not a width spec — put the char back
    a.rts();
    a.label('__gw_loop');
    a.moveb_postinc_d(A0, D0);
    a.cmpib_imm(0x5d, D0);             // ']'
    a.beq('__gw_done');
    a.movel_dd(D5, D1);                // D5 := D5*10 + digit
    a.asll_imm(3, D5);
    a.addl_dd(D1, D5);
    a.addl_dd(D1, D5);
    a.andil_imm(15, D0);               // '0'..'9' low nibble = digit value
    a.addl_dd(D0, D5);
    a.bra('__gw_loop');
    a.label('__gw_done');
    a.rts();
    // __wf_padto: emit max(0, D5-D1) copies of pad char D4 to (a2). D0 preserved.
    a.label('__wf_padto');
    a.movel_dd(D5, D7);
    a.subl_dd(D1, D7);                 // D7 = width - count
    a.label('__pt_loop');
    a.tstl(D7);
    a.bcc(COND.LE, '__pt_done');
    a.moveb_d_postinc(D4, A2);
    a.subql(1, D7);
    a.bra('__pt_loop');
    a.label('__pt_done');
    a.rts();
    // __wf_decdigits: D6 = number of decimal digits in D0 (>=0); D0 preserved.
    a.label('__wf_decdigits');
    a.movel_d_push(D0);
    a.moveq(1, D6);                    // at least one digit (covers 0)
    a.tstl(D0);
    a.beq('__dd_done');
    a.moveq(0, D6);
    a.label('__dd_loop');
    a.tstl(D0);
    a.beq('__dd_done');
    a.moveq(10, D1);
    a.bsr('__udivmod');               // D0 := D0/10
    a.addql(1, D6);
    a.bra('__dd_loop');
    a.label('__dd_done');
    a.movel_pop_d(D0);
    a.rts();
    // __wf_hexdigits: D6 = number of hex digits in unsigned D0; D0 preserved.
    a.label('__wf_hexdigits');
    a.movel_d_push(D0);
    a.moveq(1, D6);
    a.tstl(D0);
    a.beq('__hd_done');
    a.moveq(0, D6);
    a.label('__hd_loop');
    a.tstl(D0);
    a.beq('__hd_done');
    a.lsrl_imm(4, D0);                // unsigned >> 4
    a.addql(1, D6);
    a.bra('__hd_loop');
    a.label('__hd_done');
    a.movel_pop_d(D0);
    a.rts();
    // __wf_strlen_a3: D6 = length of C-string at A3; A3 preserved.
    a.label('__wf_strlen_a3');
    a.movel_a_push(A3);
    a.moveq(0, D6);
    a.label('__sla_loop');
    a.moveb_postinc_d(A3, D0);
    a.tstb(D0);
    a.beq('__sla_done');
    a.addql(1, D6);
    a.bra('__sla_loop');
    a.label('__sla_done');
    a.movel_pop_a(A3);
    a.rts();

    // __writef: a0=fmt, a1=args — format to a stack buffer, Write(stdout)
    a.label('__writef');
    a.movem_push(0x3030);              // d2-d3 / a2-a3
    a.link(A5, 256);
    a.lea_disp(-256, A5, A2);
    a.bsr('__format');
    a.lea_disp(-256, A5, A0);
    a.movel_ad(A2, D3);
    a.subl_ad(A0, D3);                 // len
    a.movel_ad(A0, D2);                // buf
    a.movel_disp_d(this.globalSlot('stdout'), A4, D1);     // stdout
    a.beq('__wf_nout');                // WB start: no console — drop output
    a.movel_disp_a(this.globalSlot('dosbase'), A4, A6);    // dosbase
    a.jsr_disp(-48, A6);               // Write
    a.label('__wf_nout');
    a.unlk(A5);
    a.movem_pop(0x0c0c);
    a.rts();

    // __stringf: d0=est, a0=fmt, a1=&first arg (descending) → len in d0.
    // est is kept in D2: __format clobbers A3 in its \s handler.
    a.label('__stringf');
    a.movem_push(0x3030);              // d2-d3/a2-a3 (16 bytes)
    a.movel_da(D0, A2);                // out = est data
    a.movel_dd(D0, D2);                // keep est
    a.bsr('__format');
    a.clrb_ind(A2);
    a.movel_ad(A2, D0);
    a.subl_dd(D2, D0);                 // len
    a.movel_da(D2, A0);
    a.movew_d_disp(D0, -2, A0);
    a.movem_pop(0x0c0c);
    a.rts();

    // __strlen: d0=cstring → d0=length
    a.label('__strlen');
    a.movel_da(D0, A0);
    a.movel_dd(D0, D1);
    a.label('__sl_loop');
    a.tstb_postinc(A0);
    a.bne('__sl_loop');
    a.movel_ad(A0, D0);
    a.subl_dd(D1, D0);
    a.subql(1, D0);
    a.rts();

    // __strcore: copy loop. a0=write pos, a1=src, d2=len limit, d3=maxlen,
    // d4=current count, d0=est (untouched). Terminates + stores new length.
    a.label('__strcore');
    a.label('__sc_loop');
    a.cmpl_dd(D3, D4);
    a.bcc(COND.GE, '__sc_done');
    a.tstl(D2);
    a.beq('__sc_done');
    a.moveb_postinc_d(A1, D1);
    a.tstb(D1);
    a.beq('__sc_done');
    a.moveb_d_postinc(D1, A0);
    a.addql(1, D4);
    a.subql(1, D2);
    a.bra('__sc_loop');
    a.label('__sc_done');
    a.clrb_ind(A0);
    a.movel_da(D0, A0);
    a.movew_d_disp(D4, -2, A0);
    a.rts();

    // ---- heap: tracked AllocMem chain [next.l][size.l][data...] ----
    // __new: d0=size → d0=zeroed data ptr or NIL
    a.label('__new');
    a.addql(8, D0);
    a.movel_dd(D0, D3);                // total
    a.movel_imm(0x10001, D1);          // MEMF_PUBLIC|MEMF_CLEAR
    a.movel_absw_a(4, A6);
    a.jsr_disp(-198, A6);              // AllocMem
    a.tstl(D0);
    a.beq('__new_done');
    a.movel_da(D0, A0);
    a.movel_disp_d(8, A4, D1);         // old head
    a.movel_d_ind(D1, A0);             // next = head
    a.movel_d_disp(D3, 4, A0);         // total size
    a.movel_a_disp(A0, 8, A4);         // head = base
    a.addql(8, D0);                    // data ptr
    a.label('__new_done');
    a.rts();

    // __dispose: d0=data ptr (NIL ok) → d0=NIL
    a.label('__dispose');
    a.tstl(D0);
    a.beq('__di_done');
    a.subql(8, D0);
    a.movel_da(D0, A1);                // base
    a.lea_disp(8, A4, A0);             // &head
    a.label('__di_loop');
    a.movel_ind_d(A0, D1);
    a.beq('__di_done');                // not in chain: ignore
    a.cmpl_dd(D0, D1);
    a.beq('__di_unlink');
    a.movel_da(D1, A0);                // candidate's next-slot is its first long
    a.bra('__di_loop');
    a.label('__di_unlink');
    a.movel_ind_d(A1, D1);             // base->next
    a.movel_d_ind(D1, A0);             // prev->next = base->next
    a.movel_disp_d(4, A1, D0);         // total size
    a.movel_absw_a(4, A6);
    a.jsr_disp(-210, A6);              // FreeMem(a1, d0)
    a.label('__di_done');
    a.moveq(0, D0);
    a.rts();

    // __freeall: release the whole chain (program exit)
    a.label('__freeall');
    a.label('__fa_loop');
    a.movel_disp_d(8, A4, D2);
    a.tstl(D2);
    a.beq('__fa_done');
    a.movel_da(D2, A1);
    a.movel_ind_d(A1, D1);
    a.movel_d_disp(D1, 8, A4);         // head = next
    a.movel_disp_d(4, A1, D0);
    a.movel_absw_a(4, A6);
    a.jsr_disp(-210, A6);              // FreeMem
    a.bra('__fa_loop');
    a.label('__fa_done');
    a.rts();

    // __newstring: d0=maxlen → complex estring (oracle-verified layout:
    // link.l at -8, maxlen.w at -4, len.w at -2, chars at 0)
    a.label('__newstring');
    a.movel_dd(D0, D4);
    a.addql(8, D0);
    a.addql(1, D0);                    // link.l hdr.l chars nul
    a.bsr('__new');
    a.tstl(D0);
    a.beq('__ns_done');
    a.movel_da(D0, A0);
    a.movew_d_disp(D4, 4, A0);         // maxlen (link + len + nul stay zero)
    a.addql(8, D0);
    a.label('__ns_done');
    a.rts();

    // __raise: d0 = exception value. Unwind to the innermost HANDLE frame
    // {prev, sp, fp, resume-pc}; uncaught exceptions exit the program with
    // the value as return code.
    a.label('__raise');
    a.movel_d_disp(D0, this.globalSlot('exception'), A4);  // exception
    a.movel_disp_d(28, A4, D1);        // handler chain head
    a.bne('__rs_caught');
    a.movel_d_disp(D0, 16, A4);        // exit code
    a.movel_disp_a(12, A4, A7);        // unwind to startup SP
    a.bra('__exit');
    a.label('__rs_caught');
    a.movel_da(D1, A0);
    a.movel_disp_a(4, A0, A7);
    a.movel_disp_a(8, A0, A5);
    a.movel_disp_a(12, A0, A0);
    a.jmp_ind(A0);

    // __openw: 11 stack args (x,y,w,h,idcmp,wflags,title,screen,sflags,
    // gadgets,tags pushed L→R) → window ptr in d0; sets stdrast (ch_9D)
    {
      const stdrast = this.globalSlot('stdrast');
      const ibase = this.globalSlot('intuitionbase');
      a.label('__openw');
      a.link(A5, 48);                  // NewWindow struct on the frame
      a.lea_disp(-48, A5, A0);
      const arg = i => 8 + 4 * (10 - i);  // arg_i(a5)
      a.movel_disp_d(arg(0), A5, D0); a.movew_d_disp(D0, 0, A0);   // LeftEdge
      a.movel_disp_d(arg(1), A5, D0); a.movew_d_disp(D0, 2, A0);   // TopEdge
      a.movel_disp_d(arg(2), A5, D0); a.movew_d_disp(D0, 4, A0);   // Width
      a.movel_disp_d(arg(3), A5, D0); a.movew_d_disp(D0, 6, A0);   // Height
      a.movel_imm(0xffff0000, D0);
      a.movel_d_disp(D0, 8, A0);       // Detail/BlockPen = -1, IDCMP hi
      a.movel_disp_d(arg(4), A5, D0); a.movel_d_disp(D0, 10, A0);  // IDCMP
      a.movel_disp_d(arg(5), A5, D0); a.movel_d_disp(D0, 14, A0);  // Flags
      a.movel_disp_d(arg(9), A5, D0); a.movel_d_disp(D0, 18, A0);  // FirstGadget
      a.moveq(0, D0);
      a.movel_d_disp(D0, 22, A0);      // CheckMark
      a.movel_disp_d(arg(6), A5, D0); a.movel_d_disp(D0, 26, A0);  // Title
      a.movel_disp_d(arg(7), A5, D0); a.movel_d_disp(D0, 30, A0);  // Screen
      a.moveq(0, D0);
      a.movel_d_disp(D0, 34, A0);      // BitMap
      a.movel_imm(0x00010001, D0);
      a.movel_d_disp(D0, 38, A0);      // MinWidth/MinHeight = 1,1
      a.movel_imm(0xffffffff, D0);
      a.movel_d_disp(D0, 42, A0);      // MaxWidth/MaxHeight = no limit
      a.movel_disp_d(arg(8), A5, D0); a.movew_d_disp(D0, 46, A0);  // Type
      a.movel_disp_d(arg(10), A5, D0); // taglist
      a.movel_disp_a(ibase, A4, A6);
      a.tstl(D0);
      a.beq('__ow_plain');
      a.movel_da(D0, A1);
      a.jsr_disp(-606, A6);            // OpenWindowTagList(nw, tags)
      a.bra('__ow_done');
      a.label('__ow_plain');
      a.jsr_disp(-204, A6);            // OpenWindow(nw)
      a.label('__ow_done');
      a.tstl(D0);
      a.beq('__ow_nil');
      a.movel_da(D0, A0);
      a.movel_disp_d(50, A0, D1);      // window.RPort
      a.movel_d_disp(D1, stdrast, A4);
      a.label('__ow_nil');
      a.unlk(A5);
      a.rts();

      // __closew: d0 = window (NIL ok); clears stdrast
      a.label('__closew');
      a.tstl(D0);
      a.beq('__cw_nil');
      a.movel_da(D0, A0);
      a.movel_disp_a(ibase, A4, A6);
      a.jsr_disp(-72, A6);             // CloseWindow
      a.label('__cw_nil');
      a.clrl_disp(stdrast, A4);
      a.rts();
    }

    // ---- ch_9E graphics builtins: all draw on stdrast, NIL-safe ----
    // Amiga libs preserve d2-d7/a2-a6, so coordinates ride in d2+ across
    // the SetAPen call; a1 (rastport) is scratch and reloaded per call.
    {
      const stdrast = this.globalSlot('stdrast');
      const gfx = this.globalSlot('gfxbase');
      const loadRp = () => { a.movel_disp_a(stdrast, A4, A1); };
      const loadGfx = () => { a.movel_disp_a(gfx, A4, A6); };

      // __plot: d0=x, d1=y, d2=colour
      a.label('__plot');
      a.tstl_disp(stdrast, A4);
      a.beq('__gf_done');
      a.movel_dd(D0, D3);
      a.movel_dd(D1, D4);
      a.movel_dd(D2, D0);
      loadRp(); loadGfx();
      a.jsr_disp(-342, A6);            // SetAPen(rp, colour)
      a.movel_dd(D3, D0);
      a.movel_dd(D4, D1);
      loadRp();
      a.jsr_disp(-324, A6);            // WritePixel(rp, x, y)
      a.label('__gf_done');
      a.rts();

      // __line: d0=x1, d1=y1, d2=x2, d3=y2, d4=colour
      a.label('__line');
      a.tstl_disp(stdrast, A4);
      a.beq('__gf_done');
      a.movel_dd(D0, D5);
      a.movel_dd(D1, D6);
      a.movel_dd(D4, D0);
      loadRp(); loadGfx();
      a.jsr_disp(-342, A6);            // SetAPen
      a.movel_dd(D5, D0);
      a.movel_dd(D6, D1);
      loadRp();
      a.jsr_disp(-240, A6);            // Move(rp, x1, y1)
      a.movel_dd(D2, D0);
      a.movel_dd(D3, D1);
      loadRp();
      a.jsr_disp(-246, A6);            // Draw(rp, x2, y2)
      a.rts();

      // __box: d0=x1, d1=y1, d2=x2, d3=y2, d4=colour
      a.label('__box');
      a.tstl_disp(stdrast, A4);
      a.beq('__gf_done');
      a.movel_dd(D0, D5);
      a.movel_dd(D1, D6);
      a.movel_dd(D4, D0);
      loadRp(); loadGfx();
      a.jsr_disp(-342, A6);            // SetAPen
      a.movel_dd(D5, D0);
      a.movel_dd(D6, D1);
      loadRp();
      a.jsr_disp(-306, A6);            // RectFill(rp, x1, y1, x2, y2)
      a.rts();

      // __colour: d0=fg, d1=bg
      a.label('__colour');
      a.tstl_disp(stdrast, A4);
      a.beq('__gf_done');
      a.movel_dd(D1, D5);
      loadRp(); loadGfx();
      a.jsr_disp(-342, A6);            // SetAPen(rp, fg)
      a.movel_dd(D5, D0);
      loadRp();
      a.jsr_disp(-348, A6);            // SetBPen(rp, bg)
      a.rts();

      // __setstdrast: d0=new → d0=old
      a.label('__setstdrast');
      a.movel_disp_d(stdrast, A4, D1);
      a.movel_d_disp(D0, stdrast, A4);
      a.movel_dd(D1, D0);
      a.rts();

      // __textf: d0=x, d1=y, a0=fmt, a1=&first arg (descending) → len.
      // Oracle-verified: returns 0 and does nothing when stdrast is NIL.
      a.label('__textf');
      a.tstl_disp(stdrast, A4);
      a.bne('__tf_go');
      a.moveq(0, D0);
      a.rts();
      a.label('__tf_go');
      a.movem_push(0x3c30);            // d2-d5 / a2-a3
      a.movel_dd(D0, D4);
      a.movel_dd(D1, D5);
      a.link(A5, 256);
      a.lea_disp(-256, A5, A2);
      a.bsr('__format');
      a.lea_disp(-256, A5, A0);
      a.movel_ad(A2, D3);
      a.subl_ad(A0, D3);               // len
      a.movel_dd(D4, D0);
      a.movel_dd(D5, D1);
      loadRp(); loadGfx();
      a.jsr_disp(-240, A6);            // Move(rp, x, y)
      a.lea_disp(-256, A5, A0);
      a.movel_dd(D3, D0);
      loadRp();
      a.jsr_disp(-60, A6);             // Text(rp, str, len)
      a.movel_dd(D3, D0);
      a.unlk(A5);
      a.movem_pop(0x0c3c);
      a.rts();
    }

    // __opens: 6 stack args (w,h,depth,sflags,title,tags) → screen or NIL.
    // NewScreen on the frame; stdrast := &screen.RastPort (offset 84).
    {
      const stdrast = this.globalSlot('stdrast');
      const ibase = this.globalSlot('intuitionbase');
      a.label('__opens');
      a.link(A5, 32);
      a.lea_disp(-32, A5, A0);
      const arg = i => 8 + 4 * (5 - i);
      a.moveq(0, D0);
      a.movel_d_ind(D0, A0);           // LeftEdge/TopEdge = 0
      a.movel_disp_d(arg(0), A5, D0); a.movew_d_disp(D0, 4, A0);   // Width
      a.movel_disp_d(arg(1), A5, D0); a.movew_d_disp(D0, 6, A0);   // Height
      a.movel_disp_d(arg(2), A5, D0); a.movew_d_disp(D0, 8, A0);   // Depth
      a.movel_imm(0xffff0000, D0);
      a.movel_d_disp(D0, 10, A0);      // pens -1,-1 + ViewModes hi
      a.movel_disp_d(arg(3), A5, D0); a.movew_d_disp(D0, 12, A0);  // ViewModes
      a.movew_imm_disp(15, 14, A0);    // Type = CUSTOMSCREEN
      a.moveq(0, D0);
      a.movel_d_disp(D0, 16, A0);      // Font
      a.movel_disp_d(arg(4), A5, D0); a.movel_d_disp(D0, 20, A0);  // Title
      a.moveq(0, D0);
      a.movel_d_disp(D0, 24, A0);      // Gadgets
      a.movel_d_disp(D0, 28, A0);      // CustomBitMap
      a.movel_disp_d(arg(5), A5, D1);  // taglist
      a.movel_disp_a(ibase, A4, A6);
      a.movel_da(D1, A1);
      a.jsr_disp(-612, A6);            // OpenScreenTagList(ns, tags)
      a.tstl(D0);
      a.beq('__os_done');
      a.movel_da(D0, A0);
      a.lea_disp(84, A0, A1);          // &screen.RastPort
      a.movel_ad(A1, D1);
      a.movel_d_disp(D1, stdrast, A4);
      a.label('__os_done');
      a.unlk(A5);
      a.rts();

      a.label('__closes');
      a.tstl(D0);
      a.beq('__cs_nil');
      a.movel_da(D0, A0);
      a.movel_disp_a(ibase, A4, A6);
      a.jsr_disp(-66, A6);             // CloseScreen
      a.label('__cs_nil');
      a.clrl_disp(stdrast, A4);
      a.rts();
    }

    // __strcmp: d0=s1, d1=s2, d2=len(ALL=-1) → TRUE/FALSE
    a.label('__strcmp');
    a.movel_da(D0, A0);
    a.movel_da(D1, A1);
    a.label('__cmp_loop');
    a.tstl(D2);
    a.beq('__cmp_eq');
    a.subql(1, D2);
    a.moveb_postinc_d(A0, D1);
    a.cmpb_postinc_d(A1, D1);
    a.bne('__cmp_ne');
    a.tstb(D1);
    a.beq('__cmp_eq');
    a.bra('__cmp_loop');
    a.label('__cmp_eq');
    a.moveq(-1, D0);
    a.rts();
    a.label('__cmp_ne');
    a.moveq(0, D0);
    a.rts();

    // __waitimsg: d0=window → waits on its UserPort, replies the message,
    // returns Class; Code/Qualifier/IAddress land in the Msg* globals
    {
      const mc = this.globalSlot('__msgcode');
      const mq = this.globalSlot('__msgqual');
      const mi = this.globalSlot('__msgiaddr');
      a.label('__waitimsg');
      a.movel_da(D0, A2);              // window (libs preserve a2)
      a.label('__wi_get');
      a.movel_disp_a(86, A2, A0);      // win.UserPort
      a.movel_absw_a(4, A6);
      a.jsr_disp(-372, A6);            // GetMsg
      a.tstl(D0);
      a.bne('__wi_got');
      a.movel_disp_a(86, A2, A0);
      a.movel_absw_a(4, A6);
      a.jsr_disp(-384, A6);            // WaitPort
      a.bra('__wi_get');
      a.label('__wi_got');
      a.movel_da(D0, A1);              // intuimessage
      a.movel_disp_d(20, A1, D2);      // Class
      a.moveq(0, D1);
      a.movew_disp_d(24, A1, D1);      // Code (unsigned)
      a.movel_d_disp(D1, mc, A4);
      a.movew_disp_d(26, A1, D1);      // Qualifier
      a.movel_d_disp(D1, mq, A4);
      a.movel_disp_d(28, A1, D1);      // IAddress
      a.movel_d_disp(D1, mi, A4);
      a.movel_absw_a(4, A6);
      a.jsr_disp(-378, A6);            // ReplyMsg(a1)
      a.movel_dd(D2, D0);              // return Class
      a.rts();
    }

    // quote-driven list functions (ch_9C): d0=varaddr, d1=src, d2=dest,
    // d3=code. State lives in the frame: quoted code clobbers D0-D6/A0-A3.
    for (const [name, kind] of [['__maplist', 'map'], ['__selectlist', 'sel'],
      ['__forall', 'all'], ['__exists', 'any']]) {
      a.label(name);
      a.link(A5, 28);
      a.movel_d_disp(D0, -4, A5);      // varaddr
      a.movel_d_disp(D1, -8, A5);      // src
      a.movel_d_disp(D2, -12, A5);     // dest
      a.movel_d_disp(D3, -16, A5);     // code
      a.movel_da(D1, A0);
      a.movew_disp_d(-2, A0, D4);
      a.extl(D4);
      a.movel_d_disp(D4, -20, A5);     // len
      a.moveq(0, D4);
      a.movel_d_disp(D4, -24, A5);     // i
      a.movel_d_disp(D4, -28, A5);     // out count (sel)
      a.label(name + '_loop');
      a.movel_disp_d(-24, A5, D4);
      a.movel_disp_d(-20, A5, D5);
      a.cmpl_dd(D5, D4);
      a.bcc(COND.GE, name + '_done');
      a.movel_disp_a(-8, A5, A0);      // src
      a.asll_imm(2, D4);
      a.addal_d(D4, A0);
      a.movel_ind_d(A0, D0);           // element
      a.movel_disp_a(-4, A5, A1);
      a.movel_d_ind(D0, A1);           // ^var := element
      a.movel_disp_a(-16, A5, A0);
      a.jsr_ind(A0);                   // run the quoted expression
      if (kind === 'map') {
        a.movel_disp_a(-12, A5, A1);
        a.movel_disp_d(-24, A5, D4);
        a.asll_imm(2, D4);
        a.addal_d(D4, A1);
        a.movel_d_ind(D0, A1);         // dest[i] := result
      } else if (kind === 'sel') {
        a.tstl(D0);
        a.beq(name + '_next');
        a.movel_disp_a(-8, A5, A0);    // matching element copies to dest
        a.movel_disp_d(-24, A5, D4);
        a.asll_imm(2, D4);
        a.addal_d(D4, A0);
        a.movel_ind_d(A0, D0);
        a.movel_disp_a(-12, A5, A1);
        a.movel_disp_d(-28, A5, D4);
        a.asll_imm(2, D4);
        a.addal_d(D4, A1);
        a.movel_d_ind(D0, A1);
        a.addql_disp(1, -28, A5);
      } else if (kind === 'all') {
        a.tstl(D0);
        a.bne(name + '_next');
        a.moveq(0, D0);
        a.unlk(A5);
        a.rts();
      } else {
        a.tstl(D0);
        a.beq(name + '_next');
        a.moveq(-1, D0);
        a.unlk(A5);
        a.rts();
      }
      a.label(name + '_next');
      a.addql_disp(1, -24, A5);
      a.bra(name + '_loop');
      a.label(name + '_done');
      if (kind === 'map' || kind === 'sel') {
        a.movel_disp_a(-12, A5, A0);
        a.movel_disp_d(kind === 'map' ? -20 : -28, A5, D1);
        a.movew_d_disp(D1, -2, A0);    // dest length
        a.movel_disp_d(-12, A5, D0);
      } else {
        a.moveq(kind === 'all' ? -1 : 0, D0);
      }
      a.unlk(A5);
      a.rts();
    }

    // __mul32: d0 = d0*d1 full 32-bit (the Mul() builtin, ch_9G)
    a.label('__mul32');
    a.movel_d_push(D2);
    a.movel_dd(D0, D2);
    a.moveq(0, D0);
    a.label('__m32_loop');
    a.tstl(D1);
    a.beq('__m32_done');
    a.lsrl_imm(1, D1);
    a.bcc(COND.CC, '__m32_skip');
    a.addl_dd(D2, D0);
    a.label('__m32_skip');
    a.addl_dd(D2, D2);
    a.bra('__m32_loop');
    a.label('__m32_done');
    a.movel_pop_d(D2);
    a.rts();

    // __val: d0=str → d0=value, d1=chars consumed (handles -, $hex, %bin)
    a.label('__val');
    a.movel_da(D0, A0);
    a.movel_da(D0, A1);                // start
    a.moveq(0, D2);                    // value
    a.moveq(0, D3);                    // negative flag
    a.moveq(10, D4);                   // base
    a.label('__v_sp');
    a.moveb_ind_d(A0, D0);
    a.cmpib_imm(32, D0);
    a.beq('__v_sp1');
    a.cmpib_imm(9, D0);
    a.bne('__v_sign');
    a.label('__v_sp1');
    a.addql_a(1, A0);
    a.bra('__v_sp');
    a.label('__v_sign');
    a.cmpib_imm(45, D0);               // '-'
    a.bne('__v_base');
    a.moveq(1, D3);
    a.addql_a(1, A0);
    a.moveb_ind_d(A0, D0);
    a.label('__v_base');
    a.cmpib_imm(36, D0);               // '$'
    a.bne('__v_b2');
    a.moveq(16, D4);
    a.addql_a(1, A0);
    a.bra('__v_loop');
    a.label('__v_b2');
    a.cmpib_imm(37, D0);               // '%'
    a.bne('__v_loop');
    a.moveq(2, D4);
    a.addql_a(1, A0);
    a.label('__v_loop');
    a.moveq(0, D0);
    a.moveb_ind_d(A0, D0);
    a.cmpib_imm(48, D0);
    a.bcc(COND.CS, '__v_end');         // < '0'
    a.cmpib_imm(58, D0);
    a.bcc(COND.CS, '__v_dig');         // '0'..'9'
    a.cmpib_imm(16, D4);
    a.bne('__v_end');                  // letters only valid in hex
    a.label('__v_hexl');
    a.cmpib_imm(65, D0);
    a.bcc(COND.CS, '__v_end');
    a.cmpib_imm(71, D0);
    a.bcc(COND.CS, '__v_hexup');
    a.cmpib_imm(97, D0);
    a.bcc(COND.CS, '__v_end');
    a.cmpib_imm(103, D0);
    a.bcc(COND.CC, '__v_end');
    a.addib_imm(-32, D0);              // tolower → toupper
    a.label('__v_hexup');
    a.addib_imm(-55, D0);              // 'A'-10
    a.bra('__v_acc');
    a.label('__v_dig');
    a.addib_imm(-48, D0);
    a.label('__v_acc');
    a.cmpl_dd(D4, D0);
    a.bcc(COND.GE, '__v_end');         // digit >= base → stop
    // value = value*base + digit
    a.movel_d_push(D0);
    a.movel_dd(D2, D0);
    a.movel_dd(D4, D1);
    a.bsr('__mul32');
    a.movel_dd(D0, D2);
    a.movel_pop_d(D0);
    a.addl_dd(D0, D2);
    a.addql_a(1, A0);
    a.bra('__v_loop');
    a.label('__v_end');
    a.movel_dd(D2, D0);
    a.tstl(D3);
    a.beq('__v_pos');
    a.negl(D0);
    a.label('__v_pos');
    a.movel_ad(A0, D1);
    a.subl_ad(A1, D1);                 // chars consumed
    a.rts();

    // __instr: d0=haystack, d1=needle, d2=startpos → index or -1
    a.label('__instr');
    a.movel_da(D0, A0);
    a.addal_d(D2, A0);
    a.movel_dd(D2, D3);                // current index
    a.label('__is_outer');
    a.moveb_ind_d(A0, D0);
    a.beq('__is_fail');
    a.movel_da(D1, A1);                // needle
    a.movel_ad(A0, D4);
    a.movel_da(D4, A2);                // probe = current hay pos
    a.label('__is_inner');
    a.moveb_ind_d(A1, D0);
    a.beq('__is_found');
    a.moveb_postinc_d(A2, D4);
    a.addql_a(1, A1);
    a.cmpb_dd(D4, D0);
    a.bne('__is_next');
    a.bra('__is_inner');
    a.label('__is_next');
    a.addql_a(1, A0);
    a.addql(1, D3);
    a.bra('__is_outer');
    a.label('__is_found');
    a.movel_dd(D3, D0);
    a.rts();
    a.label('__is_fail');
    a.moveq(-1, D0);
    a.rts();

    // __trimstr: d0=str → ptr past leading whitespace
    a.label('__trimstr');
    a.movel_da(D0, A0);
    a.label('__ts_loop');
    a.moveb_ind_d(A0, D1);
    a.cmpib_imm(32, D1);
    a.beq('__ts_skip');
    a.cmpib_imm(9, D1);
    a.beq('__ts_skip');
    a.cmpib_imm(10, D1);
    a.beq('__ts_skip');
    a.movel_ad(A0, D0);
    a.rts();
    a.label('__ts_skip');
    a.addql_a(1, A0);
    a.bra('__ts_loop');

    // __upperstr / __lowerstr: in-place case conversion, returns str
    a.label('__upperstr');
    a.movel_da(D0, A0);
    a.label('__us_loop');
    a.moveb_ind_d(A0, D1);
    a.beq('__us_done');
    a.cmpib_imm(97, D1);
    a.bcc(COND.CS, '__us_next');
    a.cmpib_imm(123, D1);
    a.bcc(COND.CC, '__us_next');
    a.addib_imm(-32, D1);
    a.moveb_d_ind(D1, A0);
    a.label('__us_next');
    a.addql_a(1, A0);
    a.bra('__us_loop');
    a.label('__us_done');
    a.rts();
    a.label('__lowerstr');
    a.movel_da(D0, A0);
    a.label('__ls_loop');
    a.moveb_ind_d(A0, D1);
    a.beq('__us_done');
    a.cmpib_imm(65, D1);
    a.bcc(COND.CS, '__ls_next');
    a.cmpib_imm(91, D1);
    a.bcc(COND.CC, '__ls_next');
    a.addib_imm(32, D1);
    a.moveb_d_ind(D1, A0);
    a.label('__ls_next');
    a.addql_a(1, A0);
    a.bra('__ls_loop');

    // __midstr: d0=dest, d1=src, d2=pos, d3=len → StrCopy(dest, src+pos, len)
    a.label('__midstr');
    a.addl_dd(D2, D1);
    a.movel_dd(D3, D2);
    a.bra('__strcopy');

    // __rightstr: d0=dest, d1=src ESTRING, d2=n → last n chars into dest.
    // Oracle-verified: src length comes from the estring header, not strlen.
    a.label('__rightstr');
    a.movel_da(D1, A0);
    a.movel_dd(D0, D5);                // dest
    a.movew_disp_d(-2, A0, D0);
    a.extl(D0);                        // EstrLen(src)
    a.subl_dd(D2, D0);                 // start = len - n
    a.bcc(COND.PL, '__rs_ok');
    a.moveq(0, D0);
    a.label('__rs_ok');
    a.addl_dd(D0, D1);                 // src + start
    a.moveq(-1, D2);
    a.movel_dd(D5, D0);
    a.bra('__strcopy');

    // __setstr: d0=estr, d1=len → estr (sets length + terminator)
    a.label('__setstr');
    a.movel_da(D0, A0);
    a.movew_d_disp(D1, -2, A0);
    a.addal_d(D1, A0);
    a.clrb_ind(A0);
    a.rts();

    // __ostrcmp: d0=s1, d1=s2, d2=max(ALL=-1) → -1/0/1 ordering
    a.label('__ostrcmp');
    a.movel_da(D0, A0);
    a.movel_da(D1, A1);
    a.label('__oc_loop');
    a.tstl(D2);
    a.beq('__oc_eq');
    a.subql(1, D2);
    a.moveb_postinc_d(A0, D1);
    a.moveb_postinc_d(A1, D3);
    a.cmpb_dd(D3, D1);
    a.bcc(COND.CS, '__oc_lt');
    a.bne('__oc_gt');
    a.tstb(D1);
    a.beq('__oc_eq');
    a.bra('__oc_loop');
    // oracle-verified: OstrCmp returns +1 when s1<s2, -1 when s1>s2
    a.label('__oc_eq');
    a.moveq(0, D0);
    a.rts();
    a.label('__oc_lt');
    a.moveq(1, D0);
    a.rts();
    a.label('__oc_gt');
    a.moveq(-1, D0);
    a.rts();

    // __readstr: d0=fh, d1=estr → 0, or -1 when the file is exhausted
    {
      a.label('__readstr');
      a.movel_dd(D0, D4);              // fh
      a.movel_da(D1, A3);              // estr
      a.moveq(0, D6);                  // count
      a.movew_disp_d(-4, A3, D5);
      a.extl(D5);                      // maxlen
      a.moveq(0, D7);                  // eof flag
      a.label('__rl_loop');
      a.movel_dd(D4, D1);
      a.movel_disp_a(this.globalSlot('dosbase'), A4, A6);   // dosbase (EC ABI slot)
      a.jsr_disp(-306, A6);            // FGetC
      a.moveq(-1, D1);
      a.cmpl_dd(D1, D0);
      a.beq('__rl_eof');
      a.cmpib_imm(10, D0);
      a.beq('__rl_done');
      a.cmpl_dd(D5, D6);
      a.bcc(COND.GE, '__rl_loop');     // overflow: swallow rest of line
      a.movel_da(D6, A0);              // (reuse as scratch index)
      a.movel_ad(A3, D1);
      a.movel_da(D1, A1);
      a.addal_d(D6, A1);
      a.moveb_d_ind(D0, A1);
      a.addql(1, D6);
      a.bra('__rl_loop');
      a.label('__rl_eof');
      a.moveq(-1, D7);
      a.label('__rl_done');
      a.movew_d_disp(D6, -2, A3);
      a.movel_ad(A3, D1);
      a.movel_da(D1, A1);
      a.addal_d(D6, A1);
      a.clrb_ind(A1);
      a.movel_dd(D7, D0);
      a.rts();
    }

    // __strcopy: d0=est, d1=src, d2=len(ALL=-1) → d0=est
    a.label('__strcopy');
    a.movel_da(D0, A0);
    a.movel_da(D1, A1);
    a.movew_disp_d(-4, A0, D3);
    a.extl(D3);                        // maxlen
    a.moveq(0, D4);
    a.bsr('__strcore');
    a.rts();

    // __stradd: d0=est, d1=src, d2=len(ALL=-1) → d0=est
    a.label('__stradd');
    a.movel_da(D0, A0);
    a.movel_da(D1, A1);
    a.movew_disp_d(-4, A0, D3);
    a.extl(D3);                        // maxlen
    a.movew_disp_d(-2, A0, D4);
    a.extl(D4);                        // current length
    a.addal_d(D4, A0);                 // append position
    a.bsr('__strcore');
    a.rts();
  }

  emitData() {
    const a = this.a;
    a.align();
    a.label('__credit');
    a.asciiz('Built with ecomp. E modules (c) Wouter van Oortmerssen, used with permission - thanks Wouter!');
    a.align();
    a.label('__emptystr');
    a.w8(0);
    a.w8(0);
    a.label('__dosname');
    a.asciiz('dos.library');
    for (const [value, label] of this.strings) {
      a.align();
      a.label(label);
      a.asciiz(value);
    }
    for (const lst of this.lists) {
      a.align();
      a.w16(lst.bytes);          // maxlen header (bytes incl trailing NULL)
      a.w16(lst.count);          // current length
      a.label(lst.label);        // the list pointer aims here
      a.space(lst.bytes);
    }
    a.align();
    a.label('__globals');
    // A4 = __globals + A4_ORIGIN; standard globals occupy [origin-96, origin),
    // ecomp/program globals [origin, origin+globalSize).
    a.space(A4_ORIGIN + this.globalSize);
  }

  // ---------- procedures ----------

  emitProc(p) {
    const a = this.a;
    // methods get `self` as a hidden first argument
    const args = p.of
      ? [{ name: 'self', type: { base: 'PTR', to: { base: 'OBJECT', name: p.of } } }, ...p.args]
      : p.args;
    const ctx = {
      proc: p,
      args,
      locals: new Map(),
      types: new Map(),
      nargs: args.length,
      epilogue: this.uniq('ep'),
      loopEnds: [],
      loopConts: [],   // CONT targets (parallel to loopEnds)
    };
    for (const arg of args) if (arg.type) ctx.types.set(arg.name, arg.type);
    let frame = 0;
    const inits = [];   // [bufDisp, kind, count] emitted after LINK
    for (const s of p.body ?? []) {
      if (s.kind === 'Def') for (const v of s.decls) {
        frame += 4;
        ctx.locals.set(v.name, -frame);
        if (v.type) ctx.types.set(v.name, v.type);
        if (!v.size) {
          // inline OBJECT value local (e.g. DEF list:lh, not PTR TO lh): reserve
          // the object's bytes on the frame; the slot holds its address (like a
          // sized buffer), so `x` and `x.field` resolve to that storage. Without
          // this `x` is an uninitialised pointer and writing through it (e.g.
          // newList(list)) corrupts memory.
          if (v.type?.base === 'OBJECT') {
            const osz = this.sem.objects.get(v.type.name)?.size ?? 0;
            if (osz > 0) {
              frame += (osz + 1) & ~1;
              inits.push({ buf: -frame, slot: ctx.locals.get(v.name), kind: 'OBJECT', count: 0 });
            }
          }
          continue;
        }
        // sized declarations get a frame buffer; the variable holds a
        // pointer to it, set up at procedure entry
        const count = this.sem.foldConst(v.size);
        if (count === null) { this.err(s, `size of ${v.name} must be constant`); continue; }
        const base = v.type?.base;
        if (base === 'STRING') {
          frame += (4 + count + 2) & ~1;   // maxlen.w len.w data nul
          inits.push({ buf: -frame, slot: ctx.locals.get(v.name), kind: 'STRING', count });
        } else if (base === 'LIST') {
          frame += 4 + count * 4;
          inits.push({ buf: -frame, slot: ctx.locals.get(v.name), kind: 'LIST', count });
        } else if (base === 'ARRAY' || !base) {
          const esize = typeSize(v.type?.of);
          frame += (count * esize + 1) & ~1;
          inits.push({ buf: -frame, slot: ctx.locals.get(v.name), kind: 'ARRAY', count });
        } else {
          this.err(s, `unsupported sized type ${base} for ${v.name}`);
        }
      }
    }
    let excOff = 0;
    if (p.handle) {
      frame += 16;                     // {prev, sp, fp, resume-pc}
      excOff = -frame;
      ctx.exceptLabel = this.uniq('except');
    }
    a.label(p.of ? `proc_${p.of}$${p.name}` : `proc_${p.name}`);
    a.link(A5, frame);
    if (p.handle) {
      a.lea_disp(excOff, A5, A0);
      a.movel_disp_d(28, A4, D0);      // prev = chain head
      a.movel_d_ind(D0, A0);
      a.movel_a_disp(A7, excOff + 4, A5);
      a.movel_a_disp(A5, excOff + 8, A5);
      a.lea_pc(ctx.exceptLabel, A1);
      a.movel_a_disp(A1, excOff + 12, A5);
      a.movel_a_disp(A0, 28, A4);      // chain head = this frame
      ctx.excOff = excOff;
    }
    for (const ini of inits) {
      if (ini.kind === 'STRING' || ini.kind === 'LIST') {
        a.movew_imm_disp(ini.count, ini.buf, A5);      // maxlen
        a.clrw_disp(ini.buf + 2, A5);                  // len = 0
        a.clrb_disp(ini.buf + 4, A5);                  // terminator
        a.lea_disp(ini.buf + 4, A5, A0);
      } else {
        a.lea_disp(ini.buf, A5, A0);
      }
      a.movel_a_disp(A0, ini.slot, A5);
    }
    for (const s of p.body ?? []) this.stat(s, ctx);
    if (p.handle) {
      // EXCEPT DO runs the block on normal completion too (a finally);
      // plain EXCEPT is skipped unless __raise lands on exceptLabel
      const afterExcept = this.uniq('afterexc');
      if (!p.exceptDo) a.bra(afterExcept);
      // oracle-verified: `exception` is cleared only when EXCEPT DO is
      // entered via normal completion (the body still sees the old value)
      else a.clrl_disp(this.globalSlot('exception'), A4);
      a.label(ctx.exceptLabel);
      a.movel_disp_d(ctx.excOff, A5, D0);   // unlink: head = frame.prev
      a.movel_d_disp(D0, 28, A4);
      for (const s of p.except ?? []) this.stat(s, ctx);
      a.label(afterExcept);
    }
    // return values: D0 (and D1, D2 for ENDPROC a,b,c multi-returns)
    const rets = p.returns ?? [];
    if (rets.length === 0) a.moveq(0, D0);
    else if (rets.length === 1) this.exp(rets[0], ctx);
    else {
      for (let i = 0; i < Math.min(rets.length, 3); i++) {
        this.exp(rets[i], ctx);
        if (i < rets.length - 1) a.movel_d_push(D0);
      }
      if (rets.length >= 3) { a.movel_dd(D0, D2); a.movel_pop_d(D1); a.movel_pop_d(D0); }
      else { a.movel_dd(D0, D1); a.movel_pop_d(D0); }
      if (rets.length > 3) this.err(p, 'more than 3 return values');
    }
    a.label(ctx.epilogue);
    if (p.handle) {
      // RETURN from inside the body also lands here: unlink (idempotent —
      // frame.prev never changes after entry)
      a.movel_disp_d(ctx.excOff, A5, D1);
      a.movel_d_disp(D1, 28, A4);
    }
    a.unlk(A5);
    a.rts();
    // quoted-expression bodies live AFTER the proc's rts (they are entered
    // only via Eval/list functions, never by fall-through)
    while (this.quotes.length) {
      const q = this.quotes.shift();
      a.label(q.label);
      this.exp(q.exp, q.ctx);
      a.rts();
    }
  }

  // static type of an expression, where it matters for memory access widths
  typeOf(e, ctx) {
    if (!e) return null;
    switch (e.kind) {
      case 'Paren': return this.typeOf(e.exp, ctx);
      case 'Var': return ctx.types.get(e.name) ?? this.globalTypes.get(e.name) ?? null;
      case 'Cast': return e.type;
      case 'Member': {
        const ot = this.typeOf(e.obj, ctx);
        const objName = ot?.base === 'PTR' ? ot.to?.name : ot?.name;
        const obj = this.sem.objects.get(objName);
        return obj?.members.get(e.name)?.type ?? null;
      }
      case 'Index': {
        const bt = this.typeOf(e.obj, ctx);
        if (!bt) return null;
        if (bt.base === 'STRING') return { base: 'CHAR' };
        if (bt.base === 'LIST') return { base: 'LONG' };
        if (bt.base === 'ARRAY') return bt.of ?? { base: 'CHAR' };
        if (bt.base === 'PTR') return bt.to ?? null;
        return null;
      }
      default: return null;
    }
  }

  // ++/-- stride for a variable: size of the pointed-to type (oracle-verified)
  ptrDelta(t) {
    if (!t) return 1;
    if (t.base === 'PTR') {
      if (t.to?.base === 'OBJECT') return this.sem.objects.get(t.to.name)?.size ?? 1;
      return typeSize(t.to);
    }
    if (t.base === 'LIST') return 4;
    if (t.base === 'ARRAY') return typeSize(t.of);
    return 1;
  }

  elemSize(t) {
    if (!t) return 4;
    if (t.base === 'CHAR') return 1;
    if (t.base === 'INT') return 2;
    if (t.base === 'OBJECT') return this.sem.objects.get(t.name)?.size ?? 4;
    return 4;
  }

  memberInfo(e, ctx) {
    const ot = this.typeOf(e.obj, ctx);
    const objName = ot?.base === 'PTR' ? ot.to?.name : ot?.name;
    return this.sem.objects.get(objName)?.members.get(e.name) ?? null;
  }

  // element access width for a memory lvalue; 0 = embedded (address-of)
  accessSize(e, ctx) {
    if (e.kind === 'Member') {
      const m = this.memberInfo(e, ctx);
      if (m) {
        if (m.size === 1 || m.size === 2) return m.size;
        if (m.size === 0) return 0;        // embedded array/object member
        return 4;
      }
      return 4;
    }
    if (e.kind === 'Index') {
      const t = this.typeOf(e, ctx);
      if (t?.base === 'CHAR') return 1;
      if (t?.base === 'INT') return 2;
      return 4;
    }
    return 4;
  }

  // compute the address of a memory lvalue into A0; returns byte offset
  addressOf(e, ctx) {
    const a = this.a;
    if (e.kind === 'Member') {
      const ot = this.typeOf(e.obj, ctx);
      const objName = ot?.base === 'PTR' ? ot.to?.name : ot?.name;
      const obj = this.sem.objects.get(objName);
      const m = obj?.members.get(e.name);
      if (!m) { this.err(e, `unknown member ${e.name} of ${objName ?? '?'}`); return 0; }
      this.exp(e.obj, ctx);
      a.movel_da(D0, A0);
      return m.offset;
    }
    if (e.kind === 'Index') {
      const et = this.typeOf(e, ctx);
      const esize = et?.base === 'CHAR' ? 1 : et?.base === 'INT' ? 2 :
        et?.base === 'OBJECT' ? (this.sem.objects.get(et.name)?.size ?? 4) : 4;
      this.exp(e.obj, ctx);
      if (!e.idx) { a.movel_da(D0, A0); return 0; }
      const ci = this.sem.foldConst(e.idx);
      if (ci !== null && ci * esize >= -32768 && ci * esize <= 32767) {
        a.movel_da(D0, A0);
        return ci * esize;
      }
      a.movel_d_push(D0);
      this.exp(e.idx, ctx);
      if (esize === 2) a.addl_dd(D0, D0);
      else if (esize === 4) { a.addl_dd(D0, D0); a.addl_dd(D0, D0); }
      else if (esize !== 1) { a.movel_imm(esize, D1); a.mulsw_dd(D1, D0); }
      a.movel_pop_a(A0);
      a.addal_d(D0, A0);
      return 0;
    }
    if (e.kind === 'Deref') {
      this.exp({ kind: 'Var', name: e.lval.name, refType: 'ident' }, ctx);
      a.movel_da(D0, A0);
      return 0;
    }
    this.err(e, `cannot take address of ${e.kind}`);
    return 0;
  }

  loadFrom(disp, size) {
    const a = this.a;
    if (size === 1) { a.moveq(0, D0); a.moveb_disp_d(disp, A0, D0); }
    else if (size === 2) { a.movew_disp_d(disp, A0, D0); a.extl(D0); }
    else a.movel_disp_d(disp, A0, D0);
  }

  storeTo(disp, size) {
    const a = this.a;
    if (size === 1) a.moveb_d_disp(D0, disp, A0);
    else if (size === 2) a.movew_d_disp(D0, disp, A0);
    else a.movel_d_disp(D0, disp, A0);
  }

  varRef(name, ctx) {
    if (ctx.locals.has(name)) return { kind: 'local', disp: ctx.locals.get(name) };
    const i = ctx.args.findIndex(x => x.name === name);
    if (i >= 0) return { kind: 'arg', disp: 8 + 4 * (ctx.nargs - 1 - i) };
    if (this.globalSlots.has(name)) return { kind: 'global', disp: this.globalSlots.get(name) };
    return null;
  }

  loadVar(name, ctx, node) {
    const r = this.varRef(name, ctx);
    if (!r) { this.err(node, `tracer: unknown variable ${name}`); return; }
    if (r.kind === 'global') this.a.movel_disp_d(r.disp, A4, D0);
    else this.a.movel_disp_d(r.disp, A5, D0);
  }

  storeVar(name, ctx, node) {
    const r = this.varRef(name, ctx);
    if (!r) { this.err(node, `tracer: unknown variable ${name}`); return; }
    if (r.kind === 'global') this.a.movel_d_disp(D0, r.disp, A4);
    else this.a.movel_d_disp(D0, r.disp, A5);
  }

  // Store the value currently in D0 into an assignment target (Var or an
  // lvalue: Member/Index/Deref). Used by Assign and Swap.
  assignInD0(target, ctx, node) {
    const a = this.a;
    if (target.kind === 'Var') {
      this.storeVar(target.name, ctx, node);
    } else if (['Member', 'Index', 'Deref'].includes(target.kind)) {
      a.movel_d_push(D0);
      const disp = this.addressOf(target, ctx);
      a.movel_pop_d(D0);
      const size = this.accessSize(target, ctx);
      if (size === 0) this.err(node, 'cannot assign to embedded member');
      else this.storeTo(disp, size);
    } else this.err(node, `cannot assign to ${target.kind}`);
  }

  // ---------- statements ----------

  stat(s, ctx) {
    const a = this.a;
    switch (s.kind) {
      case 'Def':
        for (const v of s.decls) {
          if (v.init) { this.exp(v.init, ctx); this.storeVar(v.name, ctx, s); }
        }
        break;
      case 'Assign':
        this.exp(s.exp, ctx);
        this.assignInD0(s.target, ctx, s);
        break;
      case 'Swap': {   // E-VO  a :=: b  — exchange two lvalues
        this.exp(s.a, ctx); a.movel_d_push(D0);
        this.exp(s.b, ctx); a.movel_d_push(D0);
        a.movel_pop_d(D0); this.assignInD0(s.a, ctx, s);   // a := (old b)
        a.movel_pop_d(D0); this.assignInD0(s.b, ctx, s);   // b := (old a)
        break;
      }
      case 'ExprStat': this.exp(s.exp, ctx); break;
      case 'Return': {
        const rets = s.exps;
        if (rets.length === 0) a.moveq(0, D0);
        else if (rets.length === 1) this.exp(rets[0], ctx);
        else {
          for (let i = 0; i < Math.min(rets.length, 3); i++) {
            this.exp(rets[i], ctx);
            if (i < rets.length - 1) a.movel_d_push(D0);
          }
          if (rets.length >= 3) { a.movel_dd(D0, D2); a.movel_pop_d(D1); a.movel_pop_d(D0); }
          else { a.movel_dd(D0, D1); a.movel_pop_d(D0); }
          if (rets.length > 3) this.err(s, 'more than 3 return values');
        }
        a.bra(ctx.epilogue);
        break;
      }
      case 'If': {
        // E-VO IFN/ELSEIFN invert the branch sense (skip body when cond TRUE).
        const skip = (neg, target) => { a.tstl(D0); if (neg) a.bne(target); else a.beq(target); };
        const elseL = this.uniq('else'), endL = this.uniq('endif');
        this.exp(s.cond, ctx);
        skip(s.neg, s.elifs?.length || s.else ? elseL : endL);
        for (const st of s.then) this.stat(st, ctx);
        if (s.elifs?.length || s.else) {
          a.bra(endL);
          a.label(elseL);
          for (let i = 0; i < (s.elifs?.length ?? 0); i++) {
            const ei = s.elifs[i];
            this.exp(ei.cond, ctx);
            const next = this.uniq('elif');
            skip(ei.neg, i + 1 < s.elifs.length || s.else ? next : endL);
            for (const st of ei.body) this.stat(st, ctx);
            a.bra(endL);
            a.label(next);
          }
          for (const st of s.else ?? []) this.stat(st, ctx);
        }
        a.label(endL);
        break;
      }
      case 'While': {
        // E-VO generalised WHILE: each iteration tries the WHILE/ELSEWHILE[N]
        // branches top-down; the first whose condition matches runs its body
        // then the ALWAYS part; if none match the loop exits.
        const top = this.uniq('wh'), end = this.uniq('whend');
        const alwaysL = s.always ? this.uniq('whalw') : top;
        ctx.loopEnds.push(end);
        ctx.loopConts.push(alwaysL);   // CONT re-enters via ALWAYS (or top)
        a.label(top);
        for (const b of s.branches) {
          const next = this.uniq('whnext');
          this.exp(b.cond, ctx);
          a.tstl(D0);
          if (b.neg) a.bne(next); else a.beq(next);
          for (const st of b.body) this.stat(st, ctx);
          a.bra(alwaysL);
          a.label(next);
        }
        a.bra(end);   // no branch matched
        if (s.always) {
          a.label(alwaysL);
          for (const st of s.always) this.stat(st, ctx);
          a.bra(top);
        }
        a.label(end);
        ctx.loopEnds.pop();
        ctx.loopConts.pop();
        break;
      }
      case 'Repeat': {
        const top = this.uniq('rp'), end = this.uniq('rpend');
        ctx.loopEnds.push(end);
        ctx.loopConts.push(top);
        a.label(top);
        for (const st of s.body) this.stat(st, ctx);
        this.exp(s.cond, ctx);
        a.tstl(D0);
        // REPEAT..UNTIL loops while cond FALSE; UNTILN loops while cond TRUE.
        if (s.neg) a.bne(top); else a.beq(top);
        a.label(end);
        ctx.loopEnds.pop();
        ctx.loopConts.pop();
        break;
      }
      case 'Loop': {
        const top = this.uniq('lp'), end = this.uniq('lpend');
        ctx.loopEnds.push(end);
        ctx.loopConts.push(top);
        a.label(top);
        for (const st of s.body) this.stat(st, ctx);
        a.bra(top);
        a.label(end);
        ctx.loopEnds.pop();
        ctx.loopConts.pop();
        break;
      }
      case 'For': {
        const top = this.uniq('for'), end = this.uniq('forend');
        const step = s.step ? this.sem.foldConst(s.step) : 1;
        if (step === null) { this.err(s, 'tracer: STEP must be constant'); break; }
        const cont = this.uniq('forcont');
        this.exp(s.from, ctx);
        this.storeVar(s.var, ctx, s);
        ctx.loopEnds.push(end);
        ctx.loopConts.push(cont);   // CONT skips to the increment+retest
        a.label(top);
        this.exp(s.to, ctx);
        a.movel_dd(D0, D1);
        this.loadVar(s.var, ctx, s);
        a.cmpl_dd(D1, D0);                       // var - limit
        a.bcc(step > 0 ? COND.GT : COND.LT, end);
        for (const st of s.body) this.stat(st, ctx);
        a.label(cont);
        const r = this.varRef(s.var, ctx);
        const an = r.kind === 'global' ? A4 : A5;
        if (step >= 1 && step <= 8) a.addql_disp(step, r.disp, an);
        else if (step <= -1 && step >= -8) a.subql_disp(-step, r.disp, an);
        else {
          this.loadVar(s.var, ctx, s);
          a.movel_imm(step, D1);
          a.addl_dd(D1, D0);
          this.storeVar(s.var, ctx, s);
        }
        a.bra(top);
        a.label(end);
        ctx.loopEnds.pop();
        ctx.loopConts.pop();
        break;
      }
      case 'Exit': {
        const end = ctx.loopEnds[ctx.loopEnds.length - 1];
        if (!end) { this.err(s, 'EXIT outside loop'); break; }
        if (s.cond) {
          this.exp(s.cond, ctx);
          a.tstl(D0);
          // EXIT cond exits when TRUE; EXITN exits when FALSE.
          if (s.neg) a.beq(end); else a.bne(end);
        } else a.bra(end);
        break;
      }
      case 'Cont': {   // E-VO loop continue (CONTN = inverted condition)
        const cont = ctx.loopConts[ctx.loopConts.length - 1];
        if (!cont) { this.err(s, 'CONT outside loop'); break; }
        if (s.cond) {
          this.exp(s.cond, ctx);
          a.tstl(D0);
          if (s.neg) a.beq(cont); else a.bne(cont);
        } else a.bra(cont);
        break;
      }
      case 'Inc': case 'Dec':
        this.incDec(s.lval, s.kind === 'Inc' ? 1 : -1, ctx, s);
        break;
      case 'Label': a.label(`user_${s.name}`); break;
      case 'Asm': {
        const at = new AsmText(a, {
          resolveVar: nm => {
            const r = this.varRef(nm, ctx);
            return r ? { an: r.kind === 'global' ? A4 : A5, disp: r.disp } : null;
          },
          label: nm => `user_${nm}`,
          constVal: nm => this.sem.consts.has(nm) ? this.sem.consts.get(nm) : null,
        });
        at.line(s.text, s.line);
        for (const msg of at.errors) this.err(s, `asm: ${msg}`);
        break;
      }
      case 'Jump': a.bra(`user_${s.label}`); break;
      case 'MultiAssign': {
        // a,b,c := f() — E fills targets from the multiple return values;
        // single-value sources put the value in the FIRST target, rest get 0
        // (D0/D1/D2 convention used by our own procs for multi-returns)
        this.exp(s.exp, ctx);
        for (let i = 0; i < s.targets.length && i < 3; i++) {
          if (i > 0) a.movel_dd(i, D0);
          this.storeVar(s.targets[i], ctx, s);
        }
        if (s.targets.length > 3) this.err(s, 'more than 3 multi-assign targets');
        break;
      }
      case 'Select': {
        const end = this.uniq('selend');
        // subject value lives on the stack for the duration of the dispatch
        this.exp(s.of ?? s.subject, ctx);
        a.movel_d_push(D0);
        const caseLabels = s.cases.map(() => this.uniq('case'));
        const defL = this.uniq('seldef');
        for (let i = 0; i < s.cases.length; i++) {
          for (const m of s.cases[i].matches) {
            if (m.exp) {
              this.exp(m.exp, ctx);
              a.movel_dd(D0, D1);
              a.movel_disp_d(0, A7, D0);   // subject from stack top
              a.cmpl_dd(D1, D0);
              a.beq(caseLabels[i]);
            } else {
              const next = this.uniq('rng');
              this.exp(m.from, ctx);
              a.movel_dd(D0, D1);
              a.movel_disp_d(0, A7, D0);
              a.cmpl_dd(D1, D0);
              a.bcc(COND.LT, next);        // subject < from → no
              this.exp(m.to, ctx);
              a.movel_dd(D0, D1);
              a.movel_disp_d(0, A7, D0);
              a.cmpl_dd(D1, D0);
              a.bcc(COND.LE, caseLabels[i]);
              a.label(next);
            }
          }
        }
        a.bra(defL);
        for (let i = 0; i < s.cases.length; i++) {
          a.label(caseLabels[i]);
          for (const st of s.cases[i].body) this.stat(st, ctx);
          a.bra(end);
        }
        a.label(defL);
        for (const st of s.default ?? []) this.stat(st, ctx);
        a.label(end);
        a.addql_a(4, A7);                  // drop subject
        break;
      }
      case 'NewStat':
        for (const t of s.targets) this.genNew(t, ctx, s);
        break;
      case 'EndStat':
        for (const t of s.targets) {
          const v = t.kind === 'Index' ? t.obj : t;   // END p[10] frees via p
          if (v.kind !== 'Var') { this.err(s, 'END on plain variables only'); continue; }
          // binary-module class: dispatch the destructor through the vtable
          // (odestr slot) when non-NIL, then free — see docs/oop-dispatch.md
          const bcls = this.binaryClassOf(v, ctx);
          if (bcls) {
            // odestr is the destructor's vtable slot, or 0xffff when the class
            // has none (then END just frees the instance).
            if (bcls.odestr && bcls.odestr !== 0xffff) {
              this.loadVar(v.name, ctx, s);            // D0 = instance
              const skip = this.uniq('endnil');
              a.tstl(D0); a.beq(skip);
              a.movel_da(D0, A0);                      // self in A0
              a.movel_disp_a(0, A0, A1);               // descriptor
              a.movel_disp_a(bcls.odestr, A1, A1);     // descriptor[odestr] = dtor
              a.jsr_ind(A1);
              a.label(skip);
            }
            this.loadVar(v.name, ctx, s);
            a.bsr('__dispose');
            this.storeVar(v.name, ctx, s);
            continue;
          }
          // ch_14: END runs the object's end() destructor when it has one
          const vt = this.typeOf(v, ctx);
          let objName = vt?.base === 'PTR' ? vt.to?.name : null;
          while (objName) {
            if (this.sem.procs.has(`${objName}.end`)) {
              this.call({ kind: 'Call', callee: { kind: 'Member', obj: v, name: 'end' }, args: [] }, ctx);
              break;
            }
            objName = this.sem.objects.get(objName)?.of ?? null;
          }
          this.loadVar(v.name, ctx, s);
          a.bsr('__dispose');
          this.storeVar(v.name, ctx, s);              // nuked to NIL (ch_5M)
        }
        break;
      default:
        this.err(s, `tracer: statement ${s.kind} not yet supported`);
    }
  }

  // Immediate list [a,b,c]: a STATIC area refilled on EVERY evaluation
  // (oracle-verified, constants included). Header: maxlen.w = bytes incl one
  // trailing NULL element, len.w = item count. Typed :obj lists initialize a
  // single object's members in declaration order.
  genList(e, ctx) {
    const a = this.a;
    const label = this.uniq('list');
    const t = e.type;
    let slots; // [{disp, size}] per item, relative to the data pointer
    let bytes;
    if (t?.base === 'OBJECT' || (t && !['INT', 'CHAR', 'LONG'].includes(t.base))) {
      const obj = this.sem.objects.get(t.name ?? t.base);
      if (!obj) { this.err(e, `unknown list type ${t.name ?? t.base}`); return; }
      const mems = [...obj.members.values()];
      slots = e.items.map((_, i) => {
        const m = mems[i];
        return m ? { disp: m.offset, size: m.size === 1 || m.size === 2 ? m.size : 4 } : null;
      });
      if (slots.some(s => !s)) { this.err(e, `more initializers than members in [..]:${t.name}`); return; }
      bytes = obj.size;
    } else {
      const esize = t?.base === 'CHAR' ? 1 : t?.base === 'INT' ? 2 : 4;
      slots = e.items.map((_, i) => ({ disp: i * esize, size: esize }));
      bytes = (e.items.length + 1) * esize;
    }
    this.lists.push({ label, bytes, count: e.items.length });
    for (let i = 0; i < e.items.length; i++) {
      this.exp(e.items[i], ctx);
      a.lea_pc(label, A0);
      this.storeTo(slots[i].disp, slots[i].size);
    }
    a.lea_pc(label, A0);
    a.movel_ad(A0, D0);
  }

  // ---------- binary-module class (vtable) dispatch — see docs/oop-dispatch.md
  // A class from a binary .m dispatches through a runtime "descriptor" (vtable)
  // built by the module's own code; self is passed in A0, args on the stack.

  // The binary class for an expression's static type, or null (source classes
  // and non-objects fall through to the existing static dispatch).
  binaryClassOf(exp, ctx) {
    const t = this.typeOf(exp, ctx);
    const name = t?.base === 'PTR' ? t.to?.name : t?.name;
    return name ? (this.sem.binaryClasses?.get(name) ?? null) : null;
  }

  // Lazily reserve globals for a class's descriptor: a pointer slot + the
  // descriptor region itself (delsize bytes). Returns {ptrSlot, region}.
  binaryClassGlobals(cls) {
    this._bcGlobals = this._bcGlobals ?? new Map();
    let g = this._bcGlobals.get(cls.name);
    if (g) return g;
    const ptrSlot = this.globalSlot(`__descrptr_${cls.name}`);
    const region = this.globalSize;
    this.globalSize += (cls.delsize + 1) & ~1;
    g = { ptrSlot, region };
    this._bcGlobals.set(cls.name, g);
    return g;
  }

  // Build the descriptor into its globals region by calling the module's own
  // builder (at moddescr_<class> = modbase+delcode), and stash the pointer.
  // Idempotent — EC (re)builds at each NEW.
  buildDescriptor(cls) {
    const a = this.a;
    const g = this.binaryClassGlobals(cls);
    a.lea_disp(g.region, A4, A0);            // A0 = &descriptor region
    a.movel_a_disp(A0, g.ptrSlot, A4);       // remember the descriptor pointer
    a.jsr_abs(`moddescr_${cls.name}`);       // builder fills [A0]: size + methods
  }

  // Build EVERY linked binary class's descriptor at startup, into its A4 slot.
  // Module-internal NEW (a class method that does `NEW x` of another class)
  // reads x's descriptor pointer from a fixed A4 slot bound via a MODINFO
  // "descriptor-pointer" ref (see emitBinaryModules) — that slot must already
  // hold the descriptor before any module code runs. EC builds the whole table
  // in its own startup; ecomp previously built lazily at each main-level NEW, so
  // descriptors only reachable from inside module code were never built.
  emitDescriptorTable() {
    for (const cls of this.sem.binaryClasses?.values() ?? []) {
      if (cls.delcode == null) continue;     // interface-only class (no vtable)
      this.buildDescriptor(cls);
    }
  }

  // obj.method(args): push args (left-to-right, same as binary procs), load
  // self into A0, then `(A0)->A1; (slot,A1)->A1; jsr (A1)`. Result in D0.
  emitBinaryMethodCall(cls, slot, objExp, args, ctx) {
    const a = this.a;
    for (const arg of args) { this.exp(arg, ctx); a.movel_d_push(D0); }
    this.exp(objExp, ctx);                   // instance ptr -> D0
    a.movel_da(D0, A0);                      // self in A0
    a.movel_disp_a(0, A0, A1);               // A1 = descriptor = (A0)
    a.movel_disp_a(slot, A1, A1);            // A1 = descriptor[slot] = method
    a.jsr_ind(A1);
    const pop = 4 * args.length;
    if (pop) { if (pop <= 8) a.addql_a(pop, A7); else a.addal_imm(pop, A7); }
  }

  // NEW p / NEW p[n] — allocate zeroed memory sized from p's pointer type
  genNew(lval, ctx, node) {
    const a = this.a;
    // constructor form: NEW a.create(args) — allocate, then call the method
    if (lval.kind === 'Call' && lval.callee.kind === 'Member') {
      const objExp = lval.callee.obj;
      const bcls = this.binaryClassOf(objExp, ctx);
      if (bcls) {
        // binary-module class: build vtable, alloc OSIZE, set instance[0] =
        // descriptor, then dispatch the constructor through the vtable.
        this.buildDescriptor(bcls);
        this.genNew(objExp, ctx, node);          // alloc OSIZE + store to objExp
        this.exp(objExp, ctx);                   // D0 = instance
        a.movel_da(D0, A0);
        a.movel_disp_d(this.binaryClassGlobals(bcls).ptrSlot, A4, D1);
        a.movel_d_ind(D1, A0);                   // instance[0] = descriptor ptr
        // the constructor is the method NAMED in `NEW obj.method(...)` (often
        // the class name, but `new`/`init`/… for the oomodules) — not whatever
        // merely matches the class name.
        const ctorM = bcls.methods.get(lval.callee.name) ??
          (bcls.ctorSlot != null ? { slot: bcls.ctorSlot } : null);
        if (ctorM) this.emitBinaryMethodCall(bcls, ctorM.slot, objExp, lval.args, ctx);
        else this.err(node, `no constructor ${lval.callee.name} on ${bcls.name}`);
        this.exp(objExp, ctx);                   // expression value is the object
        return;
      }
      this.genNew(objExp, ctx, node);
      this.call({ kind: 'Call', callee: lval.callee, args: lval.args }, ctx);
      this.exp(objExp, ctx);            // expression value is the object
      return;
    }
    const target = lval.kind === 'Index' ? lval.obj : lval;
    if (target.kind !== 'Var' && target.kind !== 'Member') {
      this.err(node, `NEW target must be a variable or member`);
      return;
    }
    const t = this.typeOf(target, ctx);
    const to = t?.base === 'PTR' ? t.to : null;
    const esize = to?.base === 'OBJECT'
      ? (this.sem.objects.get(to.name)?.size ?? 4)
      : typeSize(to);
    if (lval.kind === 'Index') {
      this.exp(lval.idx, ctx);
      if (esize === 2) a.addl_dd(D0, D0);
      else if (esize === 4) { a.addl_dd(D0, D0); a.addl_dd(D0, D0); }
      else if (esize !== 1) { a.movel_imm(esize, D1); a.mulsw_dd(D1, D0); }
    } else {
      if (esize >= -128 && esize <= 127) a.moveq(esize, D0);
      else a.movel_imm(esize, D0);
    }
    a.bsr('__new');
    if (target.kind === 'Var') this.storeVar(target.name, ctx, node);
    else {
      a.movel_d_push(D0);
      const disp = this.addressOf(target, ctx);
      a.movel_pop_d(D0);
      this.storeTo(disp, 4);
    }
  }

  incDec(lval, delta, ctx, node) {
    const a = this.a;
    if (lval.kind === 'Var') {
      const r = this.varRef(lval.name, ctx);
      if (!r) { this.err(node, `tracer: unknown variable ${lval.name}`); return; }
      const an = r.kind === 'global' ? A4 : A5;
      if (delta > 0) a.addql_disp(delta, r.disp, an);
      else a.subql_disp(-delta, r.disp, an);
      return;
    }
    const disp = this.addressOf(lval, ctx);
    const size = this.accessSize(lval, ctx);
    this.loadFrom(disp, size);
    if (delta > 0) a.addql(delta, D0);
    else a.subql(-delta, D0);
    this.storeTo(disp, size);
  }

  // ---------- expressions (result in D0) ----------

  exp(e, ctx) {
    const a = this.a;
    switch (e.kind) {
      case 'Num': case 'Char': {
        const v = e.value | 0;
        if (v >= -128 && v <= 127) a.moveq(v, D0);
        else a.movel_imm(v, D0);
        break;
      }
      case 'Float': {
        // float literals are raw IEEE-single bits in a LONG (oracle: 2.5 =
        // $40200000)
        const dv = new DataView(new ArrayBuffer(4));
        dv.setFloat32(0, e.value, false);
        a.movel_imm(dv.getInt32(0, false), D0);
        break;
      }
      case 'Nil': a.moveq(0, D0); break;
      case 'Str': {
        a.lea_pc(this.strLabel(e.value), A0);
        a.movel_ad(A0, D0);
        break;
      }
      case 'Var': {
        if (e.refType === 'upper') {
          const c = this.sem.consts.get(e.name);
          if (c === undefined) { this.err(e, `tracer: unknown constant ${e.name}`); break; }
          if (c >= -128 && c <= 127) a.moveq(c, D0);
          else a.movel_imm(c, D0);
          break;
        }
        this.loadVar(e.name, ctx, e);
        break;
      }
      case 'Paren': this.exp(e.exp, ctx); break;
      case 'Neg':
        // a negative float literal IS the literal with its sign bit (ec
        // folds it); integer NEG of IEEE bits is something else entirely
        if (e.exp.kind === 'Float') {
          const dv = new DataView(new ArrayBuffer(4));
          dv.setFloat32(0, -e.exp.value, false);
          a.movel_imm(dv.getInt32(0, false), D0);
          break;
        }
        this.exp(e.exp, ctx); a.negl(D0); break;
      case 'Not':   // E-VO unary bitwise complement (NOT x / ~x)
        this.exp(e.exp, ctx); a.notl(D0); break;
      case 'Bin': case 'FloatConv': case 'FloatPrefix':
        this.fchain(e, ctx, { f: false });
        break;
      case 'QuickCompare': {   // E-VO  exp == [v, lo TO hi, ...]  -> -1/0
        const tru = this.uniq('qctrue'), end = this.uniq('qcend');
        this.exp(e.exp, ctx);
        a.movel_dd(D0, D2);                 // subject kept in D2
        for (const it of e.items) {
          if (it.val !== undefined) {
            this.exp(it.val, ctx);
            a.cmpl_dd(D0, D2);              // D2 - val
            a.beq(tru);
          } else {                          // lo TO hi (inclusive)
            const skip = this.uniq('qcskip');
            this.exp(it.from, ctx);
            a.cmpl_dd(D0, D2);              // D2 - lo
            a.bcc(COND.LT, skip);           // D2 < lo -> not in range
            this.exp(it.to, ctx);
            a.cmpl_dd(D0, D2);              // D2 - hi
            a.bcc(COND.LE, tru);            // D2 <= hi -> match
            a.label(skip);
          }
        }
        a.moveq(0, D0); a.bra(end);
        a.label(tru); a.moveq(-1, D0);
        a.label(end);
        break;
      }
      case 'Logical': {   // E-VO ANDALSO / ORELSE — short-circuit, result -1/0
        const end = this.uniq('scend');
        if (e.op === 'ANDALSO') {
          const f = this.uniq('scfalse');
          this.exp(e.l, ctx); a.tstl(D0); a.beq(f);
          this.exp(e.r, ctx); a.tstl(D0); a.beq(f);
          a.moveq(-1, D0); a.bra(end);
          a.label(f); a.moveq(0, D0);
        } else {   // ORELSE
          const tr = this.uniq('sctrue');
          this.exp(e.l, ctx); a.tstl(D0); a.bne(tr);
          this.exp(e.r, ctx); a.tstl(D0); a.bne(tr);
          a.moveq(0, D0); a.bra(end);
          a.label(tr); a.moveq(-1, D0);
        }
        a.label(end);
        break;
      }
      case 'AssignExp':
        this.exp(e.exp, ctx);
        if (e.target.kind === 'Var') this.storeVar(e.target.name, ctx, e);
        else this.err(e, 'tracer: assign to plain variables only');
        break;
      case 'Ternary': {
        const elseL = this.uniq('telse'), endL = this.uniq('tend');
        this.exp(e.cond, ctx);
        a.tstl(D0);
        a.beq(elseL);
        this.exp(e.then, ctx);
        a.bra(endL);
        a.label(elseL);
        this.exp(e.else, ctx);
        a.label(endL);
        break;
      }
      case 'But':
        this.exp(e.first, ctx);
        this.exp(e.value, ctx);
        break;
      case 'Member': case 'Index': {
        const disp = this.addressOf(e, ctx);
        const size = this.accessSize(e, ctx);
        if (size === 0) {                      // embedded member: its address
          a.lea_disp(disp, A0, A0);
          a.movel_ad(A0, D0);
        } else this.loadFrom(disp, size);
        break;
      }
      case 'PostInc': case 'PostDec': {
        // Oracle-verified: ++/-- always move the base VARIABLE, scaled by the
        // pointed-to type size (PTR TO INT → 2, object → its size, plain → 1).
        // a[0]++ yields the element value, then advances `a` itself.
        // x++ yields old value then bumps; x-- bumps first, yields new (ch_4D).
        const post = e.kind === 'PostInc';
        const baseVar = e.obj.kind === 'Index' ? e.obj.obj : e.obj;
        if (baseVar.kind !== 'Var') { this.err(e, `++/-- target must be a variable`); break; }
        const r = this.varRef(baseVar.name, ctx);
        if (!r) { this.err(e, `unknown variable ${baseVar.name}`); break; }
        const an = r.kind === 'global' ? A4 : A5;
        const delta = e.obj.kind === 'Index'
          ? this.elemSize(this.typeOf(e.obj, ctx))
          : this.ptrDelta(this.typeOf(baseVar, ctx));
        const bump = () => {
          if (delta <= 8) {
            if (post) a.addql_disp(delta, r.disp, an);
            else a.subql_disp(delta, r.disp, an);
          } else {
            a.movel_disp_d(r.disp, an, D1);
            a.movel_imm(post ? delta : -delta, D0);
            a.addl_dd(D1, D0);
            a.movel_d_disp(D0, r.disp, an);
          }
        };
        if (!post) bump();
        if (e.obj.kind === 'Index') {
          const disp = this.addressOf(e.obj, ctx);
          this.loadFrom(disp, this.accessSize(e.obj, ctx));
        } else {
          a.movel_disp_d(r.disp, an, D0);
        }
        if (post) {
          if (delta <= 8) bump();   // addq/subq on memory leaves D0 alone
          else { a.movel_d_push(D0); bump(); a.movel_pop_d(D0); }
        }
        break;
      }
      case 'Deref': {
        const disp = this.addressOf(e, ctx);
        this.loadFrom(disp, 4);
        break;
      }
      case 'AddrOf': {
        const r = this.varRef(e.name, ctx);
        if (r) {
          a.lea_disp(r.disp, r.kind === 'global' ? A4 : A5, A0);
          a.movel_ad(A0, D0);
        } else if (this.sem.procs.has(e.name)) {
          // {proc} — a procedure's address (a callback / function pointer, as
          // EasyGUI action procs and hooks use). PC-relative lea yields the
          // absolute runtime address with no relocation.
          a.lea_pc(`proc_${e.name}`, A0);
          a.movel_ad(A0, D0);
        } else { this.err(e, `unknown variable {${e.name}}`); break; }
        break;
      }
      case 'Sizeof': {
        const v = this.sem.foldConst(e);
        if (v === null) { this.err(e, `unknown SIZEOF ${e.name}`); break; }
        if (v >= -128 && v <= 127) a.moveq(v, D0);
        else a.movel_imm(v, D0);
        break;
      }
      case 'Call': this.call(e, ctx); break;
      case 'New': this.genNew(e.lval, ctx, e); break;
      case 'List': this.genList(e, ctx); break;
      case 'Cell': {
        // <a,b|t> builds cons cells; eval left-to-right, build from the tail
        const items = e.items ?? [];
        for (const it of items) { this.exp(it, ctx); a.movel_d_push(D0); }
        if (e.tail) this.exp(e.tail, ctx);
        else a.moveq(0, D0);
        a.movel_d_push(D0);
        for (let i = items.length - 1; i >= 0; i--) {
          a.moveq(8, D0);
          a.bsr('__new');
          a.movel_da(D0, A0);
          a.movel_pop_d(D1);
          a.movel_d_disp(D1, 4, A0);   // tail = previous chain
          a.movel_pop_d(D1);
          a.movel_d_ind(D1, A0);       // head = item i
          a.movel_ad(A0, D0);
          a.movel_d_push(D0);
        }
        a.movel_pop_d(D0);
        break;
      }
      case 'Quote': {
        // ch_11: a quoted expression compiles out-of-line ending in RTS;
        // its value is the code address. Variables bind at EVAL time
        // (same A4/A5 discipline as real ec — locals are caller-beware).
        const label = this.uniq('quote');
        this.quotes.push({ label, exp: e.exp, ctx });
        a.lea_pc(label, A0);
        a.movel_ad(A0, D0);
        break;
      }
      default:
        this.err(e, `tracer: expression ${e.kind} not yet supported`);
    }
  }

  // fixed-register builtins: args in D0,D1,D2; result in D0
  static BUILTINS = {
    StrCopy: { label: '__strcopy', min: 2, max: 3, defaults: { 2: -1 } },
    StrAdd: { label: '__stradd', min: 2, max: 3, defaults: { 2: -1 } },
    StrLen: { label: '__strlen', min: 1, max: 1 },
    StrCmp: { label: '__strcmp', min: 2, max: 3, defaults: { 2: -1 } },
    New: { label: '__new', min: 1, max: 1 },
    Dispose: { label: '__dispose', min: 1, max: 1 },
    String: { label: '__newstring', min: 1, max: 1 },
    Val: { label: '__val', min: 1, max: 1 },
    InStr: { label: '__instr', min: 2, max: 3, defaults: { 2: 0 } },
    TrimStr: { label: '__trimstr', min: 1, max: 1 },
    UpperStr: { label: '__upperstr', min: 1, max: 1 },
    LowerStr: { label: '__lowerstr', min: 1, max: 1 },
    MidStr: { label: '__midstr', min: 3, max: 4, defaults: { 3: -1 } },
    RightStr: { label: '__rightstr', min: 3, max: 3 },
    SetStr: { label: '__setstr', min: 2, max: 2 },
    OstrCmp: { label: '__ostrcmp', min: 2, max: 3, defaults: { 2: -1 } },
    ReadStr: { label: '__readstr', min: 2, max: 2 },
    Mul: { label: '__mul32', min: 2, max: 2 },
    FastNew: { label: '__new', min: 1, max: 1 },
    FastDispose: { label: '__dispose', min: 1, max: 2 },
    Plot: { label: '__plot', min: 2, max: 3, defaults: { 2: 1 } },
    Line: { label: '__line', min: 4, max: 5, defaults: { 4: 1 } },
    Box: { label: '__box', min: 4, max: 5, defaults: { 4: 1 } },
    Colour: { label: '__colour', min: 1, max: 2, defaults: { 1: 0 } },
    SetStdRast: { label: '__setstdrast', min: 1, max: 1 },
  };

  // Amiga library functions E exposes as builtins (v40 module equivalents);
  // args go in the documented registers, result in D0
  static LIBCALLS = {
    OpenLibrary: { base: 'exec', off: -552, regs: ['a1', 'd0'] },
    CloseLibrary: { base: 'exec', off: -414, regs: ['a1'] },
    AvailMem: { base: 'exec', off: -216, regs: ['d1'] },
    Wait: { base: 'exec', off: -318, regs: ['d0'] },
    SetSignal: { base: 'exec', off: -306, regs: ['d0', 'd1'] },
    GetMsg: { base: 'exec', off: -372, regs: ['a0'] },
    PutMsg: { base: 'exec', off: -366, regs: ['a0', 'a1'] },
    ReplyMsg: { base: 'exec', off: -378, regs: ['a1'] },
    WaitPort: { base: 'exec', off: -384, regs: ['a0'] },
    FindTask: { base: 'exec', off: -294, regs: ['a1'] },
    CopyMem: { base: 'exec', off: -624, regs: ['a0', 'a1', 'd0'] },
    Open: { base: 'dos', off: -30, regs: ['d1', 'd2'] },
    Close: { base: 'dos', off: -36, regs: ['d1'] },
    Read: { base: 'dos', off: -42, regs: ['d1', 'd2', 'd3'] },
    Write: { base: 'dos', off: -48, regs: ['d1', 'd2', 'd3'] },
    Input: { base: 'dos', off: -54, regs: [] },
    Output: { base: 'dos', off: -60, regs: [] },
    Seek: { base: 'dos', off: -66, regs: ['d1', 'd2', 'd3'] },
    DeleteFile: { base: 'dos', off: -72, regs: ['d1'] },
    Rename: { base: 'dos', off: -78, regs: ['d1', 'd2'] },
    Lock: { base: 'dos', off: -84, regs: ['d1', 'd2'] },
    UnLock: { base: 'dos', off: -90, regs: ['d1'] },
    DupLock: { base: 'dos', off: -96, regs: ['d1'] },
    Examine: { base: 'dos', off: -102, regs: ['d1', 'd2'] },
    ExNext: { base: 'dos', off: -108, regs: ['d1', 'd2'] },
    CurrentDir: { base: 'dos', off: -126, regs: ['d1'] },
    IoErr: { base: 'dos', off: -132, regs: [] },
    CreateDir: { base: 'dos', off: -120, regs: ['d1'] },
    Delay: { base: 'dos', off: -198, regs: ['d1'] },
    Execute: { base: 'dos', off: -222, regs: ['d1', 'd2', 'd3'] },
  };

  // library call from a binary module: args per the module's register bytes
  // (0..7 = D0..D7, 8..15 = A0..A7), base pointer from its base variable
  emitModLibCall(e, ctx, mf) {
    const a = this.a;
    if (e.args.length > mf.regs.length) {
      this.err(e, `${e.callee.name} takes ${mf.regs.length} args`);
      return;
    }
    for (const arg of e.args) {
      this.exp(arg, ctx);
      a.movel_d_push(D0);
    }
    for (let i = e.args.length - 1; i >= 0; i--) {
      const r = mf.regs[i];
      if (r >= 8) a.movel_pop_a(r - 8);
      else a.movel_pop_d(r);
    }
    const slot = this.globalSlot(mf.base);
    a.movel_disp_a(slot, A4, A6);
    a.jsr_disp(mf.offset, A6);
  }

  emitLibCall(e, ctx, info) {
    const a = this.a;
    if (e.args.length > info.regs.length) {
      this.err(e, `${e.callee.name} takes ${info.regs.length} args`);
      return;
    }
    for (const arg of e.args) {
      this.exp(arg, ctx);
      a.movel_d_push(D0);
    }
    for (let i = e.args.length - 1; i >= 0; i--) {
      const r = info.regs[i];
      const n = Number(r[1]);
      if (r[0] === 'a') a.movel_pop_a(n);
      else a.movel_pop_d(n);
    }
    if (info.base === 'exec') a.movel_absw_a(4, A6);
    else a.movel_disp_a(this.globalSlot('dosbase'), A4, A6);   // dos
    a.jsr_disp(info.off, A6);
  }

  callFixed(e, ctx, info) {
    const a = this.a;
    const n = Math.max(e.args.length, info.min);
    if (e.args.length < info.min || e.args.length > info.max) {
      this.err(e, `${e.callee.name} expects ${info.min}..${info.max} args`);
      return;
    }
    const total = info.max;
    for (let i = 0; i < total; i++) {
      const arg = e.args[i];
      if (arg) this.exp(arg, ctx);
      else {
        const d = info.defaults?.[i] ?? 0;
        if (d >= -128 && d <= 127) a.moveq(d, D0);
        else a.movel_imm(d, D0);
      }
      if (i < total - 1) a.movel_d_push(D0);
    }
    if (total >= 2) {
      a.movel_dd(D0, total - 1);
      for (let i = total - 2; i >= 0; i--) a.movel_pop_d(i);
    }
    a.bsr(info.label);
    void n;
  }

  // expression chain with E's `!` float mode (ch_12B): mode toggles scan the
  // left spine left-to-right; each toggle CONVERTS the accumulated value;
  // operators execute per current mode; parens/calls reset to int mode.
  fchain(e, ctx, mode) {
    const a = this.a;
    if (e.kind === 'FloatConv') {
      this.fchain(e.exp, ctx, mode);
      this.emitFloatConv(mode.f);
      mode.f = !mode.f;
      return;
    }
    if (e.kind === 'FloatPrefix') {
      // leading ! has no accumulated expression: toggle only (ch_12B)
      mode.f = !mode.f;
      this.fchain(e.exp, ctx, mode);
      return;
    }
    if (e.kind !== 'Bin') { this.exp(e, ctx); return; }
    // ec folds constant integer expressions in full 32 bits at compile time,
    // while RUNTIME * and / are 16-bit MULS.W/DIVS.W (oracle-verified)
    const folded = this.sem.foldConst(e);
    if (folded !== null && typeof folded === 'number' && Number.isInteger(folded) && !mode.f) {
      if (folded >= -128 && folded <= 127) a.moveq(folded, D0);
      else a.movel_imm(folded, D0);
      return;
    }
    if (e.op === '<=>') { this.genUnify(e, ctx); return; }
    this.fchain(e.l, ctx, mode);
    if (!mode.f && (e.op === '*' || e.op === '/')) {
      // ec strength-reduces ONLY x*2 and x*4 (constant on the right);
      // constant operands outside 16 bits are a compile error
      const rc = this.sem.foldConst(e.r);
      const lc = this.sem.foldConst(e.l);
      if (e.op === '*' && (rc === 2 || rc === 4)) {
        a.addl_dd(D0, D0);
        if (rc === 4) a.addl_dd(D0, D0);
        return;
      }
      for (const c of [lc, rc]) {
        if (c !== null && (c < -32768 || c > 32767)) {
          this.err(e, `unsafe use of "*" or "/" (constant ${c} exceeds 16 bits)`);
        }
      }
    }
    a.movel_d_push(D0);
    let r = e.r, toggleAfter = false;
    if (r?.kind === 'FloatPrefix') { toggleAfter = true; r = r.exp; }
    this.exp(r, ctx);
    a.movel_dd(D0, D1);
    a.movel_pop_d(D0);
    if (mode.f) {
      const FOP = { '+': -66, '-': -72, '*': -78, '/': -84 };
      const mb = this.globalSlot('__mathbase');
      if (FOP[e.op] !== undefined) {
        a.movel_disp_a(mb, A4, A6);
        a.jsr_disp(FOP[e.op], A6);
      } else if (CMP_COND[e.op]) {
        a.movel_disp_a(mb, A4, A6);
        a.jsr_disp(-42, A6);           // IEEESPCmp → -1/0/1
        a.tstl(D0);
        a.scc(COND[CMP_COND[e.op]], D0);
        a.extw(D0);
        a.extl(D0);
      } else if (e.op === 'AND') a.andl_dd(D1, D0);
      else if (e.op === 'OR') a.orl_dd(D1, D0);
      else this.err(e, `operator ${e.op} not supported in float mode`);
    } else {
      switch (e.op) {
        case '+': a.addl_dd(D1, D0); break;
        case '-': a.subl_dd(D1, D0); break;
        case '*': a.mulsw_dd(D1, D0); break;
        case '/': a.divsw_dd(D1, D0); a.extl(D0); break;
        case 'AND': a.andl_dd(D1, D0); break;
        case 'OR': a.orl_dd(D1, D0); break;
        case 'SHL': case 'SHR': case 'XOR':
          if (e.op === 'XOR') a.eorl_dd(D1, D0);
          else if (e.op === 'SHL') a.asll_d(D1, D0);
          else a.asrl_d(D1, D0);
          break;
        default: {
          const cc = CMP_COND[e.op];
          if (!cc) { this.err(e, `tracer: operator ${e.op} not yet supported`); break; }
          a.cmpl_dd(D1, D0);
          a.scc(COND[cc], D0);
          a.extw(D0);
          a.extl(D0);
          break;
        }
      }
    }
    if (toggleAfter) mode.f = !mode.f;
  }

  // ch_4L unification: exp <=> [pattern] — constants must match, variables
  // bind, sub-lists recurse; yields TRUE/FALSE
  genUnify(e, ctx) {
    const a = this.a;
    const fail = this.uniq('ufail'), end = this.uniq('uend');
    this.exp(e.l, ctx);
    if (e.r?.kind !== 'List') { this.err(e, '<=> needs a list pattern'); return; }
    this.unifyPattern(e.r, ctx, fail);
    a.moveq(-1, D0);
    a.bra(end);
    a.label(fail);
    a.moveq(0, D0);
    a.label(end);
  }

  unifyPattern(pat, ctx, fail) {
    const a = this.a;
    const failPop = this.uniq('ufp'), cont = this.uniq('ucont');
    const n = pat.items.length;
    a.movel_d_push(D0);                  // current list ptr lives on the stack
    a.movel_da(D0, A0);
    a.movew_disp_d(-2, A0, D1);
    a.extl(D1);                          // ListLen
    if (n <= 127) a.moveq(n, D0);
    else a.movel_imm(n, D0);
    a.cmpl_dd(D0, D1);
    a.bne(failPop);
    for (let i = 0; i < n; i++) {
      const item = pat.items[i];
      a.movel_disp_d(0, A7, D1);
      a.movel_da(D1, A0);
      a.movel_disp_d(4 * i, A0, D0);     // element value
      const c = this.sem.foldConst(item);
      if (item.kind === 'Var' && item.refType === 'ident') {
        this.storeVar(item.name, ctx, item);
      } else if (c !== null && Number.isInteger(c)) {
        a.movel_imm(c, D1);
        a.cmpl_dd(D1, D0);
        a.bne(failPop);
      } else if (item.kind === 'List') {
        this.unifyPattern(item, ctx, failPop);
      } else if (item.kind === 'Str') {
        // string elements: compare contents
        a.movel_dd(D0, D1);
        a.lea_pc(this.strLabel(item.value), A0);
        a.movel_ad(A0, D0);
        a.movel_d_push(D0);
        a.movel_d_push(D1);
        a.movel_pop_d(D1);
        a.movel_pop_d(D0);
        a.moveq(-1, D2);
        a.bsr('__strcmp');
        a.tstl(D0);
        a.beq(failPop);
      } else {
        this.err(item, `unsupported pattern element ${item.kind}`);
      }
    }
    a.addql_a(4, A7);
    a.bra(cont);
    a.label(failPop);
    a.addql_a(4, A7);
    a.bra(fail);
    a.label(cont);
  }

  emitFloatConv(fromFloat) {
    const a = this.a;
    const mb = this.globalSlot('__mathbase');
    a.movel_disp_a(mb, A4, A6);
    a.jsr_disp(fromFloat ? -30 : -36, A6);  // IEEESPFix / IEEESPFlt
  }

  call(e, ctx) {
    const a = this.a;
    const callee = e.callee;
    if (callee.kind === 'Var' && callee.refType === 'ecall') {
      if (callee.name === 'TextF') {
        // TextF(x, y, fmt, args…) — WriteF onto stdrast at (x,y)
        const n = e.args.length - 3;
        for (const arg of e.args) {
          this.exp(arg, ctx);
          a.movel_d_push(D0);
        }
        a.movel_disp_d(4 * (n + 2), A7, D0);                  // x
        a.movel_disp_d(4 * (n + 1), A7, D1);                  // y
        a.movel_disp_a(4 * n, A7, A0);                        // fmt
        if (n > 0) a.lea_disp(4 * (n - 1), A7, A1);
        else a.movel_aa(A7, A1);
        a.bsr('__textf');
        const pop = 4 * e.args.length;
        if (pop <= 8) a.addql_a(pop, A7);
        else a.addal_imm(pop, A7);
        return;
      }
      if (callee.name === 'WriteF' || callee.name === 'StringF') {
        // ALL arguments evaluate left-to-right (E order; oracle-verified by
        // side-effecting args). Pushed L→R, so the runtimes walk descending.
        const isStringF = callee.name === 'StringF';
        const fixed = isStringF ? 2 : 1;     // StringF(est, fmt, ...) WriteF(fmt, ...)
        const n = e.args.length - fixed;
        for (const arg of e.args) {
          this.exp(arg, ctx);
          a.movel_d_push(D0);
        }
        if (isStringF) a.movel_disp_d(4 * (n + 1), A7, D0);   // est
        a.movel_disp_a(4 * n, A7, A0);                        // fmt
        if (n > 0) a.lea_disp(4 * (n - 1), A7, A1);           // &arg1
        else a.movel_aa(A7, A1);
        a.bsr(isStringF ? '__stringf' : '__writef');
        const pop = 4 * e.args.length;
        if (pop <= 8) a.addql_a(pop, A7);
        else a.addal_imm(pop, A7);
        return;
      }
      if (['Shl', 'Shr', 'Mod', 'Eor'].includes(callee.name)) {
        // oracle-verified: Shr is arithmetic (ASR), Mod keeps dividend sign
        this.exp(e.args[0], ctx);
        a.movel_d_push(D0);
        this.exp(e.args[1], ctx);
        a.movel_dd(D0, D1);
        a.movel_pop_d(D0);
        if (callee.name === 'Shl') a.asll_d(D1, D0);
        else if (callee.name === 'Shr') a.asrl_d(D1, D0);
        else if (callee.name === 'Eor') a.eorl_dd(D1, D0);
        else { a.divsw_dd(D1, D0); a.swap(D0); a.extl(D0); }
        return;
      }
      {
        // float builtins: singbas one-arg, singtrans one-arg, Fpow two-arg
        const SB = { Fabs: -54, Ffloor: -90, Fceil: -96 };
        const TR = { Fatan: -30, Fsin: -36, Fcos: -42, Ftan: -48, Fexp: -78,
          Flog: -84, Fsqrt: -96, Fasin: -114, Facos: -120, Flog10: -126 };
        if (SB[callee.name] !== undefined || TR[callee.name] !== undefined) {
          this.exp(e.args[0], ctx);
          const sb = SB[callee.name] !== undefined;
          a.movel_disp_a(this.globalSlot(sb ? '__mathbase' : '__mathtrans'), A4, A6);
          a.jsr_disp(sb ? SB[callee.name] : TR[callee.name], A6);
          return;
        }
        if (callee.name === 'Fpow') {
          this.exp(e.args[0], ctx);
          a.movel_d_push(D0);
          this.exp(e.args[1], ctx);
          a.movel_dd(D0, D1);
          a.movel_pop_d(D0);
          a.movel_disp_a(this.globalSlot('__mathtrans'), A4, A6);
          a.jsr_disp(-90, A6);         // SPPow
          return;
        }
      }
      if (callee.name === 'Rnd' || callee.name === 'RndQ') {
        const seedSlot = this.globalSlot('__seed');
        if (callee.name === 'RndQ') {
          this.exp(e.args[0], ctx);      // caller-managed seed
          a.movel_imm(1664525, D1);
          a.bsr('__mul32');
          a.movel_imm(1013904223, D1);
          a.addl_dd(D1, D0);
          return;
        }
        this.exp(e.args[0], ctx);        // max
        a.movel_d_push(D0);
        a.movel_disp_d(seedSlot, A4, D0);
        a.movel_imm(1664525, D1);
        a.bsr('__mul32');
        a.movel_imm(1013904223, D1);
        a.addl_dd(D1, D0);
        a.movel_d_disp(D0, seedSlot, A4);
        a.lsrl_imm(1, D0);               // positive
        a.movel_pop_d(D1);               // max
        a.bsr('__udivmod');
        a.movel_dd(D1, D0);              // remainder = 0..max-1
        return;
      }
      if (callee.name === 'Link') {
        this.exp(e.args[0], ctx);
        a.movel_d_push(D0);
        this.exp(e.args[1], ctx);
        a.movel_dd(D0, D1);
        a.movel_pop_d(D0);
        a.movel_da(D0, A0);
        a.movel_d_disp(D1, -8, A0);    // next ptr lives at -8
        return;
      }
      if (callee.name === 'Next') {
        this.exp(e.args[0], ctx);
        a.movel_da(D0, A0);
        a.movel_disp_d(-8, A0, D0);
        return;
      }
      if (callee.name === 'DisposeLink') {
        this.exp(e.args[0], ctx);
        a.subql(8, D0);                // heap data start
        a.bsr('__dispose');            // oracle: DisposeLink returns NIL
        return;
      }
      if (callee.name === 'Eval') {
        this.exp(e.args[0], ctx);
        a.movel_da(D0, A0);
        a.jsr_ind(A0);
        return;
      }
      if (callee.name === 'Car' || callee.name === 'Cdr') {
        this.exp(e.args[0], ctx);
        a.movel_da(D0, A0);
        a.movel_disp_d(callee.name === 'Car' ? 0 : 4, A0, D0);
        return;
      }
      if (callee.name === 'Cons') {
        this.exp(e.args[0], ctx);
        a.movel_d_push(D0);
        this.exp(e.args[1], ctx);
        a.movel_d_push(D0);
        a.moveq(8, D0);
        a.bsr('__new');
        a.movel_da(D0, A0);
        a.movel_pop_d(D1);
        a.movel_d_disp(D1, 4, A0);     // tail
        a.movel_pop_d(D1);
        a.movel_d_ind(D1, A0);         // head
        return;
      }
      if (['MapList', 'ForAll', 'Exists', 'SelectList'].includes(callee.name)) {
        const four = callee.name === 'MapList' || callee.name === 'SelectList';
        for (const arg of e.args) {
          this.exp(arg, ctx);
          a.movel_d_push(D0);
        }
        if (four) { a.movel_pop_d(D3); a.movel_pop_d(D2); a.movel_pop_d(D1); a.movel_pop_d(D0); }
        else { a.movel_pop_d(D3); a.moveq(0, D2); a.movel_pop_d(D1); a.movel_pop_d(D0); }
        a.bsr(callee.name === 'MapList' ? '__maplist'
          : callee.name === 'SelectList' ? '__selectlist'
            : callee.name === 'ForAll' ? '__forall' : '__exists');
        return;
      }
      if (callee.name === 'Min' || callee.name === 'Max') {
        this.exp(e.args[0], ctx);
        a.movel_d_push(D0);
        this.exp(e.args[1], ctx);
        a.movel_dd(D0, D1);
        a.movel_pop_d(D0);
        const keep = this.uniq('mm');
        a.cmpl_dd(D1, D0);
        a.bcc(callee.name === 'Min' ? COND.LE : COND.GE, keep);
        a.movel_dd(D1, D0);
        a.label(keep);
        return;
      }
      if (callee.name === 'Bounds') {
        // Bounds(x, lo, hi): clamp into [lo, hi]
        this.exp(e.args[0], ctx);
        a.movel_d_push(D0);
        this.exp(e.args[1], ctx);
        a.movel_d_push(D0);
        this.exp(e.args[2], ctx);
        a.movel_dd(D0, D2);
        a.movel_pop_d(D1);
        a.movel_pop_d(D0);
        const okLo = this.uniq('blo'), done = this.uniq('bdn');
        a.cmpl_dd(D1, D0);
        a.bcc(COND.GE, okLo);
        a.movel_dd(D1, D0);
        a.label(okLo);
        a.cmpl_dd(D2, D0);
        a.bcc(COND.LE, done);
        a.movel_dd(D2, D0);
        a.label(done);
        return;
      }
      if (callee.name === 'Even' || callee.name === 'Odd') {
        this.exp(e.args[0], ctx);
        a.moveq(1, D1);
        a.andl_dd(D1, D0);
        a.tstl(D0);
        a.scc(callee.name === 'Even' ? COND.EQ : COND.NE, D0);
        a.extw(D0);
        a.extl(D0);
        return;
      }
      if (callee.name === 'KickVersion') {
        this.exp(e.args[0], ctx);
        a.movel_absw_a(4, A0);
        a.movew_disp_d(20, A0, D1);    // execbase lib_Version
        a.extl(D1);
        a.cmpl_dd(D1, D0);             // arg - version
        a.scc(COND.LE, D0);
        a.extw(D0);
        a.extl(D0);
        return;
      }
      if (callee.name === 'CtrlC') {
        a.moveq(0, D0);
        a.moveq(0, D1);
        a.movel_absw_a(4, A6);
        a.jsr_disp(-306, A6);          // SetSignal(0,0)
        a.movel_imm(0x1000, D1);       // SIGBREAKF_CTRL_C
        a.andl_dd(D1, D0);
        a.tstl(D0);
        a.scc(COND.NE, D0);
        a.extw(D0);
        a.extl(D0);
        return;
      }
      if (callee.name === 'WaitIMessage') {
        this.exp(e.args[0], ctx);
        a.bsr('__waitimsg');
        return;
      }
      if (['MsgCode', 'MsgQualifier', 'MsgIaddr'].includes(callee.name)) {
        const slot = this.globalSlot(
          callee.name === 'MsgCode' ? '__msgcode'
            : callee.name === 'MsgQualifier' ? '__msgqual' : '__msgiaddr');
        a.movel_disp_d(slot, A4, D0);
        return;
      }
      if (callee.name === 'Abs') {
        this.exp(e.args[0], ctx);
        const skip = this.uniq('abs');
        a.tstl(D0);
        a.bcc(COND.PL, skip);
        a.negl(D0);
        a.label(skip);
        return;
      }
      if (callee.name === 'Not') {
        this.exp(e.args[0], ctx);
        a.notl(D0);
        return;
      }
      if (callee.name === 'OpenS') {
        // OpenS(w,h,depth,sflags,title,taglist=NIL) via OpenScreenTagList
        for (let i = 0; i < 6; i++) {
          if (e.args[i]) this.exp(e.args[i], ctx);
          else a.moveq(0, D0);
          a.movel_d_push(D0);
        }
        a.bsr('__opens');
        a.addal_imm(24, A7);
        return;
      }
      if (callee.name === 'CloseS') {
        this.exp(e.args[0], ctx);
        a.bsr('__closes');
        return;
      }
      if (callee.name === 'Mouse') {
        // ch_9D: reads the hardware directly (left=1, right=2)
        a.moveq(0, D0);
        a.movel_imm(0xbfe001, D1);
        a.movel_da(D1, A0);
        a.moveb_ind_d(A0, D1);
        const noL = this.uniq('ms');
        a.w16(0x0801); a.w16(6);       // btst #6,d1
        a.bne(noL);
        a.addql(1, D0);                // left pressed (active low)
        a.label(noL);
        a.movel_imm(0xdff016, D1);
        a.movel_da(D1, A0);
        a.movew_ind_d(A0, D1);
        const noR = this.uniq('ms');
        a.w16(0x0801); a.w16(10);      // btst #10,d1
        a.bne(noR);
        a.addql(2, D0);                // right pressed (active low)
        a.label(noR);
        return;
      }
      if (callee.name === 'MouseX' || callee.name === 'MouseY') {
        this.exp(e.args[0], ctx);
        a.movel_da(D0, A0);
        a.movew_disp_d(callee.name === 'MouseY' ? 12 : 14, A0, D0);
        a.extl(D0);
        return;
      }
      if (callee.name === 'OpenW') {
        // OpenW(x,y,w,h,idcmp,wflags,title,screen,sflags,gadgets,tags=NIL)
        for (let i = 0; i < 11; i++) {
          if (e.args[i]) this.exp(e.args[i], ctx);
          else a.moveq(0, D0);
          a.movel_d_push(D0);
        }
        a.bsr('__openw');
        a.addal_imm(44, A7);
        return;
      }
      if (callee.name === 'CloseW') {
        this.exp(e.args[0], ctx);
        a.bsr('__closew');
        return;
      }
      if (callee.name === 'Raise') {
        if (e.args[0]) this.exp(e.args[0], ctx);
        else a.moveq(0, D0);
        a.bsr('__raise');
        return;
      }
      if (callee.name === 'Throw') {
        this.exp(e.args[0], ctx);
        a.movel_d_push(D0);
        this.exp(e.args[1], ctx);
        a.movel_d_disp(D0, this.globalSlot('exceptioninfo'), A4);  // exceptioninfo
        a.movel_pop_d(D0);
        a.bsr('__raise');
        return;
      }
      if (callee.name === 'ReThrow') {
        const skip = this.uniq('rethrow');
        a.movel_disp_d(this.globalSlot('exception'), A4, D0);  // current exception
        a.beq(skip);
        a.bsr('__raise');
        a.label(skip);
        return;
      }
      if (callee.name === 'CleanUp') {
        if (e.args[0]) this.exp(e.args[0], ctx);
        else a.moveq(0, D0);
        a.movel_d_disp(D0, 16, A4);    // exit code
        a.movel_disp_a(12, A4, A7);    // unwind to startup SP
        a.bra('__exit');
        return;
      }
      if (callee.name === 'Long' || callee.name === 'Int' || callee.name === 'Char') {
        this.exp(e.args[0], ctx);
        a.movel_da(D0, A0);
        if (callee.name === 'Long') a.movel_ind_d(A0, D0);
        else if (callee.name === 'Int') { a.movew_ind_d(A0, D0); a.extl(D0); }
        else { a.moveq(0, D0); a.moveb_ind_d(A0, D0); }
        return;
      }
      if (['EstrLen', 'StrMax', 'ListLen', 'ListMax'].includes(callee.name)) {
        this.exp(e.args[0], ctx);
        a.movel_da(D0, A0);
        a.movew_disp_d(callee.name === 'EstrLen' || callee.name === 'ListLen' ? -2 : -4, A0, D0);
        a.extl(D0);
        return;
      }
      const info = Codegen.BUILTINS[callee.name];
      if (info) { this.callFixed(e, ctx, info); return; }
      const lib = Codegen.LIBCALLS[callee.name];
      if (lib) { this.emitLibCall(e, ctx, lib); return; }
      const mf = this.sem.libfuncs?.get(callee.name);
      if (mf) { this.emitModLibCall(e, ctx, mf); return; }
      this.err(e, `builtin ${callee.name} not yet supported`);
      return;
    }
    if (callee.kind === 'Var' && this.sem.procs.has(callee.name)) {
      const procInfo = this.sem.procs.get(callee.name);
      const isBin = this.sem.binaryProcs?.has(callee.name);
      for (const arg of e.args) {
        this.exp(arg, ctx);
        a.movel_d_push(D0);
      }
      let pushed = e.args.length;
      // A binary-module proc with default args reads ALL its declared params
      // from fixed stack offsets, so the caller must push the default values for
      // any omitted TRAILING args (the .m stores them as evaluated constants).
      // Without this the stack misaligns and the callee reads garbage params.
      if (isBin && procInfo.ndef && typeof procInfo.args === 'number') {
        const declared = procInfo.args;
        const nRequired = declared - procInfo.ndef;
        for (let i = e.args.length; i < declared; i++) {
          const dv = procInfo.defaults[i - nRequired] ?? 0;
          a.movel_imm(dv, D0);
          a.movel_d_push(D0);
          pushed++;
        }
      }
      // binary-module procs live in an appended code blob, possibly >32KB
      // away, so call them absolute (with a reloc) rather than PC-relative bsr.
      if (isBin) a.jsr_abs(`proc_${callee.name}`);
      else a.bsr(`proc_${callee.name}`);
      if (pushed) {
        if (pushed <= 2) a.addql_a(4 * pushed, A7);
        else a.addal_imm(4 * pushed, A7);
      }
      return;
    }
    if (callee.kind === 'Member') {
      // binary-module class: dispatch through the runtime vtable (self in A0)
      const bcls = this.binaryClassOf(callee.obj, ctx);
      if (bcls) {
        const m = bcls.methods.get(callee.name);
        if (!m) { this.err(e, `unknown method ${callee.name} on ${bcls.name}`); return; }
        this.emitBinaryMethodCall(bcls, m.slot, callee.obj, e.args, ctx);
        return;
      }
      // method call o.m(args): static dispatch on the declared type,
      // walking the inheritance chain; self is the hidden first argument
      const ot = this.typeOf(callee.obj, ctx);
      let objName = ot?.base === 'PTR' ? ot.to?.name : ot?.name;
      let owner = null;
      while (objName) {
        if (this.sem.procs.has(`${objName}.${callee.name}`)) { owner = objName; break; }
        objName = this.sem.objects.get(objName)?.of ?? null;
      }
      if (!owner) {
        this.err(e, `unknown method ${callee.name} on ${ot?.to?.name ?? ot?.name ?? '?'}`);
        return;
      }
      this.exp(callee.obj, ctx);        // self, pushed first (deepest)
      a.movel_d_push(D0);
      for (const arg of e.args) {
        this.exp(arg, ctx);
        a.movel_d_push(D0);
      }
      a.bsr(`proc_${owner}$${callee.name}`);
      const pop = 4 * (e.args.length + 1);
      if (pop <= 8) a.addql_a(pop, A7);
      else a.addal_imm(pop, A7);
      return;
    }
    this.err(e, `tracer: cannot call ${callee.kind === 'Var' ? callee.name : callee.kind}`);
  }
}

export function compileProgram(program, sem) {
  const cg = new Codegen(sem);
  const bin = cg.compile(program);
  return { bin, errors: cg.errors, stats: cg.stats ?? null };
}
