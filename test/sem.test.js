import { test } from './harness.js';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sem.js';

function sem(src) {
  const { program, errors } = parse(src);
  if (errors.length) throw new Error('parse errors: ' + JSON.stringify(errors));
  return analyze(program);
}

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
