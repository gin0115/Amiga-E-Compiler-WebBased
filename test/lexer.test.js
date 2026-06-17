import { test } from './harness.js';
import { lex } from '../src/lexer.js';

// strip trailing nl+eof for compact comparisons
function types(src) {
  const { tokens, errors } = lex(src);
  if (errors.length) throw new Error('lex errors: ' + JSON.stringify(errors));
  return tokens.slice(0, -2).map(t => t.type);
}
function toks(src) {
  const { tokens, errors } = lex(src);
  if (errors.length) throw new Error('lex errors: ' + JSON.stringify(errors));
  return tokens.slice(0, -2);
}
function one(src) {
  const t = toks(src);
  if (t.length !== 1) throw new Error(`expected 1 token, got ${t.length}: ${JSON.stringify(t)}`);
  return t[0];
}

test('hello world program', a => {
  const t = toks("PROC main()\n  WriteF('Hello!\\n')\nENDPROC");
  a.deepEqual(t.map(x => x.type),
    ['kw', 'ident', '(', ')', 'nl', 'ecall', '(', 'str', ')', 'nl', 'kw']);
  a.equal(t[0].value, 'PROC');
  a.equal(t[5].value, 'WriteF');
});

test('nested block comments (ch_1B)', a => {
  a.deepEqual(types('a /* x /* y */ z */ b'), ['ident', 'ident']);
});

test('line comment ->', a => {
  a.deepEqual(types('a -> all of this ignored\nb'), ['ident', 'nl', 'ident']);
});

test('line comment // (E-VO / modern E)', a => {
  a.deepEqual(types('a // all of this ignored\nb'), ['ident', 'nl', 'ident']);
  // a lone '/' still divides; '/*' is still a block comment
  a.deepEqual(types('a / b'), ['ident', '/', 'ident']);
  a.deepEqual(types('a /* x */ b'), ['ident', 'ident']);
});

test('multi-line block comment separates statements', a => {
  a.deepEqual(types('a /* c1\nc2 */ b'), ['ident', 'nl', 'ident']);
});

test('identifier classes (ch_1C)', a => {
  a.equal(one('foo').type, 'ident');
  a.equal(one('_x').type, 'ident');
  a.equal(one('fOO').type, 'ident');
  a.equal(one('Foo').type, 'ecall');
  a.equal(one('WriteF').type, 'ecall');
  a.equal(one('MAX_LEN').type, 'upper');
  a.equal(one('A').type, 'upper');
  a.equal(one('D0').type, 'upper');
  a.equal(one('MOVE').type, 'upper');
  a.equal(one('IF').type, 'kw');
  a.equal(one('ENDPROC').type, 'kw');
});

test('decimal int (ch_2A)', a => {
  a.deepEqual(one('1024'), { type: 'int', value: 1024, raw: '1024', line: 1, col: 1 });
});

test('negative number is minus + int (parser handles unary)', a => {
  a.deepEqual(types('-12'), ['-', 'int']);
});

test('hex (ch_2B)', a => {
  a.equal(one('$FC').value, 0xFC);
  a.equal(one('$dff180').value, 0xDFF180);
  a.equal(one('$FFFFFFFF').value, 0xFFFFFFFF);
});

test('binary (ch_2C)', a => {
  a.equal(one('%111').value, 7);
  a.equal(one('%1010100001').value, 0b1010100001);
});

test('floats (ch_2D)', a => {
  a.equal(one('3.14159').type, 'float');
  a.equal(one('.1').value, 0.1);
  a.equal(one('1.').value, 1.0);
  a.equal(one('1.').type, 'float');
});

test('dot stays member access after identifiers', a => {
  a.deepEqual(types('rect.x'), ['ident', '.', 'ident']);
  a.deepEqual(types('x[2].y'), ['ident', '[', 'int', ']', '.', 'ident']);
});

test('char constants pack MSB-first (ch_2E)', a => {
  a.equal(one('"A"').value, 65);
  a.equal(one('"AB"').value, 65 * 256 + 66);
  a.equal(one('"FORM"').value, 0x464F524D);
});

test('char constants process escapes (oracle-verified: "\\n"=10, "\\\\"=92)', a => {
  a.equal(one('"\\n"').value, 10);
  a.equal(one('"\\\\"').value, 92);
  const { errors } = lex('"\\"');
  a.ok(errors.length > 0, 'lone backslash char const must error like real ec');
});

test('strings with escapes (ch_2F)', a => {
  a.equal(one("'bla'").value, 'bla');
  a.equal(one("'a\\nb'").value, 'a\nb');
  a.equal(one("'don''t'").value, "don't");
  a.equal(one("'ap\\aos'").value, "ap'os");
  a.equal(one("'q\\qq'").value, 'q"q');
  a.equal(one("'back\\\\slash'").value, 'back\\slash');
});

test('runtime format codes stay literal in strings', a => {
  a.equal(one("'\\d\\h[8]\\s'").value, '\\d\\h[8]\\s');
  a.equal(one("'\\z\\h[8]\\n'").value, '\\z\\h[8]\n');
});

test('operator maximal munch', a => {
  a.deepEqual(types('a<=>b'), ['ident', '<=>', 'ident']);
  a.deepEqual(types('a<=b'), ['ident', '<=', 'ident']);
  a.deepEqual(types('a<>b'), ['ident', '<>', 'ident']);
  a.deepEqual(types('a<b'), ['ident', '<', 'ident']);
  a.deepEqual(types('x:=1'), ['ident', ':=', 'int']);
  a.deepEqual(types('p::lif'), ['ident', '::', 'ident']);
  a.deepEqual(types('p:LONG'), ['ident', ':', 'kw']);
  a.deepEqual(types('i++'), ['ident', '++']);
  a.deepEqual(types('j--'), ['ident', '--']);
  // E-VO shift '<<'/'>>' stays two tokens at lex time (nested cells close with
  // '>>'); the parser recombines an adjacent pair into SHL/SHR.
  a.deepEqual(types('a<<b'), ['ident', '<', '<', 'ident']);
  a.deepEqual(types('a>>b'), ['ident', '>', '>', 'ident']);
  a.deepEqual(types('a-b'), ['ident', '-', 'ident']);
  a.deepEqual(types('a - -b'), ['ident', '-', '-', 'ident']);
});

test('distinctive E operators', a => {
  a.deepEqual(types('^ptr'), ['^', 'ident']);
  a.deepEqual(types('{var}'), ['{', 'ident', '}']);
  a.deepEqual(types('`x*x'), ['`', 'ident', '*', 'ident']);
  a.deepEqual(types('a!'), ['ident', '!']);
  a.deepEqual(types('<a|b>'), ['<', 'ident', '|', 'ident', '>']);
});

test('separators: semicolon equals newline, runs collapse', a => {
  a.deepEqual(types('a;b'), ['ident', 'nl', 'ident']);
  a.deepEqual(types('a\n\n\nb'), ['ident', 'nl', 'ident']);
  a.deepEqual(types('a;\n;b'), ['ident', 'nl', 'ident']);
  a.deepEqual(types('a\r\nb'), ['ident', 'nl', 'ident']);
});

test('no leading separator tokens', a => {
  a.deepEqual(types('\n\na'), ['ident']);
});

test('line/col tracking', a => {
  const t = toks('a\n  b');
  a.equal(t[0].line, 1);
  a.equal(t[2].line, 2);
  a.equal(t[2].col, 3);
});

test('preprocessor-style lines tokenize (ECX corpus compat)', a => {
  a.deepEqual(types('#define DEBUGF WriteF'), ['#', 'ident', 'upper', 'ecall']);
});

test('inline asm tokenizes', a => {
  a.deepEqual(types('MOVE.L (A0)+,D0'),
    ['upper', '.', 'upper', '(', 'upper', ')', '+', ',', 'upper']);
  a.deepEqual(types('MOVEQ #1,D0'), ['upper', '#', 'int', ',', 'upper']);
});

test('errors are collected, not thrown', a => {
  const { errors } = lex("'unterminated");
  a.equal(errors.length, 1);
  a.match(errors[0].msg, /unterminated string/);
  const r2 = lex('/* never closed');
  a.match(r2.errors[0].msg, /unterminated \/\* comment/);
});

test('string continuation over lines lexes as str + str', a => {
  a.deepEqual(types("'one ' +\n'two'"), ['str', '+', 'nl', 'str']);
});
