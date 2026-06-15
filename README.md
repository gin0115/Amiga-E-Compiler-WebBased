# ecomp — the Amiga E compiler for the browser

![CI](https://github.com/gin0115/Amiga-E-Compiler-WebBased/actions/workflows/ci.yml/badge.svg)
![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)

> The Amiga E language and its v40 module set are the work of
> **[Wouter van Oortmerssen](https://strlen.com/)**, who has kindly granted
> permission to use the E libraries in this project
> (from [Aminet dev/e/amigae33a](https://aminet.net/package/dev/e/amigae33a)).
> Thank you, Wouter! Every binary this compiler produces carries that
> credit embedded in it.

A from-scratch compiler for the **Amiga E** programming language
(E v3.3a, 1997), written in zero-dependency JavaScript. It compiles E
source to genuine AmigaOS M68K hunk executables and bootable ADF floppy
images — usable as a node CLI or embedded as a pure ES-module library
(it runs in the browser too).

Faithfulness is the core value: behaviour is validated against the
**original 1997 compiler** by a differential test suite (115 programs,
byte-identical output), and ecomp's binary `.m` modules are accepted by
real `ec` itself.

---

## Quick start: the CLI

```sh
node tools/ecc.js --source=hello.e --out=hello
node tools/ecc.js --source=hello.e --adf=hello.adf   # bootable floppy too
```

```
options:
  --out=FILE        output path (default: source without .e)
  -o FILE           same as --out
  --adf=FILE.adf    also write a bootable 880K floppy image that runs
                    the program at boot (mount as DF0: in any emulator)
  --moduledir=DIR   extra directory to search for binary .m modules
                    (repeatable; like ec's EMODULES: assign)
  --warn            print semantic warnings
  --quiet           suppress informational output
  --version, --help
```

A source that declares `OPT MODULE` produces a **binary `.m` interface
module** instead of an executable (and yes, the original Amiga compiler
can import the result).

> **Note:** this repository is the **compiler only** (CLI + embeddable
> JS library). A browser IDE that runs the output on an emulated Amiga
> consumes this as a package and is published separately.

## Using ecomp in your own projects

ecomp is fully self-contained: **no Kickstart ROM, no Workbench disk, no
emulator and no npm packages are needed to compile.** Those images are
only used by the browser IDE to *run* your program on the embedded
emulated Amiga afterwards. The compiler output is a standard AmigaOS
executable you can take to any real Amiga or emulator you like.

**Get it** (any of):

```sh
git clone https://github.com/gin0115/Amiga-E-Compiler-WebBased.git ecomp
# or download a release / the ZIP from GitHub and unpack it anywhere
```

**Compile from your own project directory** — call the CLI by its path,
nothing needs installing:

```sh
cd ~/my-amiga-game
node ~/tools/ecomp/tools/ecc.js --source=game.e --out=game --adf=game.adf
```

`game` is a ready AmigaOS executable; `game.adf` is a bootable floppy that
runs it. Your `MODULE '*mymodule'` files resolve from your project
directory; OS modules (`'dos/dos'`, `'intuition/intuition'`, …) come from
ecomp's bundled `modules/` automatically.

**Use it as a JavaScript library** (node or browser, pure ES modules):

```js
import { parse }          from './ecomp/src/parser.js';
import { analyze }        from './ecomp/src/sem.js';
import { compileProgram } from './ecomp/src/codegen.js';
import { bootableAdf }    from './ecomp/src/adf.js';

const { program, errors } = parse(eSourceText, 'game.e');
const sem = analyze(program /*, { resolveModule } for MODULE imports */);
const { bin } = compileProgram(program, sem);   // Uint8Array: AmigaOS hunk exe
const adf = bootableAdf(bin);                   // Uint8Array: bootable floppy
```

The minimal file set for compiling is `src/` + `tools/` + `modules/`.
Everything else (the IDE, tests, emulator wiring) is optional.

| You want to… | You need |
|---|---|
| compile E → Amiga executables/ADFs | just these files + node ≥16 |
| run the output | any Amiga emulator (or real hardware) |
| watch it run in a browser | the separately published IDE package |

## Multi-file projects

ecomp follows real E's model — you always compile **one main source**, and
it pulls its modules in via `MODULE` statements:

```e
MODULE '*helper'       -> the * means: sibling file in the same directory
PROC main()
  greet('Amiga')
ENDPROC
```

```e
-> helper.e
OPT MODULE
EXPORT PROC greet(who)
  WriteF('hello, \s!\n', who)
ENDPROC
```

```sh
node tools/ecc.js --source=main.e    # helper resolves automatically
```

Resolution order for `MODULE 'name'` / `MODULE '*name'`:

1. a sibling `name.m` binary interface module
2. a sibling `name.e` source, compiled into your program
3. `--moduledir=DIR` directories (binary `.m`)
4. the bundled v40 OS module set (`modules/` — `'dos/dos'`,
   `'intuition/intuition'`, `'exec/lists'`, …)

The exec/dos/intuition/graphics library calls are preloaded implicitly,
exactly like real E — `OpenWindow()`, `ReadArgs()`, `MODE_NEWFILE` and
friends just work without any `MODULE` statement.

## What's implemented

Everything in the E v3.3a manual, including the famous corners:

- no operator precedence (`1+2*3` really is 9), 16-bit runtime `*`/`/`
  with ec's exact strength reductions, full-32-bit constant folding
- E-strings & E-lists with their length headers, `StrCopy`/`StringF`/…
- `OBJECT`s, inheritance, methods with `self`, constructors `NEW b.init()`,
  destructors via `END`, `SIZEOF`
- exceptions: `HANDLE`/`EXCEPT`/`EXCEPT DO` (a finally!), `Raise`, `Throw`
- quoted expressions `` `x*x ``, `Eval`, `MapList`/`ForAll`/`Exists`/`SelectList`
- LISP cells `<a|b>`, `Car`/`Cdr`/`Cons`, unification `exp <=> [1,x,y]`
- IEEE floats with the `!` operator (mathieeesingbas, like the real thing)
- inline M68K assembly with E variable access (ch_15)
- windows, screens, graphics and events: `OpenW`/`OpenS`, `Line`/`Box`/
  `Plot`/`TextF` on `stdrast`, `WaitIMessage`, `Mouse`
- the heap: `NEW`, `New()`, `String()`, `Dispose`, `Link`/`Next` chains,
  auto-free at exit
- 100+ builtins, the dos/exec call surface, `CleanUp`, `CtrlC`, `Rnd`…

## Linking precompiled binary modules (EasyGUI, afc/*, oomodules/*, …)

ecomp doesn't just read a module's *interface* — it **links the actual 68K
code** out of the shipped binary `.m` files into your executable, the same
way the original `ec` does. Importing `tools/EasyGUI`, `afc/Parser`,
`oomodules/*` etc. pulls their compiled procedures straight in, no source
required. This is a small linker on top of the code generator:

- **Code + relocations** — each module's `CODE` blob is appended and its
  `RELOC`s applied (internal pointers rebased into `HUNK_RELOC32`; the
  placeholder `jsr abs.l` ifunc sites patched to `bsr.l` into the runtime).
- **The E runtime intrinsics** the modules call (`WriteF`, `String`, `Mod`,
  `RealF`, `SetColour`, …) are emitted as thunks ported **1-for-1** from
  the original `ec68kifuncs` source and **run-verified byte-identical to
  `ec`** under emulation (`tools/ifunc-verify.js`, 29/29).
- **The ABI matches `ec`.** Precompiled modules bake in `ec`'s fixed
  negative-`A4` offsets for the standard runtime globals (`dosbase` at
  `-44`, `stdout` at `-8`, …), so ecomp lays out `A4` to match — a module
  calling `dos.ReadArgs` finds its base exactly where `ec` put it.
- **OOP across the boundary** — classes from binary modules dispatch through
  their runtime vtable (the per-class "descriptor" the module builds itself):
  `NEW obj.class()` builds the descriptor, allocates, and calls the
  constructor; `obj.method()` dispatches via the slot; `END obj` runs the
  destructor and frees. Reverse-engineered from real `ec` output and written
  up in `docs/oop-dispatch.md`.

148 of the 149 shipped binary code modules link; the lone holdout
(`tools/lisp`) needs a conservative mark-sweep GC that assumes `ec`'s
stack-allocated globals — incompatible with ecomp's static-globals model.

`tools/oop-corpus.js` and `tools/lib-bakeoff.js` tabulate module linking
against the real `ec` oracle.

## Testing

```sh
npm test           # unit: lexer, parser, semantics, M68K encodings
npm run test:e2e   # end-to-end: the ecc CLI on fixture .e files
```

The e2e suite runs the CLI as a subprocess and asserts on artifacts:
hunk structure, embedded strings, **deterministic output**, `.m`
round-trips, multi-file builds, bootable ADF images, flag handling, and
error diagnostics. Both suites run in CI (`.github/workflows/ci.yml`) on
node 16/20/22 — with zero dependencies there is no install step.

A third layer runs in CI as well: the **behavioral suite** compiles
fixture programs and executes the resulting Amiga binaries under vamos
(open-source m68k emulation), comparing stdout against golden outputs
that were verified byte-identical against the original 1997 compiler.

## How it works

```
src/lexer.js     tokens (E's case-classified identifiers, nested comments)
src/parser.js    AST  (line-continuation rules, no-precedence chains)
src/sem.js       symbol tables, const folding, object layouts, modules
src/codegen.js   M68K code generation + hand-assembled E runtime
src/asm68k.js    instruction encoder      src/asmtext.js  inline-asm assembler
src/emod.js      binary .m module reader  src/emodwrite.js  .m writer
src/hunk.js      AmigaOS executable       src/adf.js      bootable OFS floppy
```

Pure ES modules throughout; a unit test fails the build if anything under
`src/` touches a node API, which is what lets the identical code run
in the browser.

## License

GPL-3.0 (see `LICENSE`). **Exception:** `modules/` — the E v40 binary
modules — are copyright **Wouter van Oortmerssen**, included with his
explicitly granted permission, and are *not* relicensed by this project
(see `NOTICE`).

## Faithfulness notes (oracle-verified against real ec)

Runtime `*` and `/` are 16-bit (`fac(10)` really is -303360); only `x*2`
and `x*4` strength-reduce; `x++` advances by the pointed-to type's size;
`CONST` cannot reference other constants; `EXIT` is illegal in `LOOP`;
`EXCEPT DO` clears `exception` only on normal entry; `DisposeLink`
returns NIL; immediate lists are static and refilled on every evaluation.
See `tools/diff-test.js` for the full executable specification.
