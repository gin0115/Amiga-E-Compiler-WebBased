// Amiga E parser → AST. Grammar ground truth: ch_18A (v2.1b grammar) plus the
// v3.x additions from ch_4 (!, ::, <=>, NEW), ch_5 (EXIT, labels, SELECT..OF),
// ch_6 (default args, multiple returns), ch_13 (HANDLE/EXCEPT), ch_14 (methods,
// PRIVATE/PUBLIC/EXPORT). Expressions have NO precedence: strict left-to-right
// fold (oracle-verified: 1+2*3 = 9).
import { lex } from './lexer.js';

const BINOPS = new Set(['+', '-', '*', '/', '=', '<>', '<', '>', '<=', '>=', '<=>', '!']);
const KWBINOPS = new Set(['AND', 'OR']);

// Tokens after which an end-of-line does NOT terminate the statement (ch_1A:
// "lines ending with a comma, or any lexical element that can normally never
// occur at the end of a line").
function continuesLine(t) {
  // '>' is excluded: it closes a <a|b> cell, which can end a statement,
  // while a dangling comparison would always have its rhs on the same line
  if ([',', '+', '-', '*', '/', '(', '[', '{', ':=', '=', '<', '<=', '>=',
    '<>', '<=>', '::', '.', '`', '^', '|', ';'].includes(t.type)) return true;
  if (t.type === 'kw' && ['AND', 'OR', 'BUT', 'OF', 'TO',
    'STEP', 'IS', 'PTR'].includes(t.value)) return true;
  return false;
}

class Parser {
  constructor(tokens, filename) {
    this.filename = filename;
    this.toks = [];
    let prev = null;
    for (const t of tokens) {
      if (t.type === 'nl' && prev && continuesLine(prev)) continue;
      this.toks.push(t);
      if (t.type !== 'nl') prev = t;
      else prev = null;
    }
    this.k = 0;
    this.errors = [];
    // depth of one-line IF parsing: lets ELSE act as a soft statement
    // terminator so `IF e THEN s ELSE t` can hand ELSE back to parseIf
    this.softElse = 0;
    // inside <head|tail> a bare '>' closes the cell, it is not a comparison
    this.cellDepth = 0;
  }

  peek(o = 0) { return this.toks[Math.min(this.k + o, this.toks.length - 1)]; }
  next() { return this.toks[this.k < this.toks.length - 1 ? this.k++ : this.k]; }
  at(type, value) {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  atKw(v) { return this.at('kw', v); }
  eat(type, value) {
    if (this.at(type, value)) return this.next();
    return null;
  }
  expect(type, value, what) {
    const t = this.eat(type, value);
    if (!t) this.err(`expected ${what ?? value ?? type}, got ${this.describe(this.peek())}`);
    return t;
  }
  describe(t) { return t.type === 'nl' ? 'end of line' : `'${t.raw || t.type}'`; }
  err(msg) {
    const t = this.peek();
    this.errors.push({ filename: this.filename, line: t.line, col: t.col, msg });
    if (this.errors.length > 50) throw new TooManyErrors();
  }
  skipNl() { while (this.eat('nl')); }
  // error recovery: skip to next statement separator
  sync() { while (!this.at('nl') && !this.at('eof')) this.next(); }
  expectNl() {
    if (this.softElse > 0 && this.atKw('ELSE')) return;
    if (!this.at('eof') && !this.eat('nl')) {
      this.err(`expected end of statement, got ${this.describe(this.peek())}`);
      this.sync();
    }
  }

  // ---------- program structure ----------

  parseProgram() {
    const prog = { kind: 'Program', opts: [], decls: [], procs: [] };
    this.skipNl();
    while (!this.at('eof')) {
      try {
        const exported = !!this.eat('kw', 'EXPORT');
        if (this.at('#')) prog.decls.push(this.parsePreproc());
        else if (this.atKw('OPT')) prog.opts.push(...this.parseOpt());
        else if (this.atKw('MODULE')) prog.decls.push(this.parseModule());
        else if (this.at('upper', 'LIBRARY')) prog.decls.push(this.parseLibrary());
        else if (this.atKw('DEF')) prog.decls.push(this.parseDef(exported));
        else if (this.atKw('CONST')) prog.decls.push(this.parseConst(exported));
        else if (this.atKw('ENUM')) prog.decls.push(this.parseEnum(exported));
        else if (this.atKw('SET')) prog.decls.push(this.parseSet(exported));
        else if (this.atKw('OBJECT')) prog.decls.push(this.parseObject(exported));
        else if (this.atKw('RAISE')) prog.decls.push(this.parseRaise());
        else if (this.atKw('PROC')) prog.procs.push(this.parseProc(exported));
        else if (this.at('ident') && this.peek(1).type === ':') {
          prog.decls.push(this.parseGlobalLabelData());
        } else if (this.atKw('LONG') || this.atKw('INT') || this.atKw('CHAR') ||
                   this.atKw('INCBIN')) {
          // static data lines following a global label
          const s = this.parseStat();
          if (s) prog.decls.push(s);
        } else if (this.at('upper')) {
          // top-level inline assembly line
          const parts = [];
          while (!this.at('nl') && !this.at('eof')) parts.push(this.next().raw);
          prog.decls.push({ kind: 'Asm', text: parts.join(' ') });
        } else if (this.at('ecall') || this.at('ident')) {
          // E statement lines amid top-level asm (ch_15 identifier sharing)
          const s = this.parseStat();
          if (s) prog.decls.push(s);
        } else {
          this.err(`unexpected ${this.describe(this.peek())} at top level`);
          this.sync();
        }
      } catch (e) {
        if (e instanceof TooManyErrors) return prog;
        throw e;
      }
      this.skipNl();
    }
    return prog;
  }

  // tolerate ECX/CreativE preprocessor lines: consume raw, honor trailing
  // backslash continuation in #define bodies
  parsePreproc() {
    const parts = [];
    for (;;) {
      while (!this.at('nl') && !this.at('eof')) parts.push(this.next().raw);
      if (parts[parts.length - 1] === '\\' && !this.at('eof')) {
        parts.pop();
        this.next(); // continue past the nl
        continue;
      }
      break;
    }
    this.expectNl();
    return { kind: 'Preproc', text: parts.join(' ') };
  }

  parseOpt() {
    this.next();
    const settings = [];
    do {
      const parts = [];
      while (!this.at(',') && !this.at('nl') && !this.at('eof')) parts.push(this.next().raw);
      settings.push(parts.join(''));
    } while (this.eat(','));
    this.expectNl();
    return settings;
  }

  // library mode (ch_17): LIBRARY 'name.library', ver, rev[, ...] IS f1, f2(A0,D0), ...
  parseLibrary() {
    this.next();
    const header = [];
    while (!this.atKw('IS') && !this.at('nl') && !this.at('eof')) header.push(this.next().raw);
    this.expect('kw', 'IS');
    const funcs = [];
    do {
      this.skipNl();
      const name = this.eat('ident') ?? this.eat('ecall');
      if (!name) { this.err('expected exported function name'); break; }
      const regs = [];
      if (this.eat('(')) {
        if (!this.at(')')) {
          do { regs.push(this.next().raw); } while (this.eat(','));
        }
        this.expect(')');
      }
      funcs.push({ name: name.value, regs });
    } while (this.eat(','));
    this.expectNl();
    return { kind: 'Library', header: header.join(' '), funcs };
  }

  parseModule() {
    this.next();
    const names = [];
    do {
      const s = this.expect('str', undefined, 'module name string');
      if (s) names.push(s.value);
    } while (this.eat(','));
    this.expectNl();
    return { kind: 'Module', names };
  }

  parseConst(exported) {
    this.next();
    const items = [];
    do {
      this.skipNl();
      const name = this.expect('upper', undefined, 'constant name');
      this.expect('=');
      const value = this.parseExp();
      if (name) items.push({ name: name.value, value });
    } while (this.eat(','));
    this.expectNl();
    return { kind: 'Const', items, exported };
  }

  parseEnum(exported) {
    this.next();
    const items = [];
    do {
      this.skipNl();
      const name = this.expect('upper', undefined, 'enum name');
      let value = null;
      if (this.eat('=')) value = this.parseExp();
      if (name) items.push({ name: name.value, value });
    } while (this.eat(','));
    this.expectNl();
    return { kind: 'Enum', items, exported };
  }

  parseSet(exported) {
    this.next();
    const names = [];
    do {
      this.skipNl();
      const name = this.expect('upper', undefined, 'set name');
      if (name) names.push(name.value);
    } while (this.eat(','));
    this.expectNl();
    return { kind: 'Set', names, exported };
  }

  parseType() {
    // : LONG | INT | CHAR | REAL | STRING | LIST | ARRAY [OF t] | PTR TO t | objident
    if (this.eat('kw', 'PTR')) {
      this.expect('kw', 'TO');
      return { base: 'PTR', to: this.parseType() };
    }
    if (this.eat('kw', 'ARRAY')) {
      let of = null;
      if (this.eat('kw', 'OF')) of = this.parseType();
      return { base: 'ARRAY', of };
    }
    for (const t of ['LONG', 'INT', 'CHAR', 'STRING', 'LIST']) {
      if (this.eat('kw', t)) return { base: t };
    }
    const id = this.eat('ident') ?? this.eat('upper') ?? this.eat('ecall');
    if (id) return { base: 'OBJECT', name: id.value };
    this.err(`expected type, got ${this.describe(this.peek())}`);
    return { base: 'LONG' };
  }

  parseVarDecl() {
    const name = this.eat('ident') ?? this.eat('ecall') ?? this.eat('upper') ??
      this.expect('ident', undefined, 'variable name');
    const decl = { name: name?.value ?? '?', size: null, type: null, init: null };
    if (this.at('[')) {
      // E-VO multi-dimensional arrays: DEF m[3][3]:ARRAY OF LONG
      decl.dims = [];
      while (this.eat('[')) {
        decl.dims.push(this.parseExp());
        this.expect(']');
      }
      decl.size = decl.dims[0];   // back-compat: single-dim path uses .size
    }
    // '=default' and ':type' occur in either order (corpus: name=NIL:PTR TO LONG)
    for (;;) {
      if (!decl.type && this.eat(':')) decl.type = this.parseType();
      else if (!decl.init && this.eat('=')) decl.init = this.parseChain();
      else break;
    }
    return decl;
  }

  parseDef(exported) {
    this.next();
    const decls = [];
    do {
      this.skipNl();
      decls.push(this.parseVarDecl());
    } while (this.eat(','));
    this.expectNl();
    return { kind: 'Def', decls, exported };
  }

  parseObject(exported) {
    this.next();
    // corpus uses uppercase object names too (OBJECT TR_Message)
    const name = this.eat('ident') ?? this.eat('upper') ?? this.eat('ecall') ??
      this.expect('ident', undefined, 'object name');
    let of = null;
    if (this.eat('kw', 'OF')) {
      of = (this.eat('ident') ?? this.eat('upper') ?? this.eat('ecall') ??
        this.expect('ident', undefined, 'parent object'))?.value ?? null;
    }
    let access = this.eat('kw', 'PRIVATE') ? 'private' : null;
    this.expectNl();
    const members = [];
    let unionCounter = 0;
    this.skipNl();
    while (!this.atKw('ENDOBJECT') && !this.at('eof')) {
      // PRIVATE/PUBLIC may stand alone or prefix members on the same line
      if (this.atKw('PRIVATE') || this.atKw('PUBLIC')) {
        access = this.next().value === 'PRIVATE' ? 'private' : 'public';
        if (this.at('nl')) { this.next(); this.skipNl(); continue; }
      }
      // E-VO UNION: overlapping member groups. Each [..] group lays its members
      // sequentially from the union base; groups overlap; size = max group.
      if (this.atKw('UNION')) {
        this.next();
        const uid = ++unionCounter;
        this.skipNl();
        // optional outer bracket form: UNION [ [..],[..] ]
        let outer = false;
        if (this.at('[') && this.peek(1).type === '[') { this.next(); this.skipNl(); outer = true; }
        else if (this.at('[')) {
          // disambiguate a lone outer '[' from a group '[': look past newlines
          let j = 1; while (this.peek(j).type === 'nl') j++;
          if (this.peek(j).type === '[') { this.next(); this.skipNl(); outer = true; }
        }
        let group = 0;
        while (this.at('[')) {
          this.next();   // group open '['
          this.skipNl();
          while (!this.at(']') && !this.at('eof')) {
            const m = this.parseVarDecl();
            m.access = access; m.unionId = uid; m.unionGroup = group;
            members.push(m);
            if (!this.eat(',')) this.skipNl();
            this.skipNl();
          }
          this.expect(']');
          group++;
          this.eat(',');
          this.skipNl();
        }
        if (outer) { this.expect(']'); this.skipNl(); }
        this.expect('kw', 'ENDUNION');
        this.expectNl();
        this.skipNl();
        continue;
      }
      {
        do {
          this.skipNl();
          if (this.atKw('ENDOBJECT')) break;
          const m = this.parseVarDecl();
          m.access = access;
          members.push(m);
        } while (this.eat(','));
        this.expectNl();
      }
      this.skipNl();
    }
    this.expect('kw', 'ENDOBJECT');
    this.expectNl();
    return { kind: 'Object', name: name?.value ?? '?', of, members, exported };
  }

  parseRaise() {
    this.next();
    const rules = [];
    do {
      this.skipNl();
      // exception id: constant, char const ("MEM") or number
      const id = this.parseItem();
      this.expect('kw', 'IF');
      const call = this.parseChain();
      rules.push({ id, cond: call });
    } while (this.eat(','));
    this.expectNl();
    return { kind: 'Raise', rules };
  }

  parseGlobalLabelData() {
    const name = this.next().value;
    this.next(); // ':'
    // optional inline data on same line is handled as following statements
    return { kind: 'Label', name, global: true };
  }

  parseProc(exported) {
    this.next();
    // module sources define library stubs with builtin-style names (ecall)
    const name = this.eat('ident') ?? this.eat('ecall') ??
      this.expect('ident', undefined, 'procedure name');
    this.expect('(');
    const args = [];
    if (!this.at(')')) {
      do {
        this.skipNl();
        const a = this.parseVarDecl();
        args.push(a);
      } while (this.eat(','));
    }
    this.expect(')');
    let of = null, handle = false;
    if (this.eat('kw', 'OF')) {
      of = (this.eat('ident') ?? this.eat('upper') ?? this.eat('ecall') ??
        this.expect('ident', undefined, 'object name'))?.value ?? null;
    }
    if (this.eat('kw', 'HANDLE')) handle = true;
    const proc = { kind: 'Proc', name: name?.value ?? '?', args, of, handle, exported,
      body: [], except: null, exceptDef: null, returns: [] };
    if (this.eat('kw', 'IS') || this.eat('kw', 'RETURN')) {
      do { proc.returns.push(this.parseExp()); } while (this.eat(','));
      this.expectNl();
      return proc;
    }
    this.expectNl();
    proc.body = this.parseStats(['ENDPROC', 'EXCEPT']);
    if (this.eat('kw', 'EXCEPT')) {
      proc.exceptDo = !!this.eat('kw', 'DO');
      this.expectNl();
      proc.except = this.parseStats(['ENDPROC']);
    }
    this.expect('kw', 'ENDPROC');
    if (!this.at('nl') && !this.at('eof')) {
      do { proc.returns.push(this.parseExp()); } while (this.eat(','));
    }
    this.expectNl();
    return proc;
  }

  // ---------- statements ----------

  parseStats(terminators) {
    const stats = [];
    this.skipNl();
    while (!this.at('eof') && !terminators.some(t => this.atKw(t))) {
      const before = this.k;
      try {
        const s = this.parseStat();
        if (s) stats.push(s);
      } catch (e) {
        if (e instanceof TooManyErrors) throw e;
        throw e;
      }
      if (this.k === before) { this.err(`cannot parse statement at ${this.describe(this.peek())}`); this.sync(); }
      this.skipNl();
    }
    return stats;
  }

  parseStat() {
    const t = this.peek();
    if (t.type === '#') return this.parsePreproc();
    if (t.type === 'kw') {
      switch (t.value) {
        case 'DEF': return this.parseDef(false);
        case 'IF': case 'IFN': return this.parseIf();
        case 'FOR': return this.parseFor();
        case 'WHILE': case 'WHILEN': return this.parseWhile();
        case 'REPEAT': return this.parseRepeat();
        case 'LOOP': return this.parseLoop();
        case 'SELECT': return this.parseSelect();
        case 'RETURN': {
          this.next();
          const exps = [];
          if (!this.at('nl') && !this.at('eof')) {
            do { exps.push(this.parseExp()); } while (this.eat(','));
          }
          this.expectNl();
          return { kind: 'Return', exps };
        }
        case 'JUMP': {
          this.next();
          const label = this.expect('ident', undefined, 'label');
          this.expectNl();
          return { kind: 'Jump', label: label?.value };
        }
        case 'INC': case 'DEC': {
          this.next();
          const lval = this.parseLval();
          this.expectNl();
          return { kind: t.value === 'INC' ? 'Inc' : 'Dec', lval };
        }
        case 'EXIT': case 'EXITN': {
          const neg = t.value === 'EXITN';
          this.next();
          let cond = null;
          if (!this.at('nl')) cond = this.parseExp();
          this.expectNl();
          return { kind: 'Exit', cond, neg };
        }
        case 'CONT': case 'CONTN': {   // E-VO loop continue (CONTN = inverted)
          const neg = t.value === 'CONTN';
          this.next();
          let cond = null;
          if (!this.at('nl')) cond = this.parseExp();
          this.expectNl();
          return { kind: 'Cont', cond, neg };
        }
        case 'VOID': {
          this.next();
          const exp = this.parseExp();
          this.expectNl();
          return { kind: 'Void', exp };
        }
        case 'NEW': {
          // NEW a, b.create(), c[10] — comma-separated allocation targets
          this.next();
          const targets = [];
          do {
            if (this.at('[')) targets.push(this.parseListLit());
            else targets.push(this.parseLval());
          } while (this.eat(','));
          this.expectNl();
          return { kind: 'NewStat', targets };
        }
        case 'END': {
          this.next();
          const targets = [];
          do {
            const lval = this.parseLval();
            targets.push(lval);
          } while (this.eat(','));
          this.expectNl();
          return { kind: 'EndStat', targets };
        }
        case 'INCBIN': {
          this.next();
          const s = this.expect('str', undefined, 'file name');
          this.expectNl();
          return { kind: 'Incbin', file: s?.value };
        }
        case 'LONG': case 'INT': case 'CHAR': {
          this.next();
          const values = [];
          do { values.push(this.parseExp()); } while (this.eat(','));
          this.expectNl();
          return { kind: 'Data', type: t.value, values };
        }
        case 'SUPER': {
          const exp = this.parseExp();
          this.expectNl();
          return { kind: 'ExprStat', exp };
        }
        default:
          this.err(`unexpected keyword ${t.value} in statement position`);
          this.sync();
          return null;
      }
    }
    if (t.type === 'upper') {
      // inline assembly mnemonic (or constant misuse): consume the line raw
      const parts = [];
      while (!this.at('nl') && !this.at('eof')) parts.push(this.next().raw);
      this.expectNl();
      return { kind: 'Asm', text: parts.join(' ') };
    }
    if (t.type === 'ident' && this.peek(1).type === ':' ) {
      const name = this.next().value;
      this.next();
      return { kind: 'Label', name };
    }
    if (t.type === 'ident' && this.peek(1).type === ',') {
      // multi-assign: a,b,c := exp
      const save = this.k;
      const targets = [this.next().value];
      let ok = true;
      while (this.eat(',')) {
        const id = this.eat('ident');
        if (!id) { ok = false; break; }
        targets.push(id.value);
      }
      if (ok && this.eat(':=')) {
        const exp = this.parseExp();
        this.expectNl();
        return { kind: 'MultiAssign', targets, exp };
      }
      this.k = save; // not a multi-assign — reparse as expression
    }
    // assignment or expression statement
    const exp = this.parseExp();
    // E-VO swap: a :=: b  (lexed as ':=' then an adjacent ':')
    {
      const t0 = this.peek(), t1 = this.peek(1);
      if (t0.type === ':=' && t1.type === ':' && t1.line === t0.line && t1.col === t0.col + 2) {
        this.next(); this.next();
        const rhs = this.parseExp();
        this.expectNl();
        return { kind: 'Swap', a: exp, b: rhs };
      }
    }
    if (this.eat(':=')) {
      const rhs = this.parseExp();
      this.expectNl();
      return { kind: 'Assign', target: exp, exp: rhs };
    }
    // E-VO compound assignment: desugar 'lval OP= rhs' to 'lval := lval OP rhs'.
    const ca = this.peekCompoundAssign();
    if (ca) {
      this.next(); this.next();   // consume the two operator tokens
      const rhs = this.parseExp();
      this.expectNl();
      return { kind: 'Assign', target: exp, exp: { kind: 'Bin', op: ca.op, l: exp, r: rhs } };
    }
    this.expectNl();
    if (exp.kind === 'AssignExp') return { kind: 'Assign', target: exp.target, exp: exp.exp };
    return { kind: 'ExprStat', exp };
  }

  parseIf() {
    const neg = this.peek().value === 'IFN';   // E-VO inverted IF
    this.next();
    const cond = this.parseExp();
    if (this.eat('kw', 'THEN')) {
      // `IF cond THEN` at end of line continues: its statement is on the
      // next line (corpus-verified: MWeg, StackMon — no ENDIF follows)
      this.skipNl();
      this.softElse++;
      const then = this.parseStat();
      this.softElse--;
      // same-line ELSE only — a next-line ELSE/ELSEIF always belongs to an
      // enclosing multi-line IF (corpus-verified: shell90 put90)
      if (this.atKw('ELSE') && this.toks[this.k - 1].type !== 'nl') {
        this.next();
        this.softElse++;
        const els = [this.parseStat()].filter(Boolean);
        this.softElse--;
        return { kind: 'If', cond, neg, then: [then].filter(Boolean), elifs: [], else: els, oneLine: true };
      }
      return { kind: 'If', cond, neg, then: [then].filter(Boolean), elifs: [], else: null, oneLine: true };
    }
    this.expectNl();
    const then = this.parseStats(['ELSEIF', 'ELSEIFN', 'ELSE', 'ENDIF']);
    return this.parseIfTail(cond, then, neg);
  }

  parseIfTail(cond, then, neg) {
    const elifs = [];
    while (this.atKw('ELSEIF') || this.atKw('ELSEIFN')) {
      const en = this.peek().value === 'ELSEIFN';   // E-VO inverted ELSEIF
      this.next();
      const c = this.parseExp();
      this.expectNl();
      elifs.push({ cond: c, neg: en, body: this.parseStats(['ELSEIF', 'ELSEIFN', 'ELSE', 'ENDIF']) });
    }
    let els = null;
    if (this.eat('kw', 'ELSE')) {
      this.expectNl();
      els = this.parseStats(['ENDIF']);
    }
    this.expect('kw', 'ENDIF');
    this.expectNl();
    return { kind: 'If', cond, neg, then, elifs, else: els };
  }

  parseFor() {
    this.next();
    const v = this.expect('ident', undefined, 'loop variable');
    this.expect(':=');
    const from = this.parseExp();
    this.expect('kw', 'TO');
    const to = this.parseExp();
    let step = null;
    if (this.eat('kw', 'STEP')) step = this.parseExp();
    if (this.eat('kw', 'DO')) {
      const body = this.parseStat();
      return { kind: 'For', var: v?.value, from, to, step, body: [body].filter(Boolean), oneLine: true };
    }
    this.expectNl();
    const body = this.parseStats(['ENDFOR']);
    this.expect('kw', 'ENDFOR');
    this.expectNl();
    return { kind: 'For', var: v?.value, from, to, step, body };
  }

  parseWhile() {
    const neg = this.peek().value === 'WHILEN';   // E-VO inverted WHILE
    this.next();
    const cond = this.parseExp();
    if (this.eat('kw', 'DO')) {
      const body = this.parseStat();
      return { kind: 'While', branches: [{ cond, neg, body: [body].filter(Boolean) }], always: null, oneLine: true };
    }
    this.expectNl();
    // E-VO: WHILE may carry ELSEWHILE[N] alternate conditions and an ALWAYS part.
    const term = ['ELSEWHILE', 'ELSEWHILEN', 'ALWAYS', 'ENDWHILE'];
    const branches = [{ cond, neg, body: this.parseStats(term) }];
    while (this.atKw('ELSEWHILE') || this.atKw('ELSEWHILEN')) {
      const en = this.peek().value === 'ELSEWHILEN';
      this.next();
      const c = this.parseExp();
      this.expectNl();
      branches.push({ cond: c, neg: en, body: this.parseStats(term) });
    }
    let always = null;
    if (this.eat('kw', 'ALWAYS')) {
      this.expectNl();
      always = this.parseStats(['ENDWHILE']);
    }
    this.expect('kw', 'ENDWHILE');
    this.expectNl();
    return { kind: 'While', branches, always };
  }

  parseRepeat() {
    this.next();
    this.expectNl();
    const body = this.parseStats(['UNTIL', 'UNTILN']);
    const neg = this.atKw('UNTILN');   // E-VO inverted UNTIL
    if (neg) this.next(); else this.expect('kw', 'UNTIL');
    const cond = this.parseExp();
    this.expectNl();
    return { kind: 'Repeat', body, cond, neg };
  }

  parseLoop() {
    this.next();
    this.expectNl();
    const body = this.parseStats(['ENDLOOP']);
    this.expect('kw', 'ENDLOOP');
    this.expectNl();
    return { kind: 'Loop', body };
  }

  parseSelect() {
    this.next();
    const subject = this.parseExp();
    let of = null;
    if (this.eat('kw', 'OF')) of = this.parseExp();
    this.expectNl();
    this.skipNl();
    // corpus files put stray statements between SELECT and the first CASE
    const preStats = this.atKw('CASE') || this.atKw('DEFAULT') || this.atKw('ENDSELECT')
      ? [] : this.parseStats(['CASE', 'DEFAULT', 'ENDSELECT']);
    const cases = [];
    let def = null;
    while (this.eat('kw', 'CASE')) {
      const matches = [];
      do {
        const e = this.parseExp();
        if (this.eat('kw', 'TO')) matches.push({ from: e, to: this.parseExp() });
        else matches.push({ exp: e });
      } while (this.eat(','));
      this.expectNl();
      cases.push({ matches, body: this.parseStats(['CASE', 'DEFAULT', 'ENDSELECT']) });
    }
    if (this.eat('kw', 'DEFAULT')) {
      this.expectNl();
      def = this.parseStats(['ENDSELECT']);
    }
    this.expect('kw', 'ENDSELECT');
    this.expectNl();
    return { kind: 'Select', subject, of, preStats, cases, default: def };
  }

  // ---------- expressions ----------

  parseExp() {
    let exp = this.parseChain();
    while (this.eat('kw', 'BUT')) {
      const rhs = this.parseChain();
      exp = { kind: 'But', first: exp, value: rhs };
    }
    // E-VO C-style ternary: cond ? then : else
    if (this.eat('?')) {
      const then = this.parseChain();
      this.expect(':');
      const els = this.parseChain();
      exp = { kind: 'Ternary', cond: exp, then, else: els };
    }
    return exp;
  }

  parseChain() {
    let neg = false;
    if (this.at('-')) { this.next(); neg = true; }
    let left = this.parseItem();
    if (neg) left = { kind: 'Neg', exp: left };
    for (;;) {
      const t = this.peek();
      // E-VO compound assignment (x += 5, a AND= 1, x <<= 3): stop the chain so
      // the statement parser sees 'lval OP= rhs' instead of consuming OP here.
      if (this.peekCompoundAssign()) break;
      let op = null, shiftPair = false;
      // E-VO / modern E: an adjacent '<<' / '>>' is a symbol alias for SHL/SHR.
      // Lexed as two '<' / '>' tokens so nested lisp cells still close with
      // '>>'; only pair them outside a cell (cellDepth 0).
      const t2 = this.peek(1);
      // E-VO quick-compare: exp == [v, lo TO hi, ...]  (== lexed as two '=').
      if (t.type === '=' && t2.type === '=' && t2.line === t.line && t2.col === t.col + 1) {
        this.next(); this.next();
        this.expect('[');
        const items = [];
        do {
          const e = this.parseExp();
          if (this.eat('kw', 'TO')) items.push({ from: e, to: this.parseExp() });
          else items.push({ val: e });
        } while (this.eat(','));
        this.expect(']');
        left = { kind: 'QuickCompare', exp: left, items };
        continue;
      }
      if ((t.type === '<' || t.type === '>') && this.cellDepth === 0 &&
        t2.type === t.type && t2.line === t.line && t2.col === t.col + 1) {
        op = t.type === '<' ? 'SHL' : 'SHR';
        shiftPair = true;
      }
      else if (t.type === '&') op = 'AND';   // E-VO: & is bitwise AND
      else if (t.type === '|' && t2.type === '|' && this.cellDepth === 0 &&
        t2.line === t.line && t2.col === t.col + 1) { op = 'OR'; shiftPair = true; }   // E-VO: || is bitwise OR
      else if (BINOPS.has(t.type)) op = t.type;
      else if (t.type === 'kw' && KWBINOPS.has(t.value)) op = t.value;
      else if (t.type === 'upper' && ['SHL', 'SHR', 'XOR'].includes(t.value)) op = t.value;
      // E-VO short-circuit boolean operators.
      else if (t.type === 'upper' && (t.value === 'ANDALSO' || t.value === 'ORELSE')) op = t.value;
      if (!op) break;
      if (op === '>' && this.cellDepth > 0) break;
      if (op === '|' && this.cellDepth > 0) break;
      this.next();
      if (shiftPair) this.next();   // consume the second '<' / '>' of the pair
      // '!' may be a postfix float-conversion with no right operand
      if (op === '!' && !this.atItemStart()) {
        left = { kind: 'FloatConv', exp: left };
        continue;
      }
      const right = this.parseItem();
      // ANDALSO/ORELSE short-circuit — distinct node so codegen branches
      // instead of eagerly evaluating both operands.
      if (op === 'ANDALSO' || op === 'ORELSE') left = { kind: 'Logical', op, l: left, r: right };
      else left = { kind: 'Bin', op, l: left, r: right };
    }
    return left;
  }

  // E-VO compound-assignment operator at the current position, or null.
  // Returns the equivalent binary op and how many tokens it spans. Lexed as
  // separate tokens, so we require them to be physically adjacent:
  //   +=  -=  *=  /=   ->  the simple op then '='
  //   AND= OR=          ->  the keyword then '='
  //   <<= >>=           ->  '<' then '<=' (resp. '>' then '>=')  (lexer munch)
  peekCompoundAssign() {
    const t = this.peek(), t2 = this.peek(1);
    const adj = t2.line === t.line && t.col + (t.raw ? t.raw.length : 1) === t2.col;
    if (!adj) return null;
    if (t2.type === '=') {
      if (t.type === '+' || t.type === '-' || t.type === '*' || t.type === '/') return { op: t.type, n: 2 };
      if (t.type === 'kw' && (t.value === 'AND' || t.value === 'OR')) return { op: t.value, n: 2 };
    }
    if (t.type === '<' && t2.type === '<=') return { op: 'SHL', n: 2 };
    if (t.type === '>' && t2.type === '>=') return { op: 'SHR', n: 2 };
    return null;
  }

  atItemStart() {
    const t = this.peek();
    return ['int', 'float', 'str', 'char', 'ident', 'ecall', 'upper',
      '(', '[', '{', '`', '^', '-', '~', '<'].includes(t.type) ||
      (t.type === 'kw' && ['IF', 'SIZEOF', 'NEW', 'NIL', 'SUPER'].includes(t.value));
  }

  parseItem() {
    const t = this.peek();
    // E-VO / modern E: unary bitwise complement — 'NOT x' or '~x'.
    if (t.type === 'upper' && t.value === 'NOT') {
      this.next();
      return { kind: 'Not', exp: this.parseItem() };
    }
    switch (t.type) {
      case 'int': case 'float': this.next(); return { kind: t.type === 'int' ? 'Num' : 'Float', value: t.value };
      case 'str': this.next(); return { kind: 'Str', value: t.value };
      case 'char': this.next(); return { kind: 'Char', value: t.value };
      case '-': this.next(); return { kind: 'Neg', exp: this.parseItem() };
      case '!': this.next(); return { kind: 'FloatPrefix', exp: this.parseItem() };
      case '~': this.next(); return { kind: 'Not', exp: this.parseItem() };
      case '(': {
        this.next();
        this.skipNl();
        let exp = this.parseExp();
        if (this.eat(':=')) {
          const rhs = this.parseExp();
          exp = { kind: 'AssignExp', target: exp, exp: rhs };
        }
        this.expect(')');
        // parens form a fresh expression (own float-mode state, ch_12B)
        return this.parsePostfix({ kind: 'Paren', exp });
      }
      case '[': return this.parsePostfix(this.parseListLit());
      case '<': {
        // LISP cell: <a|b>, <a> (NIL tail), or list form <1,2,3> (corpus)
        this.next();
        this.cellDepth++;
        const items = [this.parseExp()];
        while (this.eat(',')) items.push(this.parseExp());
        let tail = null;
        if (this.eat('|')) tail = this.parseExp();
        this.expect('>');
        this.cellDepth--;
        return { kind: 'Cell', items, tail };
      }
      case '{': {
        this.next();
        const id = this.expect('ident', undefined, 'identifier');
        this.expect('}');
        return { kind: 'AddrOf', name: id?.value };
      }
      case '`': {
        this.next();
        const exp = this.parseExp();
        return { kind: 'Quote', exp };
      }
      case '^': {
        this.next();
        const lval = this.parseLval();
        return { kind: 'Deref', lval };
      }
      case 'ident': case 'ecall': case 'upper': {
        const ref = this.parseRef();
        // grammar item: var ":=" exp — assignment expression without parens.
        // But a ':=' immediately followed by ':' is the E-VO swap operator
        // (a :=: b); leave it for the statement parser.
        const nx = this.peek(1);
        const isSwap = nx.type === ':' && nx.line === this.peek().line && nx.col === this.peek().col + 2;
        if (this.at(':=') && !isSwap) {
          this.next();
          return { kind: 'AssignExp', target: ref, exp: this.parseChain() };
        }
        return ref;
      }
      case 'kw':
        switch (t.value) {
          case 'IF': {
            // ternary; THEN/ELSE may sit at end of line inside parens
            this.next();
            const cond = this.parseExp();
            this.expect('kw', 'THEN');
            this.skipNl();
            const then = this.parseExp();
            this.skipNl();
            this.expect('kw', 'ELSE');
            this.skipNl();
            const els = this.parseExp();
            return { kind: 'Ternary', cond, then, else: els };
          }
          case 'SIZEOF': {
            this.next();
            const tt = this.peek();
            if (tt.type === 'kw' && ['LONG', 'INT', 'CHAR', 'PTR'].includes(tt.value)) {
              this.next();
              return { kind: 'Sizeof', name: tt.value };
            }
            const id = this.eat('ident') ?? this.eat('ecall') ??
              this.expect('ident', undefined, 'object name');
            return { kind: 'Sizeof', name: id?.value };
          }
          case 'PSIZEOF': {   // E-VO: like SIZEOF but pointer types -> 4
            this.next();
            const tt = this.peek();
            if (tt.type === 'kw' && ['LONG', 'INT', 'CHAR', 'PTR'].includes(tt.value)) {
              this.next();
              return { kind: 'Psizeof', name: tt.value };
            }
            const id = this.eat('ident') ?? this.eat('ecall') ??
              this.expect('ident', undefined, 'object name');
            return { kind: 'Psizeof', name: id?.value };
          }
          case 'OFFSETOF': {   // E-VO: OFFSETOF objtype.member
            this.next();
            const ot = this.eat('ident') ?? this.eat('upper') ?? this.eat('ecall') ??
              this.expect('ident', undefined, 'object type');
            this.expect('.');
            const m = this.eat('ident') ?? this.eat('upper') ?? this.eat('ecall') ??
              this.expect('ident', undefined, 'member');
            return { kind: 'Offsetof', objType: ot?.value, member: m?.value };
          }
          case 'ARRAYSIZE': {   // E-VO: ARRAYSIZE [dim,] arrayvar
            this.next();
            const e1 = this.parseChain();
            if (this.eat(',')) {
              const id = this.eat('ident') ?? this.eat('ecall') ?? this.eat('upper') ??
                this.expect('ident', undefined, 'array variable');
              return { kind: 'Arraysize', dim: e1, name: id?.value };
            }
            return { kind: 'Arraysize', dim: { kind: 'Num', value: 1 }, name: e1?.name };
          }
          case 'NEW': {
            this.next();
            if (this.at('[')) {
              const list = this.parseListLit();
              return { kind: 'NewList', list };
            }
            const lval = this.parseLval();
            return { kind: 'New', lval };
          }
          case 'NIL': this.next(); return { kind: 'Nil' };
          case 'SUPER': {
            this.next();
            const call = this.parseLval();
            return { kind: 'Super', call };
          }
          case 'STRING': case 'LIST': case 'LONG': case 'INT': case 'CHAR': case 'ARRAY':
            // type keyword in expression context (e.g. list type suffix misparse)
            this.next();
            return { kind: 'TypeRef', name: t.value };
          default:
            this.err(`unexpected keyword '${t.value}' in expression`);
            this.next();
            return { kind: 'Error' };
        }
      default:
        this.err(`unexpected ${this.describe(t)} in expression`);
        this.next();
        return { kind: 'Error' };
    }
  }

  parseListLit() {
    // newlines are insignificant inside [ ] — corpus splits lines before
    // commas and after opening brackets alike
    this.expect('[');
    this.skipNl();
    const items = [];
    if (!this.at(']')) {
      do {
        this.skipNl();
        if (this.at(']')) break;
        items.push(this.parseExp());
        this.skipNl();
      } while (this.eat(','));
    }
    this.skipNl();
    this.expect(']');
    let type = null;
    if (this.eat(':')) type = this.parseType();
    return { kind: 'List', items, type };
  }

  parseRef() {
    const t = this.next();
    let node = { kind: 'Var', name: t.value, refType: t.type };
    return this.parsePostfix(node);
  }

  // postfix: calls, member access, indexing, casts, ++/--
  parsePostfix(node) {
    for (;;) {
      if (this.at('(')) {
        this.next();
        this.skipNl();
        const args = [];
        if (!this.at(')')) {
          do {
            this.skipNl();
            args.push(this.parseExp());
            this.skipNl();
          } while (this.eat(','));
        }
        this.expect(')');
        node = { kind: 'Call', callee: node, args };
      } else if (this.at('[')) {
        this.next();
        let idx = null;
        if (!this.at(']')) idx = this.parseExp();
        this.expect(']');
        node = { kind: 'Index', obj: node, idx };
      } else if (this.at('.')) {
        this.next();
        const id = this.eat('ident') ?? this.eat('ecall') ?? this.eat('upper');
        if (!id) { this.err('expected member name after .'); break; }
        node = { kind: 'Member', obj: node, name: id.value };
      } else if (this.at('::')) {
        this.next();
        node = { kind: 'Cast', obj: node, type: this.parseType() };
      } else if (this.at('++')) {
        this.next();
        node = { kind: 'PostInc', obj: node };
      } else if (this.at('--')) {
        this.next();
        node = { kind: 'PostDec', obj: node };
      } else break;
    }
    return node;
  }

  parseLval() {
    const t = this.peek();
    if (t.type === '^') {
      this.next();
      return { kind: 'Deref', lval: this.parseLval() };
    }
    if (t.type === 'ident' || t.type === 'ecall' || t.type === 'upper') return this.parseRef();
    this.err(`expected lvalue, got ${this.describe(t)}`);
    this.next();
    return { kind: 'Error' };
  }
}

class TooManyErrors extends Error {}

export function parse(src, filename = '<input>') {
  const { tokens, errors: lexErrors } = lex(src, filename);
  const p = new Parser(tokens, filename);
  let program = null;
  try {
    program = p.parseProgram();
  } catch (e) {
    if (!(e instanceof TooManyErrors)) throw e;
  }
  return { program, errors: [...lexErrors, ...p.errors] };
}
