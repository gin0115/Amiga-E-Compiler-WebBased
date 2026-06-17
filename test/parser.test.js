import { test } from './harness.js';
import { parse } from '../src/parser.js';

function ok(src) {
  const { program, errors } = parse(src);
  if (errors.length) throw new Error('parse errors: ' + JSON.stringify(errors, null, 1));
  return program;
}
function bad(src) {
  const { errors } = parse(src);
  if (!errors.length) throw new Error('expected parse errors, got none');
  return errors;
}

test('hello world', a => {
  const p = ok("PROC main()\n  WriteF('Hello!\\n')\nENDPROC\n");
  a.equal(p.procs.length, 1);
  a.equal(p.procs[0].name, 'main');
  a.equal(p.procs[0].body[0].kind, 'ExprStat');
  a.equal(p.procs[0].body[0].exp.kind, 'Call');
});

test('left-to-right chain, no precedence', a => {
  const p = ok('PROC main()\n  DEF x\n  x:=1+2*3\nENDPROC');
  const e = p.procs[0].body[1].exp;
  a.equal(e.kind, 'Bin');
  a.equal(e.op, '*');
  a.equal(e.l.op, '+');
  a.equal(e.r.value, 3);
});

test('module + const + enum + set', a => {
  const p = ok("MODULE 'intuition/intuition', 'dos/dos'\nCONST MAX=10, MIN=1\nENUM A,B,C=10,D\nSET FLAG1,FLAG2\nPROC main() IS EMPTY\n");
  a.equal(p.decls[0].names.length, 2);
  a.equal(p.decls[1].items[1].name, 'MIN');
  a.equal(p.decls[2].items[3].name, 'D');
  a.equal(p.decls[3].names.length, 2);
});

test('DEF declarations all forms', a => {
  const p = ok('DEF a, b=5, p:PTR TO obj, s[80]:STRING, l[10]:LIST, ar[4]:ARRAY OF INT, o:obj\nPROC main() IS 0\n');
  const d = p.decls[0].decls;
  a.equal(d.length, 7);
  a.equal(d[1].init.value, 5);
  a.equal(d[2].type.base, 'PTR');
  a.equal(d[2].type.to.base, 'OBJECT');
  a.equal(d[3].type.base, 'STRING');
  a.equal(d[5].type.of.base, 'INT');
});

test('OBJECT with inheritance and access', a => {
  const p = ok('OBJECT point\n  x:INT, y:INT\nENDOBJECT\nOBJECT circle OF point\nPRIVATE\n  r:INT\nENDOBJECT\nPROC main() IS 0\n');
  a.equal(p.decls[0].members.length, 2);
  a.equal(p.decls[1].of, 'point');
  a.equal(p.decls[1].members[0].access, 'private');
});

test('PROC args, defaults, OF object, HANDLE, multi-return', a => {
  const p = ok('PROC f(x, y=1, p:PTR TO LONG) HANDLE\n  x:=y\nEXCEPT\n  x:=0\nENDPROC x, y\nPROC g() OF point IS self.x\nPROC main() IS 0\n');
  const f = p.procs[0];
  a.equal(f.args.length, 3);
  a.equal(f.args[1].init.value, 1);
  a.ok(f.handle);
  a.equal(f.except.length, 1);
  a.equal(f.returns.length, 2);
  a.equal(p.procs[1].of, 'point');
});

test('IF one-line with ELSE', a => {
  const p = ok('PROC main()\n  DEF a\n  IF a THEN a:=1 ELSE a:=2\nENDPROC');
  const s = p.procs[0].body[1];
  a.equal(s.kind, 'If');
  a.ok(s.oneLine);
  a.equal(s.then[0].kind, 'Assign');
  a.equal(s.else[0].exp.value, 2);
});

test('IF multi-line with ELSEIF chain', a => {
  const p = ok('PROC main()\n  DEF a\n  IF a=1\n    a:=2\n  ELSEIF a=2\n    a:=3\n  ELSE\n    a:=4\n  ENDIF\nENDPROC');
  const s = p.procs[0].body[1];
  a.equal(s.elifs.length, 1);
  a.equal(s.else.length, 1);
});

test('FOR with STEP and EXIT, one-line DO', a => {
  ok('PROC main()\n  DEF i, t\n  FOR i:=1 TO 10 STEP 2\n    EXIT i>5\n    t:=t+i\n  ENDFOR\n  FOR i:=10 TO 1 STEP -1 DO t:=t+1\nENDPROC');
});

test('WHILE / REPEAT / LOOP', a => {
  ok('PROC main()\n  DEF a\n  WHILE a<10\n    INC a\n  ENDWHILE\n  REPEAT\n    DEC a\n  UNTIL a=0\n  LOOP\n    EXIT a>100\n    INC a\n  ENDLOOP\nENDPROC');
});

test('SELECT plain and ranged OF form', a => {
  const p = ok('PROC main()\n  DEF c\n  SELECT c\n    CASE 10\n      c:=1\n    CASE 9\n      c:=2\n    DEFAULT\n      c:=3\n  ENDSELECT\n  SELECT 128 OF c\n    CASE "0" TO "9", "_"\n      c:=1\n  ENDSELECT\nENDPROC');
  const s2 = p.procs[0].body[2];
  a.equal(s2.of.kind, 'Var');
  a.equal(s2.cases[0].matches.length, 2);
  a.ok(s2.cases[0].matches[0].from);
});

test('multi-assign and assignment expression', a => {
  const p = ok('PROC main()\n  DEF a,b,mem\n  a,b:=f()\n  IF (mem:=New(100))=NIL THEN Raise(0)\nENDPROC');
  a.equal(p.procs[0].body[1].kind, 'MultiAssign');
});

test('typed lists, nested lists, lisp cells', a => {
  const p = ok("PROC main()\n  DEF l, c\n  l:=[1, 'two', [3, 4], 5.0]:LONG\n  c:=<1|<2|NIL>>\nENDPROC");
  const lst = p.procs[0].body[1].exp;
  a.equal(lst.kind, 'List');
  a.equal(lst.items.length, 4);
  a.equal(lst.items[2].kind, 'List');
  const cell = p.procs[0].body[2].exp;
  a.equal(cell.kind, 'Cell');
  a.equal(cell.tail.kind, 'Cell');
});

test('E-VO unary NOT and ~ (bitwise complement)', a => {
  const p = ok('PROC main()\n  DEF x\n  x:=NOT $00\n  x:=~x\n  IF NOT x THEN x:=1\nENDPROC');
  const b = p.procs[0].body;   // b[0] is the DEF
  a.equal(b[1].exp.kind, 'Not');   // NOT $00
  a.equal(b[2].exp.kind, 'Not');   // ~x
});

test('NEW expression and statement forms', a => {
  ok('PROC main()\n  DEF p:PTR TO obj, q\n  NEW p\n  NEW p[10]\n  NEW p.create(), q\n  q:=NEW [1,2,3]:obj\n  END p\n  END p[10], q\nENDPROC');
});

test('quoted expressions and Eval', a => {
  const p = ok('PROC main()\n  DEF func, x\n  func:=`x*x\n  WriteF(\'\\d\\n\', Eval(func))\nENDPROC');
  a.equal(p.procs[0].body[1].exp.kind, 'Quote');
});

test('unification, cast, float ops, BUT, deref, addr-of', a => {
  ok('PROC main()\n  DEF a, x, p:PTR TO LONG\n  a <=> [1, x]\n  p:=a::lif\n  x:=1.0 ! + 2.0\n  myfunc((x:=2) BUT x*x)\n  ^p:=5\n  x:={a}\nENDPROC');
});

test('exception handling: HANDLE/EXCEPT DO and Raise', a => {
  const p = ok("RAISE NOMEM IF New()=NIL, ER_FILE IF Open()=NIL\nPROC main() HANDLE\n  Raise(NOMEM)\nEXCEPT DO\n  WriteF('cleanup\\n')\nENDPROC");
  a.equal(p.decls[0].rules.length, 2);
  a.ok(p.procs[0].exceptDo);
});

test('labels, JUMP, static data, INCBIN', a => {
  const p = ok("PROC main()\n  DEF a\n  IF a THEN JUMP stop\nstop:\n  a:=0\nENDPROC\nmydata:\nLONG 1, 2, 3\nCHAR 65, 0\n");
  const stats = p.procs[0].body;
  a.ok(stats.some(s => s.kind === 'Label'));
  a.ok(p.decls.some(d => d.kind === 'Data'));
});

test('inline assembly lines pass through', a => {
  const p = ok('PROC main()\n  DEF a\n  MOVEQ #1,D0\n  MOVE.L D0,a\nENDPROC');
  a.equal(p.procs[0].body[1].kind, 'Asm');
});

test('one-line PROC with IS', a => {
  const p = ok('PROC add(a, b) IS a+b\nPROC main() IS add(1, 2)\n');
  a.equal(p.procs[0].returns[0].kind, 'Bin');
});

test('line continuation after comma and operators', a => {
  ok("PROC main()\n  DEF t\n  t:=very(1,\n    2,\n    3)\n  t:=1 +\n    2\nENDPROC");
});

test('OPT settings', a => {
  const p = ok('OPT OSVERSION=37\nOPT MODULE\nPROC main() IS 0\n');
  a.equal(p.opts.length, 2);
});

test('method calls and member chains', a => {
  ok('PROC main()\n  DEF o:PTR TO obj\n  o.x:=o.y[3].z\n  o.draw(1, 2)\n  SUPER self.draw()\nENDPROC');
});

test('parse errors are reported with recovery', a => {
  const errs = bad('PROC main()\n  DEF a\n  a:=)broken\n  a:=2\nENDPROC');
  a.ok(errs.length >= 1);
});
