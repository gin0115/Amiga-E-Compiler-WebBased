// Differential testing: compile each program with the REAL E v3.3a compiler
// (ECDEMO under vamos) and with ecomp, run both under vamos, compare stdout.
// The real compiler is ground truth; any mismatch is an ecomp bug.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sem.js';
import { compileProgram } from '../src/codegen.js';
import { resolveModule, makeResolver } from './modules.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Oracle = the registered EC v3.3a: a directory containing the `EC` binary,
// mounted as bin: and run as bin:EC. Modules come from ecomp's own set.
const EC_DIR = join(root, '..', '..', 'amiga-e', 'research', 'extracted', 'ec33a', 'ec33a');
const MODS = join(root, 'modules');
const VAMOS = join(process.env.HOME, '.local/bin/vamos');
const FAKE = '*.library=mode:fake,version:40+dos.library=mode:auto+exec.library=mode:auto+mathieeesingbas.library=mode:auto+mathieeesingtrans.library=mode:auto';

function vamos(args, timeoutMs = 60000) {
  try {
    return { status: 0, out: execFileSync(VAMOS, args, { timeout: timeoutMs, encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { status: e.status ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

function runOracle(work, src, aux) {
  if (aux) {
    writeFileSync(join(work, aux.file), aux.src, 'latin1');
    vamos(['-q', '-V', `work:${work}`, '-V', `mods:${MODS}`, '-V', `bin:${EC_DIR}`,
      '-a', 'emodules:work:+mods:', '--cwd', 'work:', 'bin:EC', aux.file]);
  }
  writeFileSync(join(work, 'ref.e'), src, 'latin1');
  vamos(['-q', '-V', `work:${work}`, '-V', `mods:${MODS}`, '-V', `bin:${EC_DIR}`,
    '-a', 'emodules:work:+mods:', '--cwd', 'work:', 'bin:EC', 'ref.e']);
  if (!existsSync(join(work, 'ref'))) return { ok: false, out: '<oracle compile failed>' };
  const r = vamos(['-q', '-O', FAKE, '-V', `work:${work}`, '--cwd', 'work:', 'work:ref']);
  return { ok: true, out: r.out };
}

function runEcomp(work, src, aux) {
  if (aux) writeFileSync(join(work, aux.file), aux.src, 'latin1');
  const { program, errors: pe } = parse(src, 'test.e');
  if (pe.length) return { ok: false, out: '<parse: ' + pe[0].msg + '>' };
  const sem = analyze(program, { resolveModule: makeResolver(work) });
  if (sem.errors.length) return { ok: false, out: '<sem: ' + sem.errors[0].msg + '>' };
  const { bin, errors } = compileProgram(program, sem);
  if (errors.length) return { ok: false, out: '<codegen: ' + errors[0].msg + '>' };
  writeFileSync(join(work, 'ours'), bin);
  const r = vamos(['-q', '-O', FAKE, '-V', `work:${work}`, '--cwd', 'work:', 'work:ours']);
  return { ok: true, out: r.out };
}

const CASES = [
  ['hello', "PROC main()\n  WriteF('Hello, World!\\n')\nENDPROC"],
  ['decimal', "PROC main()\n  WriteF('\\d\\n', 42)\nENDPROC"],
  ['negative', "PROC main()\n  WriteF('\\d\\n', -123456789)\nENDPROC"],
  ['zero', "PROC main()\n  WriteF('\\d\\n', 0)\nENDPROC"],
  ['left-to-right', "PROC main()\n  WriteF('\\d\\n', 1+2*3)\nENDPROC"],
  ['parens', "PROC main()\n  WriteF('\\d\\n', 1+(2*3))\nENDPROC"],
  ['division', "PROC main()\n  WriteF('\\d \\d \\d\\n', 100/7, -100/7, 100/-7)\nENDPROC"],
  ['multiply-large', "PROC main()\n  WriteF('\\d \\d\\n', 46341*46341, -1000*123456)\nENDPROC"],
  ['hex-bin-char', "PROC main()\n  WriteF('\\d \\d \\d\\n', $FF, %1010, \"A\")\nENDPROC"],
  ['comparisons', "PROC main()\n  WriteF('\\d \\d \\d \\d \\d \\d\\n', 1=1, 1<>1, 2>1, 2<1, 2>=2, 1<=0)\nENDPROC"],
  ['bitwise', "PROC main()\n  WriteF('\\d \\d\\n', 12 AND 10, 12 OR 3)\nENDPROC"],
  // NB oracle-verified: CONST may not reference other constants in v3.3a
  ['constants', "CONST TEN=10, TWICE=20\nPROC main()\n  WriteF('\\d \\d \\d\\n', TEN, TWICE, TRUE)\nENDPROC"],
  ['enums', "ENUM A, B, C=10, D\nPROC main()\n  WriteF('\\d \\d \\d \\d\\n', A, B, C, D)\nENDPROC"],
  ['locals-and-assign', "PROC main()\n  DEF x, y\n  x:=5\n  y:=x*x\n  WriteF('\\d\\n', y)\nENDPROC"],
  ['def-init', "PROC main()\n  DEF a=3, b=4\n  WriteF('\\d\\n', (a*a)+(b*b))\nENDPROC"],
  ['globals', "DEF g\nPROC main()\n  g:=99\n  bump()\n  WriteF('\\d\\n', g)\nENDPROC\nPROC bump()\n  g:=g+1\nENDPROC"],
  ['if-else', "PROC main()\n  DEF x\n  x:=5\n  IF x>3\n    WriteF('big\\n')\n  ELSE\n    WriteF('small\\n')\n  ENDIF\nENDPROC"],
  ['if-oneline', "PROC main()\n  DEF x\n  x:=1\n  IF x THEN WriteF('yes\\n') ELSE WriteF('no\\n')\nENDPROC"],
  ['elseif-chain', "PROC main()\n  DEF x\n  FOR x:=1 TO 4\n    IF x=1\n      WriteF('one ')\n    ELSEIF x=2\n      WriteF('two ')\n    ELSEIF x=3\n      WriteF('three ')\n    ELSE\n      WriteF('more ')\n    ENDIF\n  ENDFOR\n  WriteF('\\n')\nENDPROC"],
  ['while', "PROC main()\n  DEF i\n  i:=0\n  WHILE i<5\n    WriteF('\\d', i)\n    i:=i+1\n  ENDWHILE\n  WriteF('\\n')\nENDPROC"],
  ['repeat', "PROC main()\n  DEF i\n  i:=10\n  REPEAT\n    WriteF('\\d ', i)\n    i:=i-3\n  UNTIL i<0\n  WriteF('\\n')\nENDPROC"],
  ['for-step', "PROC main()\n  DEF i\n  FOR i:=10 TO 0 STEP -2\n    WriteF('\\d ', i)\n  ENDFOR\n  WriteF('\\n')\nENDPROC"],
  // NB oracle-verified: EXIT is illegal inside LOOP ("incoherent
  // programstructure") — it belongs to FOR/WHILE only
  ['while-exit', "PROC main()\n  DEF i\n  i:=0\n  WHILE TRUE\n    i:=i+1\n    EXIT i>4\n  ENDWHILE\n  WriteF('\\d\\n', i)\nENDPROC"],
  ['runtime-mul-16bit', "PROC main()\n  DEF a, b\n  a:=46341\n  b:=46341\n  WriteF('\\d \\d\\n', a*b, a*2)\nENDPROC"],
  ['mul-strength-reduce', "PROC main()\n  DEF a\n  a:=46341\n  WriteF('\\d \\d \\d \\d\\n', a*2, a*4, a*8, 2*a)\nENDPROC"],
  ['div-negative', "PROC main()\n  DEF a\n  a:=-7\n  WriteF('\\d \\d\\n', a/2, a/-2)\nENDPROC"],
  ['runtime-div', "PROC main()\n  DEF a\n  a:=1000000\n  WriteF('\\d \\d\\n', a/7, a/-13)\nENDPROC"],
  ['proc-call', "PROC add(a, b)\nENDPROC a+b\nPROC main()\n  WriteF('\\d\\n', add(20, 22))\nENDPROC"],
  ['proc-is', "PROC sq(x) IS x*x\nPROC main()\n  WriteF('\\d\\n', sq(9))\nENDPROC"],
  ['recursion', "PROC fac(n)\n  IF n<=1 THEN RETURN 1\nENDPROC n*fac(n-1)\nPROC main()\n  WriteF('\\d\\n', fac(10))\nENDPROC"],
  ['fibonacci', "PROC fib(n)\n  IF n<2 THEN RETURN n\nENDPROC fib(n-1)+fib(n-2)\nPROC main()\n  DEF i\n  FOR i:=0 TO 10\n    WriteF('\\d ', fib(i))\n  ENDFOR\n  WriteF('\\n')\nENDPROC"],
  ['string-fmt', "PROC main()\n  WriteF('\\s and \\s\\n', 'foo', 'bar')\nENDPROC"],
  ['char-fmt', "PROC main()\n  WriteF('\\c\\c\\c\\n', 70, 79, 79)\nENDPROC"],
  ['ternary-exp', "PROC main()\n  DEF x\n  x:=7\n  WriteF('\\d\\n', IF x>5 THEN 100 ELSE 200)\nENDPROC"],
  ['but-op', "PROC main()\n  DEF x\n  WriteF('\\d\\n', (x:=2) BUT x*x)\nENDPROC"],
  ['nested-calls', "PROC twice(x) IS x*2\nPROC main()\n  WriteF('\\d\\n', twice(twice(twice(5))))\nENDPROC"],
  ['jump-label', "PROC main()\n  DEF x\n  x:=1\n  IF x THEN JUMP skip\n  WriteF('not printed\\n')\nskip:\n  WriteF('jumped\\n')\nENDPROC"],
  // ---- strings ----
  ['estring-copy', "PROC main()\n  DEF s[20]:STRING\n  StrCopy(s, 'hello world')\n  WriteF('\\s \\d \\d\\n', s, EstrLen(s), StrMax(s))\nENDPROC"],
  ['estring-clamp', "PROC main()\n  DEF s[5]:STRING\n  StrCopy(s, 'overflowing')\n  WriteF('\\s \\d\\n', s, EstrLen(s))\nENDPROC"],
  ['estring-add', "PROC main()\n  DEF s[30]:STRING\n  StrCopy(s, 'foo')\n  StrAdd(s, 'bar')\n  StrAdd(s, '-baz')\n  WriteF('\\s \\d\\n', s, EstrLen(s))\nENDPROC"],
  ['estring-copy-len', "PROC main()\n  DEF s[20]:STRING\n  StrCopy(s, 'abcdefgh', 3)\n  WriteF('\\s \\d\\n', s, EstrLen(s))\nENDPROC"],
  ['strlen', "PROC main()\n  WriteF('\\d\\n', StrLen('four'))\nENDPROC"],
  ['string-index', "PROC main()\n  DEF s[10]:STRING\n  StrCopy(s, 'ABC')\n  WriteF('\\d \\d\\n', s[0], s[2])\nENDPROC"],
  ['stringf', "PROC main()\n  DEF s[40]:STRING\n  StringF(s, 'x=\\d y=\\s!', 42, 'why')\n  WriteF('\\s \\d\\n', s, EstrLen(s))\nENDPROC"],
  // ---- arrays ----
  ['array-char', "PROC main()\n  DEF a[10]:ARRAY, i\n  FOR i:=0 TO 9 DO a[i]:=65+i\n  a[9]:=0\n  WriteF('\\s\\n', a)\nENDPROC"],
  ['array-int', "PROC main()\n  DEF a[5]:ARRAY OF INT, i, t\n  FOR i:=0 TO 4 DO a[i]:=(i*i)-2\n  t:=0\n  FOR i:=0 TO 4 DO t:=t+a[i]\n  WriteF('\\d \\d\\n', t, a[1])\nENDPROC"],
  ['array-long', "PROC main()\n  DEF a[4]:ARRAY OF LONG\n  a[0]:=100000\n  a[3]:=-100000\n  WriteF('\\d \\d\\n', a[0], a[3])\nENDPROC"],
  // ---- objects ----
  ['object-members', "OBJECT point\n  x:INT, y:INT\nENDOBJECT\nPROC main()\n  DEF p[1]:ARRAY OF point, q:PTR TO point\n  q:=p\n  q.x:=-7\n  q.y:=300\n  WriteF('\\d \\d \\d\\n', q.x, q.y, SIZEOF point)\nENDPROC"],
  ['object-char-member', "OBJECT rec\n  tag:CHAR, big:LONG\nENDOBJECT\nPROC main()\n  DEF r[1]:ARRAY OF rec, p:PTR TO rec\n  p:=r\n  p.tag:=200\n  p.big:=123456\n  WriteF('\\d \\d\\n', p.tag, p.big)\nENDPROC"],
  // ---- select ----
  ['select-plain', "PROC main()\n  DEF c, i\n  FOR i:=8 TO 11\n    SELECT i\n      CASE 9\n        WriteF('tab ')\n      CASE 10\n        WriteF('lf ')\n      DEFAULT\n        WriteF('(\\d) ', i)\n    ENDSELECT\n  ENDFOR\n  WriteF('\\n')\nENDPROC"],
  ['select-multi-range', "PROC main()\n  DEF i\n  FOR i:=60 TO 70\n    SELECT 128 OF i\n      CASE 65 TO 67, 70\n        WriteF('x')\n      CASE 61, 63\n        WriteF('o')\n      DEFAULT\n        WriteF('.')\n    ENDSELECT\n  ENDFOR\n  WriteF('\\n')\nENDPROC"],
  // ---- inc/dec and ++/-- ----
  ['inc-dec', "PROC main()\n  DEF x\n  x:=10\n  INC x\n  INC x\n  DEC x\n  WriteF('\\d\\n', x)\nENDPROC"],
  ['postinc-semantics', "PROC main()\n  DEF x, y\n  x:=5\n  y:=x++\n  WriteF('\\d \\d\\n', x, y)\n  x:=5\n  y:=x--\n  WriteF('\\d \\d\\n', x, y)\nENDPROC"],
  // oracle-verified: a[0]++ yields the element then advances the VARIABLE a
  ['array-postinc', "PROC main()\n  DEF a[3]:ARRAY OF LONG, p\n  a[0]:=7\n  a[1]:=99\n  p:=a[0]++\n  WriteF('\\d \\d\\n', a[0], p)\nENDPROC"],
  ['ptr-stride', "OBJECT pt\n  x:INT, y:LONG\nENDOBJECT\nPROC main()\n  DEF pi:PTR TO INT, o:PTR TO pt\n  pi:=1000\n  pi++\n  o:=1000\n  o++\n  WriteF('\\d \\d\\n', pi, o)\nENDPROC"],
  // ---- multiple return values ----
  ['multi-return', "PROC two()\nENDPROC 11, 22\nPROC main()\n  DEF a, b\n  a,b:=two()\n  WriteF('\\d \\d\\n', a, b)\nENDPROC"],
  ['multi-return-3', "PROC three() IS 1, 2, 3\nPROC main()\n  DEF a, b, c\n  a,b,c:=three()\n  WriteF('\\d \\d \\d\\n', a, b, c)\nENDPROC"],
  // ---- heap ----
  // Dispose()'s return value is undefined on real ec (48!) — don't assert it
  ['new-dispose', "PROC main()\n  DEF p\n  p:=New(40)\n  WriteF('\\d ', IF p THEN 1 ELSE 0)\n  WriteF('\\d\\n', Long(p))\n  Dispose(p)\nENDPROC"],
  ['new-object', "OBJECT pt\n  x:LONG, y:LONG\nENDOBJECT\nPROC main()\n  DEF p:PTR TO pt\n  NEW p\n  p.x:=11\n  p.y:=p.x*2\n  WriteF('\\d \\d\\n', p.x, p.y)\n  END p\n  WriteF('\\d\\n', p)\nENDPROC"],
  ['new-array', "PROC main()\n  DEF p:PTR TO LONG, i, t\n  NEW p[10]\n  FOR i:=0 TO 9 DO p[i]:=i*i\n  t:=0\n  FOR i:=0 TO 9 DO t:=t+p[i]\n  END p[10]\n  WriteF('\\d\\n', t)\nENDPROC"],
  ['string-builtin', "PROC main()\n  DEF s\n  s:=String(10)\n  StrCopy(s, 'dynamic!')\n  WriteF('\\s \\d \\d\\n', s, EstrLen(s), StrMax(s))\nENDPROC"],
  // ---- modules ----
  ['module-consts', "MODULE 'dos/dos'\nPROC main()\n  WriteF('\\d \\d \\d\\n', MODE_NEWFILE, MODE_OLDFILE, OFFSET_END)\nENDPROC"],
  ['module-sizeof', "MODULE 'dos/dos'\nPROC main()\n  WriteF('\\d\\n', SIZEOF fileinfoblock)\nENDPROC"],
  ['module-object-members', "MODULE 'exec/lists'\nPROC main()\n  DEF l[1]:ARRAY OF lh, p:PTR TO lh\n  p:=l\n  p.type:=5\n  WriteF('\\d \\d\\n', p.type, SIZEOF lh)\nENDPROC"],
  ['module-libcall', "MODULE 'dos'\nPROC main()\n  DEF fh, c1, c2\n  fh:=Open('t.txt', NEWFILE)\n  FputC(fh, 65)\n  FputC(fh, 66)\n  Close(fh)\n  fh:=Open('t.txt', OLDFILE)\n  c1:=FgetC(fh)\n  c2:=FgetC(fh)\n  Close(fh)\n  WriteF('\\c\\c\\n', c1, c2)\nENDPROC"],
  ['shifts-mod-abs', "PROC main()\n  DEF a\n  a:=-8\n  WriteF('\\d \\d \\d \\d \\d \\d\\n', Shl(3,4), Shr(a,1), Shr(256,4), Mod(-7,2), Mod(7,-2), Abs(-5))\nENDPROC"],
  ['eor-not', "PROC main()\n  WriteF('\\d \\d\\n', Eor(12,10), Not(0))\nENDPROC"],
  ['cleanup-exit', "PROC sub()\n  WriteF('before\\n')\n  CleanUp(0)\n  WriteF('never\\n')\nENDPROC\nPROC main()\n  sub()\n  WriteF('also never\\n')\nENDPROC"],
  // ---- immediate lists (static, refilled each evaluation) ----
  ['list-basic', "PROC main()\n  DEF l:PTR TO LONG\n  l:=[10,20,30]\n  WriteF('\\d \\d \\d \\d \\d\\n', l[0], l[1], l[2], ListLen(l), ListMax(l))\nENDPROC"],
  ['list-runtime-items', "PROC main()\n  DEF l:PTR TO LONG, x\n  x:=42\n  l:=[1,x,x*2]\n  WriteF('\\d \\d \\d\\n', l[0], l[1], l[2])\nENDPROC"],
  ['list-static-refill', "PROC main()\n  DEF l:PTR TO LONG\n  l:=[1,2,3]\n  l[0]:=777\n  l:=[1,2,3]\n  WriteF('\\d\\n', l[0])\nENDPROC"],
  ['list-typed-obj', "OBJECT pt\n  x:LONG, y:INT, tag:CHAR\nENDOBJECT\nPROC main()\n  DEF p:PTR TO pt\n  p:=[1000, 70, 65]:pt\n  WriteF('\\d \\d \\d\\n', p.x, p.y, p.tag)\nENDPROC"],
  ['list-as-arg', "PROC sum(l:PTR TO LONG, n)\n  DEF i, t\n  t:=0\n  FOR i:=0 TO n-1 DO t:=t+l[i]\n  ENDPROC t\nPROC main()\n  WriteF('\\d\\n', sum([5,10,15,20], 4))\nENDPROC"],
  // ---- exceptions (semantics oracle-verified) ----
  ['exception-catch', "PROC deep()\n  Raise(\"BAD\")\n  WriteF('deep-after\\n')\nENDPROC\nPROC mid() IS deep()+1\nPROC guarded() HANDLE\n  mid()\n  WriteF('guarded-after\\n')\nEXCEPT\n  WriteF('caught \\d\\n', exception)\nENDPROC 111\nPROC main()\n  WriteF('ret \\d\\n', guarded())\nENDPROC"],
  ['except-do-finally', "PROC f(n) HANDLE\n  IF n THEN Raise(\"OOPS\")\n  WriteF('body \\d\\n', n)\nEXCEPT DO\n  WriteF('do exc=\\d\\n', exception)\nENDPROC 222\nPROC main()\n  WriteF('r0=\\d\\n', f(0))\n  WriteF('r1=\\d\\n', f(1))\nENDPROC"],
  ['throw-info', "PROC g() HANDLE\n  Throw(\"X\", 4711)\nEXCEPT\n  WriteF('exc \\d info \\d\\n', exception, exceptioninfo)\nENDPROC\nPROC main()\n  g()\nENDPROC"],
  ['nested-handlers', "PROC inner() HANDLE\n  Raise(1)\nEXCEPT\n  WriteF('inner caught \\d\\n', exception)\n  Raise(2)\nENDPROC\nPROC outer() HANDLE\n  inner()\nEXCEPT\n  WriteF('outer caught \\d\\n', exception)\nENDPROC\nPROC main()\n  outer()\n  WriteF('done\\n')\nENDPROC"],
  ['exception-cleared-on-entry', "PROC h() HANDLE\n  Raise(9)\nEXCEPT\nENDPROC\nPROC k() HANDLE\n  WriteF('k sees exc=\\d\\n', exception)\nEXCEPT DO\n  WriteF('k do exc=\\d\\n', exception)\nENDPROC\nPROC main()\n  h()\n  k()\nENDPROC"],
  // ---- methods (static dispatch, self) ----
  ['method-basic', "OBJECT counter\n  n:LONG\nENDOBJECT\nPROC bump(by) OF counter\n  self.n := self.n + by\nENDPROC self.n\nPROC main()\n  DEF c:PTR TO counter\n  NEW c\n  WriteF('\\d \\d \\d\\n', c.bump(5), c.bump(10), c.n)\n  END c\nENDPROC"],
  ['method-inherited', "OBJECT shape\n  area:LONG\nENDOBJECT\nOBJECT square OF shape\n  side:LONG\nENDOBJECT\nPROC describe() OF shape IS self.area\nPROC main()\n  DEF q:PTR TO square\n  NEW q\n  q.side := 6\n  q.area := q.side * q.side\n  WriteF('\\d\\n', q.describe())\n  END q\nENDPROC"],
  // ---- constructors / destructors ----
  ['constructor', "OBJECT box\n  w:LONG, h:LONG\nENDOBJECT\nPROC init(w, h) OF box\n  self.w:=w\n  self.h:=h\nENDPROC\nPROC main()\n  DEF b:PTR TO box\n  NEW b.init(3, 4)\n  WriteF('\\d \\d \\d\\n', b.w, b.h, b.w*b.h)\n  END b\nENDPROC"],
  ['destructor', "OBJECT res\n  id:LONG\nENDOBJECT\nPROC end() OF res\n  WriteF('destroying \\d\\n', self.id)\nENDPROC\nPROC main()\n  DEF r:PTR TO res\n  NEW r\n  r.id:=42\n  END r\n  WriteF('r=\\d\\n', r)\nENDPROC"],
  ['openw-fake-nil', "PROC main()\n  DEF w\n  w:=OpenW(20,20,200,100,$200,$F,'test',NIL,1,NIL)\n  WriteF('w=\\d\\n', IF w THEN 1 ELSE 0)\n  CloseW(w)\n  WriteF('closed\\n')\nENDPROC"],
  ['gfx-nil-stdrast', "PROC main()\n  Plot(10, 10)\n  Line(0, 0, 50, 50, 2)\n  Box(5, 5, 20, 20)\n  Colour(3)\n  WriteF('len=\\d survived\\n', TextF(10, 10, 'v=\\d', 42))\nENDPROC"],
  // ---- sized globals ----
  ['global-string-array', "DEF gs[20]:STRING, ga[5]:ARRAY OF LONG, gtotal\nPROC fill()\n  DEF i\n  StrCopy(gs, 'global!')\n  FOR i:=0 TO 4 DO ga[i]:=i*i\nENDPROC\nPROC main()\n  DEF i\n  fill()\n  gtotal:=0\n  FOR i:=0 TO 4 DO gtotal:=gtotal+ga[i]\n  WriteF('\\s \\d \\d\\n', gs, EstrLen(gs), gtotal)\nENDPROC"],
  // ---- string builtin cluster ----
  ['val-builtin', "PROC main()\n  DEF v, r\n  v,r:=Val('123x')\n  WriteF('\\d \\d ', v, r)\n  v,r:=Val('$ff')\n  WriteF('\\d \\d ', v, r)\n  v,r:=Val('%101')\n  WriteF('\\d \\d ', v, r)\n  v,r:=Val('-42')\n  WriteF('\\d \\d ', v, r)\n  v,r:=Val('zz')\n  WriteF('\\d \\d\\n', v, r)\nENDPROC"],
  ['instr-trim', "PROC main()\n  WriteF('\\d \\d \\d ', InStr('hello world','world'), InStr('hello','xyz'), InStr('aaab','ab',1))\n  WriteF('[\\s]\\n', TrimStr('   spaced'))\nENDPROC"],
  ['case-mid-right', "PROC main()\n  DEF s[30]:STRING, t[30]:STRING, u[30]:STRING\n  StrCopy(s, 'Hello World')\n  UpperStr(s)\n  WriteF('\\s ', s)\n  LowerStr(s)\n  WriteF('\\s ', s)\n  MidStr(t, 'abcdefgh', 2, 3)\n  WriteF('\\s ', t)\n  StrCopy(u, 'abcdefgh')\n  RightStr(t, u, 3)\n  WriteF('\\s\\n', t)\nENDPROC"],
  ['setstr-ostrcmp', "PROC main()\n  DEF s[20]:STRING\n  StrCopy(s, 'abcdef')\n  SetStr(s, 3)\n  WriteF('\\s \\d ', s, EstrLen(s))\n  WriteF('\\d \\d \\d\\n', OstrCmp('abc','abd'), OstrCmp('abc','abc'), OstrCmp('abd','abc'))\nENDPROC"],
  ['readstr-lines', "PROC main()\n  DEF fh, s[40]:STRING, r1, r2, r3\n  fh:=Open('lines.txt', NEWFILE)\n  Write(fh, 'one\\ntwo\\n', 8)\n  Close(fh)\n  fh:=Open('lines.txt', OLDFILE)\n  r1:=ReadStr(fh, s)\n  WriteF('[\\s] \\d ', s, r1)\n  r2:=ReadStr(fh, s)\n  WriteF('[\\s] \\d ', s, r2)\n  r3:=ReadStr(fh, s)\n  WriteF('[\\s] \\d\\n', s, r3)\n  Close(fh)\nENDPROC"],
  // ---- math/misc ----
  ['min-max-bounds', "PROC main()\n  WriteF('\\d \\d \\d \\d \\d\\n', Min(3,7), Max(3,7), Bounds(10,0,5), Bounds(-3,0,5), Bounds(2,0,5))\nENDPROC"],
  ['even-odd-mul', "PROC main()\n  WriteF('\\d \\d \\d \\d ', Even(4), Odd(4), Even(-3), Odd(-3))\n  WriteF('\\d\\n', Mul(46341, 46341))\nENDPROC"],
  ['kickversion-ctrlc', "PROC main()\n  WriteF('\\d \\d \\d\\n', KickVersion(36), KickVersion(99), CtrlC())\nENDPROC"],
  // ---- floats (IEEE single via mathieeesingbas) ----
  ['float-basic', "PROC main()\n  DEF x, a\n  x:=2.5\n  WriteF('\\d ', x)\n  a:=10\n  x:=a!\n  WriteF('\\d ', x)\n  a:=!x!\n  WriteF('\\d\\n', a)\nENDPROC"],
  ['float-arith', "PROC main()\n  DEF x, y, z\n  x:=2.5\n  y:=4.0\n  z:=!x*y\n  WriteF('\\d ', z)\n  z:=!x+y-1.5\n  WriteF('\\d ', z)\n  z:=!y/x\n  WriteF('\\d\\n', z)\nENDPROC"],
  ['float-mixed', "PROC main()\n  DEF a, x, r\n  a:=3\n  x:=1.5\n  r:=!(a!)*x!\n  WriteF('\\d\\n', r)\nENDPROC"],
  ['float-funcs', "PROC main()\n  DEF x\n  x:=2.25\n  WriteF('\\d \\d \\d ', Fabs(-1.5!*1.0), Ffloor(x), Fceil(x))\n  WriteF('\\d\\n', Fsqrt(x))\nENDPROC"],
  // ---- quoted expressions / Eval / list functions / cells ----
  ['quote-eval', "DEF qx\nPROC main()\n  DEF f\n  f:=`qx*qx\n  qx:=7\n  WriteF('\\d ', Eval(f))\n  qx:=9\n  WriteF('\\d\\n', Eval(f))\nENDPROC"],
  ['maplist', "DEF v\nPROC main()\n  DEF src:PTR TO LONG, dst[10]:LIST\n  src:=[1,2,3,4]\n  MapList({v}, src, dst, `v*v)\n  WriteF('\\d \\d \\d \\d \\d\\n', dst[0], dst[1], dst[2], dst[3], ListLen(dst))\nENDPROC"],
  ['forall-exists', "DEF v\nPROC main()\n  DEF l:PTR TO LONG\n  l:=[2,4,6]\n  WriteF('\\d \\d ', ForAll({v}, l, `Even(v)), Exists({v}, l, `v>5))\n  l:=[2,5,6]\n  WriteF('\\d \\d\\n', ForAll({v}, l, `Even(v)), Exists({v}, l, `v>9))\nENDPROC"],
  ['selectlist', "DEF v\nPROC main()\n  DEF src:PTR TO LONG, dst[10]:LIST\n  src:=[1,2,3,4,5,6]\n  SelectList({v}, src, dst, `Odd(v))\n  WriteF('\\d \\d \\d \\d\\n', dst[0], dst[1], dst[2], ListLen(dst))\nENDPROC"],
  ['cells', "PROC main()\n  DEF c\n  c:=<1|<2|NIL>>\n  WriteF('\\d \\d \\d\\n', Car(c), Car(Cdr(c)), Cdr(Cdr(c)))\nENDPROC"],
  // ---- inline assembly (ch_15) ----
  ['asm-basic', "PROC main()\n  DEF x\n  MOVEQ #42,D0\n  MOVE.L D0,x\n  WriteF('\\d\\n', x)\nENDPROC"],
  ['asm-arith', "PROC main()\n  DEF a, b\n  a:=1000\n  MOVE.L a,D0\n  ADD.L D0,D0\n  ADDQ.L #5,D0\n  MOVE.L D0,b\n  WriteF('\\d\\n', b)\nENDPROC"],
  ['asm-loop', "PROC main()\n  DEF t\n  MOVEQ #0,D0\n  MOVEQ #9,D1\nlp:\n  ADD.L D1,D0\n  DBRA D1,lp\n  MOVE.L D0,t\n  WriteF('\\d\\n', t)\nENDPROC"],
  ['asm-mixed-e', "PROC main()\n  DEF v\n  v:=7\n  MOVE.L v,D0\n  MULS #6,D0\n  MOVE.L D0,v\n  WriteF('\\d\\n', v)\nENDPROC"],
  // ---- multi-file project: MODULE '*helper' from source/.m ----
  [{n:'multifile-module', aux:{file:'helper.e', src:"OPT MODULE\nEXPORT CONST MAGIC=77\nEXPORT OBJECT vec2\n  x:LONG, y:LONG\nENDOBJECT\nEXPORT PROC dot(a:PTR TO vec2, b:PTR TO vec2)\nENDPROC Mul(a.x,b.x)+Mul(a.y,b.y)\n"}},
   "MODULE '*helper'\nPROC main()\n  DEF p:PTR TO vec2, q:PTR TO vec2\n  NEW p\n  NEW q\n  p.x:=3; p.y:=4\n  q.x:=10; q.y:=20\n  WriteF('\\d \\d \\d\\n', dot(p,q), MAGIC, SIZEOF vec2)\nENDPROC"],
  // ---- unification (ch_4L) ----
  ['unify-bind', "PROC main()\n  DEF l:PTR TO LONG, x, y, r\n  l:=[1,5,9]\n  r:=l <=> [1,x,y]\n  WriteF('\\d \\d \\d\\n', r, x, y)\nENDPROC"],
  ['unify-mismatch', "PROC main()\n  DEF l:PTR TO LONG, x, r\n  l:=[2,5]\n  r:=l <=> [1,x]\n  WriteF('\\d ', r)\n  r:=l <=> [2,x]\n  WriteF('\\d \\d\\n', r, x)\nENDPROC"],
  ['unify-length', "PROC main()\n  DEF l:PTR TO LONG, x, r\n  l:=[1,2,3]\n  r:=l <=> [1,x]\n  WriteF('\\d\\n', r)\nENDPROC"],
  ['unify-nested', "PROC main()\n  DEF l:PTR TO LONG, a, b, r\n  l:=[1,[20,30],4]\n  r:=l <=> [1,[a,b],4]\n  WriteF('\\d \\d \\d\\n', r, a, b)\nENDPROC"],
  // ---- complex strings: Link/Next/DisposeLink (ch_9H) ----
  ['link-chain', "PROC main()\n  DEF a, b, c, p\n  a:=String(8)\n  b:=String(8)\n  c:=String(8)\n  StrCopy(a, 'one')\n  StrCopy(b, 'two')\n  StrCopy(c, 'three')\n  Link(a, b)\n  Link(b, c)\n  Link(c, NIL)\n  p:=a\n  WHILE p\n    WriteF('\\s ', p)\n    p:=Next(p)\n  ENDWHILE\n  WriteF('\\n')\nENDPROC"],
  ['gadgetsize', "PROC main()\n  WriteF('\\d\\n', GADGETSIZE)\nENDPROC"],
  ['disposelink', "PROC main()\n  DEF a, b, p\n  a:=String(4)\n  b:=String(4)\n  StrCopy(a, 'x')\n  StrCopy(b, 'y')\n  Link(a, b)\n  p:=DisposeLink(a)\n  WriteF('\\s\\n', p)\nENDPROC"],
  ['strcmp', "PROC main()\n  WriteF('\\d \\d \\d\\n', StrCmp('abc','abc'), StrCmp('abc','abd'), StrCmp('abcdef','abcxyz',3))\nENDPROC"],
];

// --emit=PATH snapshots the EC-oracle output for every case into a committed
// goldens file, so the cases can be replayed against ecomp under vamos WITHOUT
// the EC oracle (see test/e2e/run-golden.js). Run this whenever CASES changes.
const EMIT = (process.argv.find(a => a.startsWith('--emit=')) ?? '').slice(7);

let pass = 0, fail = 0;
const failures = [];
const goldens = [];
for (let [name, src] of CASES) {
  const display = typeof name === 'object' ? name.n : name;
  const work = mkdtempSync(join(tmpdir(), 'ecomp-diff-'));
  const aux = typeof name === 'object' ? name.aux : null;
  const ref = runOracle(work, src, aux);
  if (EMIT) {
    if (ref.ok) { goldens.push({ name: display, src, aux, expected: ref.out }); console.log(`SNAP ${display}`); }
    else { console.log(`SKIP ${display} (oracle could not build)`); }
    rmSync(work, { recursive: true, force: true });
    continue;
  }
  const ours = runEcomp(work, src, aux);
  const ok = ref.ok && ours.ok && ref.out === ours.out;
  if (ok) { pass++; console.log(`PASS ${display}`); }
  else {
    fail++;
    console.log(`FAIL ${display}`);
    failures.push({ name: display, ref: ref.out, ours: ours.out });
  }
  rmSync(work, { recursive: true, force: true });
}
if (EMIT) {
  writeFileSync(EMIT, JSON.stringify(goldens, null, 1), 'latin1');
  console.log(`\nwrote ${goldens.length} EC-verified goldens to ${EMIT}`);
  process.exit(0);
}
console.log(`\n${pass}/${pass + fail} differential tests passed`);
for (const f of failures) {
  console.log(`\n--- ${f.name} ---`);
  console.log(`oracle: ${JSON.stringify(f.ref)}`);
  console.log(`ecomp:  ${JSON.stringify(f.ours)}`);
}
process.exit(fail ? 1 : 0);
