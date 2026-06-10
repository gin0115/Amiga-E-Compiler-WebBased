import { test } from './harness.js';
import { Asm } from '../src/asm68k.js';
import { AsmText } from '../src/asmtext.js';

function asm(lines, env = {}) {
  const a = new Asm();
  const at = new AsmText(a, {
    resolveVar: env.resolveVar ?? (() => null),
    label: n => n,
    constVal: env.constVal ?? (() => null),
  });
  for (const l of lines) at.line(l);
  if (at.errors.length) throw new Error(at.errors.join('; '));
  if (env.labels) for (const [n, off] of Object.entries(env.labels)) a.labels.set(n, off);
  return [...a.finish()].map(b => b.toString(16).padStart(2, '0')).join(' ');
}

test('asmtext: moves', a => {
  a.equal(asm(['MOVE.L D0,D1']), '22 00');
  a.equal(asm(['MOVEQ # 1 , D0']), '70 01');
  a.equal(asm(['MOVE.W (A0)+,D2']), '34 18');
  a.equal(asm(['MOVE.B D0,-(A1)']), '13 00');
  a.equal(asm(['MOVE.L 8(A5),D0']), '20 2d 00 08');
  a.equal(asm(['MOVEA.L D0,A6']), '2c 40');
});

test('asmtext: E variable operands', a => {
  const env = { resolveVar: n => n === 'x' ? { an: 5, disp: -4 } : null };
  a.equal(asm(['MOVE.L D0,x'], env), '2b 40 ff fc');
  a.equal(asm(['MOVE.L x,D1'], env), '22 2d ff fc');
});

test('asmtext: arithmetic and immediates', a => {
  a.equal(asm(['ADDQ.L #1,D2']), '52 82');
  a.equal(asm(['SUBQ.L #4,A7']), '59 8f');
  a.equal(asm(['ADD.L D1,D0']), 'd0 81');
  a.equal(asm(['CMPI.B #$20,D0']), '0c 00 00 20');
  a.equal(asm(['ADD.L #6,D3']), '06 83 00 00 00 06');
  a.equal(asm(['MULS D1,D0']), 'c1 c1');
});

test('asmtext: lea, jsr, branches', a => {
  a.equal(asm(['LEA 4(A5),A0']), '41 ed 00 04');
  a.equal(asm(['JSR -552(A6)']), '4e ae fd d8');
  a.equal(asm(['lp:'.length ? 'NOP' : '']), '4e 71');
  a.equal(asm(['BNE done', 'NOP'], { labels: { done: 4 } }), '66 00 00 02 4e 71');
});

test('asmtext: misc ops', a => {
  a.equal(asm(['CLR.L D0']), '42 80');
  a.equal(asm(['TST.B (A0)']), '4a 10');
  a.equal(asm(['EXT.L D0']), '48 c0');
  a.equal(asm(['SWAP D2']), '48 42');
  a.equal(asm(['LSR.L #1,D1']), 'e2 89');
  a.equal(asm(['ASL.L D1,D0']), 'e3 a0');
  a.equal(asm(['MOVEM.L D2-D3/A2,-(SP)']), '48 e7 30 20');
  a.equal(asm(['MOVEM.L (SP)+,D2-D3/A2']), '4c df 04 0c');
});
