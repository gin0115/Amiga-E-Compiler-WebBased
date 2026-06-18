import { test } from './harness.js';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sem.js';

function sem(src) {
  const { program, errors } = parse(src);
  if (errors.length) throw new Error('parse errors: ' + JSON.stringify(errors));
  return analyze(program);
}

// evo-mode analyze (parse + sem both with {evo:true})
function semE(src) {
  const { program, errors } = parse(src, '<input>', { evo: true });
  if (errors.length) throw new Error('parse errors: ' + JSON.stringify(errors));
  return analyze(program, { evo: true });
}
const byteWordErr = e => /BYTE\/WORD/.test(e.msg);

test('clean hello world has no errors', a => {
  const s = sem("PROC main()\n  WriteF('hi\\n')\nENDPROC");
  a.deepEqual(s.errors, []);
});

test('missing main detected', a => {
  const s = sem('PROC notmain() IS 0\n');
  a.ok(s.errors.some(e => /no PROC main/.test(e.msg)));
});

test('OPT MODULE needs no main', a => {
  const s = sem('OPT MODULE\nEXPORT PROC helper() IS 1\n');
  a.deepEqual(s.errors, []);
});

test('undefined variable caught', a => {
  const s = sem('PROC main()\n  x:=1\nENDPROC');
  a.ok(s.errors.some(e => /undefined variable 'x'/.test(e.msg)));
});

test('DEF and args define scope', a => {
  const s = sem('PROC f(a, b)\n  DEF c\n  c:=a+b\nENDPROC f(1,2)\nPROC main()\n  f(1, 2)\nENDPROC');
  a.deepEqual(s.errors, []);
});

test('globals visible in procs', a => {
  const s = sem('DEF g\nPROC main()\n  g:=10\nENDPROC');
  a.deepEqual(s.errors, []);
});

test('CONST folding: values and expressions', a => {
  const s = sem('CONST A=10, B=A*2, C=B+1\nPROC main() IS C');
  a.equal(s.consts.get('A'), 10);
  a.equal(s.consts.get('B'), 20);
  a.equal(s.consts.get('C'), 21);
});

test('ENUM numbering with explicit restart', a => {
  const s = sem('ENUM X, Y, Z=10, W\nPROC main() IS 0');
  a.equal(s.consts.get('X'), 0);
  a.equal(s.consts.get('Y'), 1);
  a.equal(s.consts.get('Z'), 10);
  a.equal(s.consts.get('W'), 11);
});

test('SET gives bit flags', a => {
  const s = sem('SET F1, F2, F3\nPROC main() IS 0');
  a.equal(s.consts.get('F1'), 1);
  a.equal(s.consts.get('F2'), 2);
  a.equal(s.consts.get('F3'), 4);
});

test('object layout: offsets, alignment, inheritance', a => {
  const s = sem('OBJECT point\n  x:INT, y:INT\nENDOBJECT\nOBJECT pixel OF point\n  c:CHAR\n  v:LONG\nENDOBJECT\nPROC main() IS 0');
  const point = s.objects.get('point');
  a.equal(point.size, 4);
  a.equal(point.members.get('x').offset, 0);
  a.equal(point.members.get('y').offset, 2);
  const pixel = s.objects.get('pixel');
  a.equal(pixel.members.get('c').offset, 4);
  a.equal(pixel.members.get('v').offset, 6);
  a.equal(pixel.size, 10);
});

test('SIZEOF folds via object table', a => {
  const s = sem('OBJECT v\n  a:LONG, b:LONG\nENDOBJECT\nCONST S=SIZEOF v\nPROC main() IS S');
  a.equal(s.consts.get('S'), 8);
});

test('builtin constants known', a => {
  const s = sem('PROC main()\n  DEF x\n  x:=TRUE\n  x:=NIL\n  x:=NEWFILE\nENDPROC');
  a.deepEqual(s.errors, []);
});

test('call to undefined proc caught, builtins fine', a => {
  const s = sem('PROC main()\n  nosuchproc()\n  WriteF(\'ok\')\nENDPROC');
  a.ok(s.errors.some(e => /undefined 'nosuchproc'/.test(e.msg)));
});

test('self is defined in methods', a => {
  const s = sem('OBJECT o\n  x:LONG\nENDOBJECT\nPROC get() OF o IS self.x\nPROC main() IS 0');
  a.deepEqual(s.errors, []);
});

// ---- E-VO BYTE/WORD type rules (match real EC v3.3a + real E-VO) ----
// Verified against both oracles:
//   DEF b:BYTE (scalar)  -> EC REJECTS ("unknown keyword"), E-VO REJECTS ("illegal type")
//   ARRAY OF BYTE        -> E-VO ok ; EC has no BYTE at all
//   PTR TO BYTE          -> E-VO ok
//   object member :BYTE  -> E-VO ok

test('E-VO: scalar DEF b:BYTE is rejected (array-element/ptr/member only)', a => {
  const s = semE('PROC main()\n  DEF b:BYTE\n  b:=65\nENDPROC');
  a.ok(s.errors.some(byteWordErr), 'expected a BYTE/WORD error, got ' + JSON.stringify(s.errors));
});

test('E-VO: scalar DEF w:WORD is rejected', a => {
  const s = semE('PROC main()\n  DEF w:WORD\n  w:=5000\nENDPROC');
  a.ok(s.errors.some(byteWordErr));
});

test('E-VO: ARRAY OF BYTE / WORD is allowed (no BYTE/WORD error)', a => {
  const s = semE('PROC main()\n  DEF a[4]:ARRAY OF BYTE, w[4]:ARRAY OF WORD\n  a[0]:=1\n  w[0]:=2\nENDPROC');
  a.ok(!s.errors.some(byteWordErr), 'array-of-byte must be allowed: ' + JSON.stringify(s.errors));
});

test('E-VO: PTR TO BYTE is allowed', a => {
  const s = semE('PROC main()\n  DEF p:PTR TO BYTE, a[4]:ARRAY OF BYTE\n  p:=a\n  p[0]:=65\nENDPROC');
  a.ok(!s.errors.some(byteWordErr), JSON.stringify(s.errors));
});

test('E-VO: BYTE object member is allowed', a => {
  const s = semE('OBJECT thing\n  b:BYTE\nENDOBJECT\nPROC main()\n  DEF t:thing\n  t.b:=65\nENDPROC');
  a.ok(!s.errors.some(byteWordErr), JSON.stringify(s.errors));
});

test('native: DEF b:BYTE requires E-VO mode (EC has no BYTE)', a => {
  const s = sem('PROC main()\n  DEF b:BYTE\n  b:=65\nENDPROC');
  a.ok(s.errors.some(byteWordErr), 'native scalar BYTE must error: ' + JSON.stringify(s.errors));
});

test('native: ARRAY OF BYTE requires E-VO mode', a => {
  const s = sem('PROC main()\n  DEF a[4]:ARRAY OF BYTE\n  a[0]:=1\nENDPROC');
  a.ok(s.errors.some(byteWordErr), 'native ARRAY OF BYTE must error: ' + JSON.stringify(s.errors));
});
