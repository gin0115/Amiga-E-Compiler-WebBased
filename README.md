# ecomp — the Amiga E compiler for the browser

> The Amiga E language and its v40 module set are the work of
> **Wouter van Oortmerssen**, who has kindly granted permission to use the
> E libraries in this project. Thank you, Wouter! Every binary this
> compiler produces carries that credit embedded in it.

A from-scratch compiler for the **Amiga E** programming language
(E v3.3a, 1997), written in zero-dependency JavaScript. It compiles E
source to genuine AmigaOS M68K hunk executables — in node via a CLI, or
entirely **inside your browser**, where the bundled SAE emulator boots a
real Kickstart 3.1 and runs your program on an emulated A1200.

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

## Quick start: the browser IDE

```sh
python3 -m http.server 8124        # from the repo root
# open http://127.0.0.1:8124/web/ide.html
```

Pick something from the **examples dropdown**, hit **Compile & Boot on
Amiga**, and ~15 seconds later Kickstart 3.1 boots a floppy that was built
in your browser and runs your program on the Amiga screen. Compiles take
a few milliseconds; subsequent runs swap the disk and reset.

The IDE has **file tabs**: `main.e` plus any modules you add with
**+ file**. Files persist in your browser between sessions.

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

1. **IDE**: a `name.e` file tab, compiled into your program
2. **CLI**: a sibling `name.m` binary interface module
3. **CLI**: a sibling `name.e` source, compiled into your program
4. `--moduledir=DIR` directories (binary `.m`)
5. the bundled v40 OS module set (`web/modules/` — `'dos/dos'`,
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

Dev-only (needs the local research corpus, not in git):

- `tools/diff-test.js` — the differential oracle: 115 programs compiled by
  ecomp **and** by the original `ec` v3.3a (running under vamos m68k
  emulation), stdout compared byte-for-byte
- `tools/lex-corpus.js` / `parse-corpus.js` / `codegen-corpus.js` —
  sweeps over 7,000+ real-world E sources harvested from Aminet

## How it works

```
src/lexer.js     tokens (E's case-classified identifiers, nested comments)
src/parser.js    AST  (line-continuation rules, no-precedence chains)
src/sem.js       symbol tables, const folding, object layouts, modules
src/codegen.js   M68K code generation + hand-assembled E runtime
src/asm68k.js    instruction encoder      src/asmtext.js  inline-asm assembler
src/emod.js      binary .m module reader  src/emodwrite.js  .m writer
src/hunk.js      AmigaOS executable       src/adf.js      bootable OFS floppy
web/ide.html     the browser IDE (tabs, examples, SAE wiring)
```

Pure ES modules throughout; a unit test fails the build if anything under
`src/` touches a node API, which is what lets the identical code run
in the browser.

## Provisioning (not in git)

| Path | What | Source |
|---|---|---|
| `web/roms/kick31-a1200-40.68.rom` | Kickstart 3.1 (A1200) | your own ROM dump |
| `web/disks/workbench31-boot.adf` | Workbench 3.1 boot floppy | your own disks |
| `web/vendor/sae/` | SAE emulator engine | github.com/naTmeg/ScriptedAmigaEmulator |
| `research/` | Aminet corpus + reference compilers (dev only) | Aminet `dev/e` |

If the ROM/ADF are missing, the IDE shows an upload panel and stores your
files locally in the browser (Cache API) — nothing is uploaded anywhere.
`web/modules/` (the E v40 modules from
[Aminet dev/e/amigae33a](https://aminet.net/package/dev/e/amigae33a)) **is**
included, with Wouter van Oortmerssen's kind permission.

## Faithfulness notes (oracle-verified against real ec)

Runtime `*` and `/` are 16-bit (`fac(10)` really is -303360); only `x*2`
and `x*4` strength-reduce; `x++` advances by the pointed-to type's size;
`CONST` cannot reference other constants; `EXIT` is illegal in `LOOP`;
`EXCEPT DO` clears `exception` only on normal entry; `DisposeLink`
returns NIL; immediate lists are static and refilled on every evaluation.
See `tools/diff-test.js` for the full executable specification.
