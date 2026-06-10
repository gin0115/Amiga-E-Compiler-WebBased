// Ask the real E v3.3a compiler the lexical questions the docs leave open.
import { oracleCompile, oracleRun, probeExpr, cleanup } from './oracle.js';
import { readFileSync } from 'node:fs';

const works = [];
function report(label, detail) {
  console.log(`${label}\n    ${detail}\n`);
}

// 1. Are string escapes decoded at compile time? Compile WriteF('A\nB') and
// look for the byte sequence 41 0A 42 vs 41 5C 6E 42 in the executable.
{
  const c = oracleCompile("PROC main()\n  WriteF('A\\nB')\nENDPROC\n", 'p1');
  works.push(c.work);
  if (!c.ok) report('1. string \\n storage: COMPILE FAILED', c.out.trim());
  else {
    const buf = readFileSync(c.exe);
    const hasDecoded = buf.includes(Buffer.from([0x41, 0x0a, 0x42]));
    const hasLiteral = buf.includes(Buffer.from([0x41, 0x5c, 0x6e, 0x42]));
    report('1. string escape storage in binary',
      `decoded "A\\x0aB" present: ${hasDecoded}; literal "A\\nB" present: ${hasLiteral}`);
  }
}

// 2. Char const with lone backslash: CASE "\" (corpus pattern). Accepted?
{
  const src = 'PROC main()\n  DEF a\n  a:="\\"\n  SELECT a\n    CASE "\\"\n      a:=1\n  ENDSELECT\nENDPROC\n';
  const c = oracleCompile(src, 'p2');
  works.push(c.work);
  report('2. char const "\\" (raw backslash)', c.ok ? 'ACCEPTED' : `REJECTED: ${c.out.trim().split('\n').pop()}`);
}

// 3. Value of "\n" char const: 10 (escape) or 0x5c6e=23662 (raw bytes)?
{
  const r = oracleRun(probeExpr('"\\n"'), 'p3');
  works.push(r.work);
  report('3. value of "\\n" char const', r.ran ? `= ${r.result}` : `no result (compiled=${r.compiled}) ${r.out.trim().split('\n').pop() ?? ''}`);
}

// 4. Char const longer than 4 chars: error?
{
  const c = oracleCompile('PROC main()\n  DEF a\n  a:="TOOLONG"\nENDPROC\n', 'p4');
  works.push(c.work);
  report('4. char const >4 chars', c.ok ? 'ACCEPTED (!)' : 'REJECTED (as we assumed)');
}

// 5. Unescaped apostrophe inside string (French corpus): WriteF('d'infos')
{
  const c = oracleCompile("PROC main()\n  WriteF('d'infos')\nENDPROC\n", 'p5');
  works.push(c.work);
  report("5. unescaped ' inside string", c.ok ? 'ACCEPTED (!)' : 'REJECTED (as we assumed)');
}

// 6. Latin1 letter in identifier: DEF utilisé
{
  const c = oracleCompile('PROC main()\n  DEF utilis\xe9\n  utilis\xe9:=1\nENDPROC\n', 'p6');
  works.push(c.work);
  report('6. latin1 é in identifier', c.ok ? 'ACCEPTED' : 'REJECTED');
}

// 3b. Is "\\" (escaped backslash) accepted, and what value?
{
  const r = oracleRun(probeExpr('"\\\\"'), 'p3b');
  works.push(r.work);
  report('3b. value of "\\\\" char const (escape processing?)',
    r.ran ? `= ${r.result} (92 would mean escapes ARE processed)` : `compiled=${r.compiled}`);
}

// 7. Sanity: probe machinery itself — value of 1+2*3 (no precedence → 9)
{
  const r = oracleRun(probeExpr('1+2*3'), 'p7');
  works.push(r.work);
  report('7. 1+2*3 (expect 9, left-to-right)', r.ran ? `= ${r.result}` : `no result (compiled=${r.compiled})`);
}

// 8. "1." float form and ".5"
{
  const c = oracleCompile('PROC main()\n  DEF f\n  f:=1.\n  f:=.5\nENDPROC\n', 'p8');
  works.push(c.work);
  report('8. float forms "1." and ".5"', c.ok ? 'ACCEPTED' : `REJECTED: ${c.out.trim().split('\n').pop()}`);
}

for (const w of works) cleanup(w);
