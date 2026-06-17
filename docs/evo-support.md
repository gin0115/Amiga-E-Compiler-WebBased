# E-VO support (modern Amiga E)

ecomp's core targets **classic EC v3.3a** (1997, Wouter van Oortmerssen). On top
of that it has an **optional E-VO extension** — the modern Amiga E dialect of
**[Darren Coles' E-VO compiler](https://github.com/dmcoles/EVO)** (v3.9.x,
public domain) — that adds many language features and a larger standard library.

E-VO support is **opt-in behind a flag** and lives entirely in **`src/evo/`**.
With the flag off (the default) ecomp is faithful EC v3.3a; with it on, ecomp
accepts the modern language as a strict superset.

## Enabling it

```js
import { parse }          from './src/parser.js';
import { analyze }        from './src/sem.js';
import { compileProgram } from './src/codegen.js';

const { program } = parse(src, 'main.e', { evo: true });   // <-- evo flag
const sem         = analyze(program, { evo: true, resolveModule });
const { bin }     = compileProgram(program, sem);
```

CLI / differential harness: pass `evo` as the 5th arg to `tools/_cmp_build.mjs`:

```sh
node tools/_cmp_build.mjs prog.e prog work: ./modules evo
```

Default (no flag) = **native EC v3.3a**: all the EVO syntax below is rejected
exactly as the original compiler rejects it, and classic programs compile
byte-for-byte identically whether the flag is on or off.

## Language features (evo mode)

| Feature | Example |
|---|---|
| `//` line comments | `x := 1   // comment` |
| Shift operators | `a << 2`, `a >> 1` |
| Unary bitwise NOT | `NOT x`, `~x` |
| Bitwise `&` / `\|\|` | `a & $0F`, `a \|\| 1` (= AND / OR) |
| Compound assignment | `+= -= *= /= AND= OR= <<= >>=` |
| Short-circuit booleans | `a ANDALSO b`, `a ORELSE b` |
| Negative/extended control flow | `IFN`, `ELSEIFN`, `WHILEN`, `ELSEWHILE[N]`, `ALWAYS`, `UNTILN`, `EXITN`, `CONT`, `CONTN` |
| Block exceptions | `TRY … CATCH … ENDTRY` (+ `Throw`, `exceptioninfo`, `ReThrow`) |
| C-style ternary | `x > 3 ? 100 : 200` |
| Swap operator | `a :=: b` |
| Quick-compare | `x == [5, 10 TO 20, 100]` |
| Multi-dimensional arrays | `DEF m[3][3]:ARRAY OF LONG`, `m[i][j]` |
| Object `UNION` | overlapping member groups |
| `NEW objtype[.ctor(args)]` | `n := NEW aobj.create()` |
| New primitive types | `BYTE` (signed 8-bit), `WORD` (unsigned 16-bit) |
| Size/offset operators | `PSIZEOF`, `ARRAYSIZE [dim,]var`, `OFFSETOF objtype.member` |
| Extra string escapes | `\!` (bell), `\xNN` (hex) |
| `\u` format code | unsigned 32-bit decimal in `WriteF`/`StringF` |
| `_SRCLINE_` macro | current source line number |

## Standard library (evo mode)

The E-VO stdlib functions are provided two ways, both reached only in evo mode:

- **Asm builtins** (`src/evo/codegen.js`): `MemFill`, `MemCompare`, `List`,
  `SetList`, `AstringF`, the inline integer/char/memory ops (`And`, `Or`,
  `Lsl`, `Lsr`, `Rol`, `Ror`, `Sign`, `Div`, `Compare`, `Ucompare`,
  `UpperChar`, `LowerChar`, `Byte`, `Word`, `PutByte/Char/Int/Word/Long`),
  and the quote-list `SelectFirst`.
- **Written in E** (`src/evo/stdlib.js`): the String family (`StrCompare`,
  `StriCmp`, `StrAddChar`, `StrClone`, `StrIns`, `StrRem`, `EndsWith`,
  `CharInStr`, `CharInStri`, `InStri`), the List family (`ListCopy`,
  `ListAdd`, `ListAddItem`, `ListInsItem`, `ListRemItem`, `ListSwapItem`,
  `ListItem`, `ListCmp`, `ListClone`), the Astr family (`AstrCopy`,
  `AstpCopy`, `AstrClone`) and `RealF`. `parse()` compiles this source once
  and injects only the *referenced* procs (transitively) into the program.

## Architecture

```
src/evo/
  keywords.js   EVO-only keywords (folded into the lexer set only when evo)
  codegen.js    EVO asm builtins (evoBuiltin) + runtime routines (emitEvoRuntime)
  stdlib.js     EVO stdlib written in Amiga E, injected by parse()
```

The core (`lexer.js`, `parser.js`, `sem.js`, `codegen.js`) carries an `evo`
flag and calls into `src/evo/` only when it is set. Keyword-based features
auto-disable in native mode (they lex as ordinary identifiers); symbol-based
ones (`+=`, `<<`, `?:`, …) guard on `this.evo`.

## Validation — three compilers

E-VO support was built and verified against **all three compilers**:

1. **ecomp** (this project, JS) — `node test/run.js`, differential suite.
2. **EC v3.3a** (the original, under vamos) — the native-mode oracle.
3. **E-VO** (Darren Coles', assembled from `E-VO.S` with `vasm`, run under
   vamos) — the modern-mode oracle.

Every feature and stdlib function was checked byte-for-byte against the EVO
oracle. The full E-VO `unittests.e` (741 tests) compiled by ecomp in evo mode
and run under vamos: **732 pass / 9 fail, no crash** — versus EVO's own
**731 pass / 10 fail**. ecomp's 9 failures are a strict subset of EVO's
(vamos-environment quirks: faked-FPU float add, and `StringF`/`AstringF`
hex/decimal field-alignment — which EVO's own assertions also fail under
vamos); ecomp additionally passes one case EVO fails.

Native mode is unaffected throughout: **115/115 differential vs the EC oracle,
102/102 unit, 14/14 e2e**, and classic programs are byte-identical with the
flag on or off.

> E-VO and its support programs are public domain (Darren Coles): "use without
> restriction … at your own risk." Its language semantics are mirrored here;
> no E-VO code is copied.
