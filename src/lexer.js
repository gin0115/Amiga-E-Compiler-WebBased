// Amiga E lexer. Ground truth: amiga-e/docs/reference/ch_1.md (format),
// ch_2.md (immediate values), ch_18.md (grammar, lexical section).
//
// Identifier classification (ch_1C): the first two characters decide the
// class — both uppercase: keyword/constant/asm mnemonic ('upper');
// first lowercase: variable/label/object ('ident');
// first upper + second lower: E builtin or library call ('ecall').

export const KEYWORDS = new Set([
  'AND', 'ARRAY', 'BUT', 'CASE', 'CHAR', 'CONST', 'DEC', 'DEF', 'DEFAULT',
  'DO', 'ELSE', 'ELSEIF', 'END', 'ENDFOR', 'ENDIF', 'ENDLOOP', 'ENDOBJECT',
  'ENDPROC', 'ENDSELECT', 'ENDWHILE', 'ENUM', 'EXCEPT', 'EXIT', 'EXPORT',
  'FOR', 'HANDLE', 'IF', 'INC', 'INCBIN', 'INT', 'IS', 'JUMP', 'LIST', 'LONG',
  'LOOP', 'MODULE', 'NEW', 'NIL', 'OBJECT', 'OF', 'OPT', 'OR', 'PRIVATE',
  'PROC', 'PTR', 'PUBLIC', 'RAISE', 'REPEAT', 'RETURN', 'SELECT', 'SET',
  'SIZEOF', 'STEP', 'STRING', 'SUPER', 'THEN', 'TO', 'UNTIL', 'VOID',
  'WHILE',
  // E-VO negative / extended control flow.
  'IFN', 'ELSEIFN', 'WHILEN', 'ELSEWHILE', 'ELSEWHILEN', 'ALWAYS', 'UNTILN',
  'EXITN', 'CONT', 'CONTN',
  // E-VO unary size/offset operators.
  'PSIZEOF', 'ARRAYSIZE', 'OFFSETOF',
]);

// Compile-time character escapes (ch_2F). Runtime format codes (\d \h \s \c
// \z \l \r and field specs) are NOT in this map: they stay literal in the
// string bytes and are interpreted by WriteF/StringF at runtime.
const ESCAPES = new Map([
  ['n', 10], ['a', 39], ['q', 34], ['e', 27], ['t', 9], ['b', 13],
  ['0', 0], ['\\', 92],
]);

const isDigit = c => c >= '0' && c <= '9';
const isHex = c => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isLower = c => (c >= 'a' && c <= 'z') || c === '_';
const isUpper = c => c >= 'A' && c <= 'Z';
const isIdent = c => isLower(c) || isUpper(c) || isDigit(c);

// Multi-char operators, longest first (maximal munch).
const OPS3 = ['<=>'];
const OPS2 = [':=', '::', '<=', '>=', '<>', '++', '--'];
const OPS1 = '+-*/=<>:.,()[]{}^`!|#\\@&~?';

export function lex(src, filename = '<input>') {
  const tokens = [];
  const errors = [];
  const n = src.length;
  let i = 0, line = 1, col = 1;

  const err = msg => errors.push({ filename, line, col, msg });
  const push = (type, value, raw, startLine, startCol) =>
    tokens.push({ type, value, raw, line: startLine ?? line, col: startCol ?? col });

  const newline = () => { line++; col = 1; };

  function pushNl(l, c) {
    // collapse runs of separators: parser never needs two in a row
    if (tokens.length === 0 || tokens[tokens.length - 1].type === 'nl') return;
    tokens.push({ type: 'nl', value: null, raw: '\n', line: l, col: c });
  }

  while (i < n) {
    const c = src[i];
    const startLine = line, startCol = col, si = i;

    // whitespace (\x1a is the old CP/M-style EOF marker some editors append)
    if (c === ' ' || c === '\t' || c === '\r' || c === '\x0b' || c === '\f' || c === '\x1a') {
      i++; col++;
      continue;
    }

    if (c === '\n') {
      pushNl(line, col);
      i++; newline();
      continue;
    }

    // nested block comments
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1, sawNl = false;
      i += 2; col += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; col += 2; }
        else if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; col += 2; }
        else if (src[i] === '\n') { sawNl = true; i++; newline(); }
        else { i++; col++; }
      }
      if (depth > 0) err('unterminated /* comment');
      // a comment spanning lines still separates statements on those lines
      if (sawNl) pushNl(startLine, startCol);
      continue;
    }

    // line comment: '->' (classic Amiga E) or '//' (E-VO / modern E). The
    // '/*' block comment above is matched first, and a lone '/' still divides.
    if ((c === '-' && src[i + 1] === '>') || (c === '/' && src[i + 1] === '/')) {
      while (i < n && src[i] !== '\n') { i++; col++; }
      continue;
    }

    // string 'bla' — '' or \a is an apostrophe; value keeps runtime format
    // codes literal, decodes only character escapes
    if (c === "'") {
      i++; col++;
      let value = '', raw = '', closed = false;
      while (i < n) {
        const ch = src[i];
        if (ch === "'") {
          if (src[i + 1] === "'") { value += "'"; raw += "''"; i += 2; col += 2; continue; }
          i++; col++; closed = true; break;
        }
        if (ch === '\\') {
          const e = src[i + 1];
          raw += ch + (e ?? '');
          if (ESCAPES.has(e)) value += String.fromCharCode(ESCAPES.get(e));
          else value += '\\' + (e ?? '');
          i += 2; col += 2;
          continue;
        }
        if (ch === '\n') { value += ch; raw += ch; i++; newline(); continue; }
        value += ch; raw += ch; i++; col++;
      }
      if (!closed) err('unterminated string');
      push('str', value, raw, startLine, startCol);
      continue;
    }

    // character constant "FORM" — up to 4 chars packed MSB-first (ch_2E).
    // Oracle-verified vs real ec: escapes ARE processed ("\n"=10, "\\"=92),
    // and a lone backslash ("\") is rejected.
    if (c === '"') {
      i++; col++;
      let bytes = [], closed = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '"') { i++; col++; closed = true; break; }
        if (ch === '\n') break;
        if (ch === '\\') {
          const e = src[i + 1];
          if (ESCAPES.has(e)) bytes.push(ESCAPES.get(e));
          else { err(`bad escape \\${e} in character constant`); bytes.push(e?.charCodeAt(0) ?? 0); }
          i += 2; col += 2;
          continue;
        }
        bytes.push(ch.charCodeAt(0));
        i++; col++;
      }
      if (!closed) err('unterminated character constant');
      if (bytes.length > 4) { err('character constant longer than 4 chars'); bytes = bytes.slice(0, 4); }
      let value = 0;
      for (const b of bytes) value = (value * 256 + b) >>> 0;
      push('char', value, src.slice(si, i), startLine, startCol);
      continue;
    }

    // $hex
    if (c === '$') {
      let j = i + 1, digits = '';
      while (j < n && isHex(src[j])) { digits += src[j]; j++; }
      if (!digits) { err('bad hexadecimal constant'); i++; col++; continue; }
      push('int', parseInt(digits, 16) >>> 0, src.slice(i, j), startLine, startCol);
      col += j - i; i = j;
      continue;
    }

    // %binary
    if (c === '%') {
      let j = i + 1, digits = '';
      while (j < n && (src[j] === '0' || src[j] === '1')) { digits += src[j]; j++; }
      if (!digits) { err('bad binary constant'); i++; col++; continue; }
      push('int', parseInt(digits, 2) >>> 0, src.slice(i, j), startLine, startCol);
      col += j - i; i = j;
      continue;
    }

    // numbers: 42, 3.14, 1., and .5 (ch_2A/2D)
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i;
      while (j < n && isDigit(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.') {
        const after = src[j + 1];
        if (isDigit(after)) {
          isFloat = true; j++;
          while (j < n && isDigit(src[j])) j++;
        } else if (!(isLower(after) || isUpper(after) || after === '.')) {
          isFloat = true; j++; // "1." form
        }
      }
      const raw = src.slice(i, j);
      if (isFloat) push('float', parseFloat(raw), raw, startLine, startCol);
      else push('int', parseInt(raw, 10), raw, startLine, startCol);
      col += j - i; i = j;
      continue;
    }

    // identifiers, keywords, constants, mnemonics
    if (isLower(c) || isUpper(c)) {
      let j = i;
      while (j < n && isIdent(src[j])) j++;
      const raw = src.slice(i, j);
      let type;
      // ch_1C: first two chars decide; '_' and digits do NOT count as
      // lowercase here (T_BALL and D0 are constants, not builtin calls)
      if (isLower(raw[0])) type = 'ident';
      else if (raw.length > 1 && raw[1] >= 'a' && raw[1] <= 'z') type = 'ecall';
      else type = KEYWORDS.has(raw) ? 'kw' : 'upper';
      push(type, raw, raw, startLine, startCol);
      col += j - i; i = j;
      continue;
    }

    // semicolon separates statements just like a newline
    if (c === ';') {
      pushNl(line, col);
      i++; col++;
      continue;
    }

    // operators, maximal munch
    const three = src.slice(i, i + 3);
    if (OPS3.includes(three)) {
      push(three, null, three, startLine, startCol);
      i += 3; col += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      push(two, null, two, startLine, startCol);
      i += 2; col += 2;
      continue;
    }
    if (OPS1.includes(c)) {
      push(c, null, c, startLine, startCol);
      i++; col++;
      continue;
    }

    err(`unexpected character ${JSON.stringify(c)} (0x${c.charCodeAt(0).toString(16)})`);
    i++; col++;
  }

  pushNl(line, col);
  tokens.push({ type: 'eof', value: null, raw: '', line, col });
  return { tokens, errors };
}
