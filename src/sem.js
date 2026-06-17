// Semantic analysis: symbol tables, constant folding, object layouts, scope
// checking. Everything in E is a 32-bit LONG (ch_8); types only matter for
// pointer member access, array indexing width, and float ops.
//
// Unknown Capitalized identifiers are library/module symbols we may not have
// loaded — they warn rather than error so corpus sweeps stay meaningful.

const BUILTIN_CONSTS = new Map(Object.entries({
  TRUE: -1, FALSE: 0, NIL: 0, EMPTY: 0, ALL: -1,
  GADGETSIZE: 120,  // oracle-verified
  OLDFILE: 1005, NEWFILE: 1006,
  STRLEN: -1, // placeholder: STRLEN is the length of the last immediate string
}));

// sizes for member layout (ch_8): CHAR=1, INT=2, LONG/PTR=4
function typeSize(t) {
  if (!t) return 4;
  switch (t.base) {
    case 'CHAR': return 1;
    case 'INT': return 2;
    default: return 4;
  }
}

export class Sem {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.consts = new Map(BUILTIN_CONSTS);
    this.objects = new Map();   // name -> {name, of, members: Map(name->{offset,size,type}), size}
    this.procs = new Map();     // name -> {name, args, of, node}
    this.globals = new Map();   // name -> {decl}
    this.globals.set('exception', {});      // E builtin exception state
    this.globals.set('exceptioninfo', {});
    // E builtin global variables (ch_6E system variables)
    for (const g of ['arg', 'stdout', 'stdin', 'conout', 'stdrast', 'wbmessage',
      'execbase', 'dosbase', 'intuitionbase', 'gfxbase']) {
      this.globals.set(g, {});
    }
    this.modules = [];
  }

  err(node, msg) { this.errors.push({ line: node?.line, msg }); }
  warn(node, msg) { this.warnings.push({ line: node?.line, msg }); }

  analyze(program, opts = {}) {
    // pass 0: pull in binary module interfaces (consts, objects, lib funcs).
    // E predeclares the exec/dos/intuition/graphics library calls — model
    // that as implicit module imports.
    this.libfuncs = new Map();
    this.libBases = new Map();   // basename -> libname ('' for auto-opened)
    const decls = [
      { kind: 'Module', names: ['exec', 'dos', 'intuition', 'graphics'], implicit: true },
      ...program.decls,
    ];
    for (const d of decls) {
      if (d.kind !== 'Module') continue;
      for (const name of d.names) {
        const mod = opts.resolveModule?.(name);
        if (!mod && d.implicit) continue;
        if (!mod) {
          if (opts.resolveModule) this.warn(d, `module '${name}' not found`);
          continue;
        }
        if (mod.sourceProgram) {
          // source-level module: fold its declarations into this unit
          const sp = mod.sourceProgram;
          for (const sd of sp.decls) {
            if (sd.kind === 'Const') for (const it of sd.items) this.defConst(it.name, this.foldConst(it.value));
            else if (sd.kind === 'Enum') {
              let nx = 0;
              for (const it of sd.items) {
                if (it.value !== null && it.value !== undefined) nx = this.foldConst(it.value) ?? 0;
                this.defConst(it.name, nx++);
              }
            } else if (sd.kind === 'Set') {
              let bit = 0;
              for (const nm of sd.names) this.defConst(nm, 1 << bit++);
            } else if (sd.kind === 'Object') this.defObject(sd);
            else if (sd.kind === 'Def') for (const v of sd.decls) this.globals.set(v.name, { decl: v });
          }
          this.importedDecls = this.importedDecls ?? [];
          this.importedDecls.push(...sp.decls.filter(x => x.kind === 'Def'));
          this.importedProcs = this.importedProcs ?? [];
          for (const p of sp.procs) {
            const key = p.of ? `${p.of}.${p.name}` : p.name;
            if (!this.procs.has(key)) {
              this.procs.set(key, { name: p.name, args: p.args, of: p.of, node: p });
              this.importedProcs.push(p);
            }
          }
          continue;
        }
        this.registerBinaryModule(mod, name, opts);
      }
    }
    // pass 1: collect global declarations
    for (const opt of program.opts ?? []) {
      if (/^MODULE/.test(opt)) this.isModule = true;
    }
    for (const d of program.decls) {
      switch (d.kind) {
        case 'Module': this.modules.push(...d.names); break;
        case 'Const':
          for (const item of d.items) this.defConst(item.name, this.foldConst(item.value));
          break;
        case 'Enum': {
          let next = 0;
          for (const item of d.items) {
            if (item.value !== null && item.value !== undefined) {
              const v = this.foldConst(item.value);
              next = (v ?? 0);
            }
            this.defConst(item.name, next);
            next++;
          }
          break;
        }
        case 'Set': {
          let bit = 0;
          for (const name of d.names) this.defConst(name, 1 << bit++);
          break;
        }
        case 'Object': this.defObject(d); break;
        case 'Def':
          for (const v of d.decls) this.globals.set(v.name, { decl: v });
          break;
      }
    }
    // pass 2: procedures (collect first for forward references)
    for (const p of program.procs) {
      if (this.procs.has(p.name)) this.warn(p, `duplicate PROC ${p.name}`);
      this.procs.set(p.of ? `${p.of}.${p.name}` : p.name, { name: p.name, args: p.args, of: p.of, node: p });
    }
    for (const p of program.procs) this.checkProc(p);
    if (!this.isModule && !this.procs.has('main')) {
      this.errors.push({ line: 0, msg: 'no PROC main() and not OPT MODULE' });
    }
    return this;
  }

  // Register a resolved binary (.m) module: its consts, objects (incl. binary
  // class metadata for vtable dispatch), library bases, and linked code. Then
  // transitively pull in the modules it references via MODINFO — cross-module
  // class inheritance (a child class's builder calls its parent's builder, in
  // another module). The closure is what codegen blobs + binds.
  registerBinaryModule(mod, name, opts) {
    this._binLoaded = this._binLoaded ?? new Set();
    if (this._binLoaded.has(name)) return;
    this._binLoaded.add(name);

    for (const [k, v] of mod.consts) this.consts.set(k, v);
    for (const [k, obj] of mod.objects) {
      const members = new Map();
      for (const [mn, m] of obj.members) members.set(mn, { offset: m.offset, size: m.val || 0, type: null });
      if (!this.objects.has(k)) this.objects.set(k, { name: k, of: null, members, size: obj.size });
      if (mod.isCodeModule && obj.methods && obj.methods.length && !this.binaryClasses?.has(k)) {
        this.binaryClasses = this.binaryClasses ?? new Map();
        const methods = new Map();
        for (const me of obj.methods) methods.set(me.name, { slot: me.slot ?? me.offset, args: me.args, kind: me.kind });
        this.binaryClasses.set(k, {
          name: k, module: name, osize: obj.size, delsize: obj.delsize,
          delcode: obj.delcode, odestr: obj.odestr, methods,
          ctorSlot: methods.get(k)?.slot ?? null,
        });
      }
    }
    if (mod.lib) {
      this.libBases.set(mod.lib.basename, mod.lib.libname);
      this.globals.set(mod.lib.basename, {});
      for (const f of mod.lib.funcs) {
        if (!f.name) continue;
        this.libfuncs.set(f.name, { offset: f.offset, regs: f.regs, base: mod.lib.basename });
      }
    }
    if (mod.isCodeModule && mod.code) {
      this.binaryModules = this.binaryModules ?? [];
      this.binaryProcs = this.binaryProcs ?? new Set();
      this.binaryModules.push({
        name, code: mod.code, procs: mod.procs, relocs: mod.relocs,
        globs: mod.globs, globalsCount: mod.globalsCount, modinfo: mod.modinfo,
        objects: mod.objects,   // carries each class's OACC (descriptor-ref) list
      });
      for (const p of mod.procs) {
        if (p.kind !== 'proc' || this.procs.has(p.name)) continue;
        this.procs.set(p.name, { name: p.name, args: p.args, of: null, binary: true,
          ndef: p.ndef ?? 0, defaults: p.defaults ?? [] });
        this.binaryProcs.add(p.name);
      }
      // transitively link the modules referenced via MODINFO (parent classes)
      for (const mi of mod.modinfo ?? []) {
        const sub = mi.submodule.replace(/^emodules:/, '').replace(/\.m$/, '');
        if (this._binLoaded.has(sub)) continue;
        const parent = opts.resolveModule?.(sub);
        if (parent && !parent.sourceProgram) this.registerBinaryModule(parent, sub, opts);
        else if (!parent) this.warn(null, `MODINFO: cannot resolve parent module '${sub}' (for ${name})`);
      }
    }
  }

  defConst(name, value) {
    if (this.consts.has(name) && BUILTIN_CONSTS.get(name) === undefined) {
      this.warn(null, `redefined constant ${name}`);
    }
    this.consts.set(name, value);
  }

  defObject(d) {
    const parent = d.of ? this.objects.get(d.of) : null;
    if (d.of && !parent) this.warn(d, `unknown parent object ${d.of}`);
    const members = new Map(parent ? parent.members : []);
    let offset = parent ? parent.size : 0;
    for (const m of d.members) {
      const size = typeSize(m.type);
      const count = m.size ? (this.foldConst(m.size) ?? 1) : 1;
      // align INT/LONG members to even addresses like ec does
      if (size > 1 && (offset & 1)) offset++;
      members.set(m.name, { offset, size, type: m.type, count });
      offset += size * count;
    }
    if (offset & 1) offset++;
    this.objects.set(d.name, { name: d.name, of: d.of, members, size: offset });
  }

  // best-effort compile-time constant folding (constexp grammar)
  foldConst(e) {
    if (!e) return null;
    switch (e.kind) {
      case 'Paren': return this.foldConst(e.exp);
      case 'Num': case 'Char': return e.value | 0;
      case 'Float': return e.value;
      case 'Nil': return 0;
      case 'Neg': { const v = this.foldConst(e.exp); return v === null ? null : -v | 0; }
      case 'Not': { const v = this.foldConst(e.exp); return v === null ? null : ~v | 0; }
      case 'Var': {
        if (this.consts.has(e.name)) return this.consts.get(e.name);
        return null;
      }
      case 'Sizeof': {
        const o = this.objects.get(e.name);
        if (o) return o.size;
        if (e.name === 'LONG' || e.name === 'PTR') return 4;
        if (e.name === 'INT') return 2;
        if (e.name === 'CHAR') return 1;
        return null;
      }
      case 'Bin': {
        const l = this.foldConst(e.l), r = this.foldConst(e.r);
        if (l === null || r === null) return null;
        if (!Number.isInteger(l) || !Number.isInteger(r)) return null; // float chains fold at runtime
        switch (e.op) {
          case '+': return (l + r) | 0;
          case '-': return (l - r) | 0;
          case '*': return Math.imul(l, r);
          case '/': return r === 0 ? null : (l / r) | 0;
          case 'AND': return l & r;
          case 'OR': return l | r;
          case 'SHL': return l << r;
          case 'SHR': return l >>> r;
          case 'XOR': return l ^ r;
          case '=': return l === r ? -1 : 0;
          case '<>': return l !== r ? -1 : 0;
          case '<': return l < r ? -1 : 0;
          case '>': return l > r ? -1 : 0;
          case '<=': return l <= r ? -1 : 0;
          case '>=': return l >= r ? -1 : 0;
          default: return null;
        }
      }
      default: return null;
    }
  }

  checkProc(p) {
    const scope = new Map();
    scope.set('self', {});
    for (const a of p.args) scope.set(a.name, { decl: a });
    const walkStats = stats => { for (const s of stats ?? []) this.checkStat(s, scope, p); };
    walkStats(p.body);
    walkStats(p.except);
    for (const r of p.returns ?? []) this.checkExp(r, scope, p);
  }

  checkStat(s, scope, p) {
    if (!s) return;
    const walk = stats => { for (const x of stats ?? []) this.checkStat(x, scope, p); };
    switch (s.kind) {
      case 'Def':
        for (const v of s.decls) {
          if (scope.has(v.name)) this.warn(s, `duplicate DEF ${v.name} in ${p.name}`);
          scope.set(v.name, { decl: v });
          if (v.init) this.checkExp(v.init, scope, p);
        }
        break;
      case 'Assign': this.checkExp(s.target, scope, p); this.checkExp(s.exp, scope, p); break;
      case 'MultiAssign':
        for (const t of s.targets) this.checkVar(t, s, scope, p);
        this.checkExp(s.exp, scope, p);
        break;
      case 'ExprStat': this.checkExp(s.exp, scope, p); break;
      case 'If':
        this.checkExp(s.cond, scope, p);
        walk(s.then);
        for (const ei of s.elifs ?? []) { this.checkExp(ei.cond, scope, p); walk(ei.body); }
        walk(s.else);
        break;
      case 'For':
        this.checkVar(s.var, s, scope, p);
        this.checkExp(s.from, scope, p); this.checkExp(s.to, scope, p);
        if (s.step) this.checkExp(s.step, scope, p);
        walk(s.body);
        break;
      case 'While':
        for (const b of s.branches) { this.checkExp(b.cond, scope, p); walk(b.body); }
        if (s.always) walk(s.always);
        break;
      case 'Repeat': this.checkExp(s.cond, scope, p); walk(s.body); break;
      case 'Loop': walk(s.body); break;
      case 'Select':
        this.checkExp(s.subject, scope, p);
        if (s.of) this.checkExp(s.of, scope, p);
        walk(s.preStats);
        for (const c of s.cases) {
          for (const m of c.matches) {
            if (m.exp) this.checkExp(m.exp, scope, p);
            else { this.checkExp(m.from, scope, p); this.checkExp(m.to, scope, p); }
          }
          walk(c.body);
        }
        walk(s.default);
        break;
      case 'Return': for (const e of s.exps) this.checkExp(e, scope, p); break;
      case 'Exit': case 'Cont': if (s.cond) this.checkExp(s.cond, scope, p); break;
      case 'Swap': this.checkExp(s.a, scope, p); this.checkExp(s.b, scope, p); break;
      case 'Inc': case 'Dec': this.checkExp(s.lval, scope, p); break;
      case 'NewStat': for (const t of s.targets) this.checkExp(t, scope, p); break;
      case 'EndStat': for (const t of s.targets) this.checkExp(t, scope, p); break;
      case 'Void': this.checkExp(s.exp, scope, p); break;
      case 'Data': for (const v of s.values) this.checkExp(v, scope, p); break;
      case 'Jump': case 'Label': case 'Asm': case 'Incbin': case 'Preproc': break;
      default: break;
    }
  }

  checkVar(name, node, scope, p) {
    if (!scope.has(name) && !this.globals.has(name)) {
      this.err(node, `undefined variable '${name}' in ${p.name}`);
    }
  }

  checkExp(e, scope, p) {
    if (!e) return;
    switch (e.kind) {
      case 'Var': {
        if (e.refType === 'ident') {
          if (!scope.has(e.name) && !this.globals.has(e.name) && !this.procs.has(e.name)) {
            this.err(e, `undefined variable '${e.name}' in ${p.name}`);
          }
        } else if (e.refType === 'upper') {
          if (!this.consts.has(e.name) && this.modules.length === 0) {
            this.warn(e, `unknown constant ${e.name}`);
          }
        }
        // ecall refs are library/builtin functions — resolved at codegen
        break;
      }
      case 'Call': {
        // callee may be ident (own proc / variable holding code), ecall
        // (builtin or library), or a member chain (method call)
        if (e.callee.kind === 'Var' && e.callee.refType === 'ident') {
          if (!this.procs.has(e.callee.name) && !scope.has(e.callee.name) && !this.globals.has(e.callee.name)) {
            this.err(e, `call to undefined '${e.callee.name}' in ${p.name}`);
          }
        } else {
          this.checkExp(e.callee, scope, p);
        }
        for (const a of e.args) this.checkExp(a, scope, p);
        break;
      }
      case 'Bin': case 'Logical': this.checkExp(e.l, scope, p); this.checkExp(e.r, scope, p); break;
      case 'QuickCompare':   // E-VO  exp == [v, lo TO hi, ...]
        this.checkExp(e.exp, scope, p);
        for (const it of e.items) {
          if (it.val !== undefined) this.checkExp(it.val, scope, p);
          else { this.checkExp(it.from, scope, p); this.checkExp(it.to, scope, p); }
        }
        break;
      case 'Neg': case 'Not': case 'FloatConv': case 'FloatPrefix': case 'Quote': case 'Paren': this.checkExp(e.exp, scope, p); break;
      case 'AssignExp': this.checkExp(e.target, scope, p); this.checkExp(e.exp, scope, p); break;
      case 'Ternary': this.checkExp(e.cond, scope, p); this.checkExp(e.then, scope, p); this.checkExp(e.else, scope, p); break;
      case 'List': for (const i of e.items) this.checkExp(i, scope, p); break;
      case 'Cell':
        for (const i of e.items ?? []) this.checkExp(i, scope, p);
        if (e.tail) this.checkExp(e.tail, scope, p);
        break;
      case 'Index': this.checkExp(e.obj, scope, p); if (e.idx) this.checkExp(e.idx, scope, p); break;
      case 'Member': this.checkExp(e.obj, scope, p); break;
      case 'Cast': this.checkExp(e.obj, scope, p); break;
      case 'PostInc': case 'PostDec': this.checkExp(e.obj, scope, p); break;
      case 'Deref': this.checkExp(e.lval, scope, p); break;
      case 'New': this.checkExp(e.lval, scope, p); break;
      case 'NewList': this.checkExp(e.list, scope, p); break;
      case 'AddrOf': break; // {x} may reference labels resolved at codegen
      case 'But': this.checkExp(e.first, scope, p); this.checkExp(e.value, scope, p); break;
      case 'Super': this.checkExp(e.call, scope, p); break;
      case 'Num': case 'Float': case 'Str': case 'Char': case 'Nil':
      case 'Sizeof': case 'TypeRef': case 'Error': break;
      default: break;
    }
  }
}

export function analyze(program, opts = {}) {
  return new Sem().analyze(program, opts);
}
