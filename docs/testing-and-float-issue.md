# Differential testing (vamos + EC) & the floating-point / SAE issue

## 1. The three pieces

| Tool | What it is | Role |
|---|---|---|
| **ecomp** | The new Amiga E compiler, written in JS. Runs in the browser IDE and via a Node CLI (`tools/ecc.js`). | **The thing under test.** |
| **EC v3.3a** | Wouter van Oortmerssen's original 1997 Amiga E compiler (`ECDEMO`) — itself an Amiga m68k executable. | **The oracle / ground truth.** The reference definition of "correct". |
| **vamos** | From `amitools` (`pip install amitools`). An m68k CPU emulator + an AmigaOS API shim (exec/dos/…) that runs Amiga executables **on the host (Linux), with no Kickstart ROM**. | **The neutral execution harness** for both compilers' output. |

The key insight that makes validation possible: vamos can run **both** the EC binary *and* ecomp's binaries on the same host. So we can compile the *same* `.e` source two ways and compare the results — EC defines "correct", ecomp must match it.

## 2. The differential-testing loop

For a given `prog.e`:

1. **Oracle build** — run EC *inside vamos* to compile the source to an Amiga binary (EC is itself an Amiga program, so vamos runs it):
   ```
   vamos -q -V work:<W> -V mods:<MODS> -a emodules:work:+mods: \
         -V bin:<ec33a-dir> --cwd work: bin:EC prog.e
   ```
   This produces the **reference** binary.
2. **ecomp build** — compile the same source natively with Node:
   ```
   node tools/ecc.js --source=prog.e --moduledir=<MODS>
   ```
3. **Run both under vamos** with faked libraries, capturing stdout:
   ```
   vamos -q -O '*.library=mode:fake,version:40+dos.library=mode:auto+exec.library=mode:auto' \
         -V work:<W> --cwd work: work:<binary>
   ```
4. **Compare stdout.**
   - Identical → ecomp is correct for that case.
   - Different → **ecomp has a bug.** Per the test-discipline rule we assume ecomp is wrong first — never "fix" the oracle.

Byte-identical *linked output* is a bonus where achievable; **behaviour-identical under vamos is the hard gate.**

## 3. Where this lives in the repo

| File | What it does |
|---|---|
| `tools/diff-test.js` | Main differential harness: **115 cases**, each compiled by EC *and* ecomp, run under vamos, stdout compared. `--emit=FILE` snapshots EC's outputs into a committed goldens file so cases can later be replayed without the EC oracle. |
| `tools/_cmp_build.mjs` | Small `parse → analyze → compileProgram → writeHunk` helper that builds a single ecomp binary for the verify scripts. Usage: `node tools/_cmp_build.mjs <src.e> <out> <workdir> <moduledir>`. |
| `test/e2e/run-link.js` | Links programs against **pre-built binary `.m` modules** (built by EC), runs under vamos, compares to `.expected` goldens (`answer`, `mul`, `thirdparty`). Exercises the *linker*, not codegen. |
| `test/e2e/run-behavior.js` | CI-runnable goldens (`arith`, `control`, `floats`, `format`, `objects`, …): compile with ecomp, run under vamos, compare to EC-verified `.expected` files. **No EC needed at test time.** |
| `test/run.js` | Pure unit tests (lexer/parser/sem/asm68k/emod/adf/codegen). |
| `tools/*-verify.js` | Per-feature verifiers (`cpu68000-verify`, `internal-new-verify`, `easygui-verify`, `file-verify`, …) — each builds with EC + ecomp and compares a specific feature. |

Current totals, all green: **100 unit · 14 e2e · 10 behavior · 3 link · 115 differential.**

## 4. The critical limitation of the vamos oracle

vamos **fakes/abstracts** the Amiga libraries and emulates an idealised CPU (with math/FPU behaviour available). The **live IDE** instead runs the real **Kickstart 3.1 ROM** under **SAE** (Scripted Amiga Emulator, https://github.com/naTmeg/ScriptedAmigaEmulator), emulating an **A1200 = 68EC020 with no FPU**.

So a binary can be **correct under vamos yet crash on real Kickstart/SAE.** The differential suite proves ecomp emits the *same code EC does*; it does **not** prove that code runs on a given real-Amiga emulator configuration. Those are two different questions:

- "Does ecomp match EC?" → answered by **vamos + the differential suite** (yes).
- "Does the output run on the IDE's SAE/Kickstart target?" → a separate, environment-level question.

## 5. The floating-point issue

### Symptom
The `float` gallery example (and any program using E's `!` float operators or `Fsqrt`) **crashes with `Software Failure #8000000B`** in the live IDE — under both "Compile & Run (DOS)" and "Compile & Run (WB)".

### What we verified
1. **ecomp is correct.** Under vamos, ecomp's `float` is **byte-for-byte identical in output to EC**:
   `2.5*4.0 = 10, sqrt(2.25) = 1`. ecomp compiles E float to the standard **`mathieeesingbas.library`** (single-basic) and **`mathieeesingtrans.library`** (single-trans, for `Fsqrt`) calls — exactly as EC does.
2. **The reference compiler crashes too.** An **EC-compiled** float binary, booted on the same SAE/Kickstart (test disk `disks/float-ec-test.adf`), gives the **identical `#8000000B`**. → This is **not** an ecomp regression. (This was the decisive test — the user suspected float worked "before the linker work", but EC's own float fails identically, ruling ecomp out.)
3. **Not a missing library.** `mathieeesingbas.library` is **in the Kickstart 3.1 ROM** (string `mathieeesingbas 40.4` present); `mathieeesingtrans.library` is on the Workbench disk's `LIBS:`. Both are available.
4. **Not relocations.** The float binary has **zero `HUNK_RELOC32`** entries, so the linker work didn't add anything that real `LoadSeg` could mishandle.
5. **Even the simplest float fails.** A multiply-only program (`2.5 * 4.0`, **no** transcendentals — touches only `mathieeesingbas`) also crashes `#8000000B` (test disk `disks/floatmul-ec-test.adf`). So it is not specific to `Fsqrt`/`mathieeesingtrans`.

### Root cause (current understanding)
`#8000000B` is **CPU exception vector 11 = Line-F** (opcodes `$Fxxx` — the 68881/68882 FPU / coprocessor space). In SAE's CPU core (`vendor/sae/sae/cpu.js`, function `illegal()`), any `$Fxxx` opcode is turned into `coreException(0xB)`:
```js
if ((opcode & 0xF000) == 0xF000) {
    ... SAEF_log("cpu.illegal() B-Trap %04X at %08X ...");
    coreException(0xB);   // line-F -> #8000000B if uncaught
}
```
So float execution reaches an **`$Fxxx` (FPU) instruction** that SAE cannot run, because **SAE has no FPU emulation** — its `fpu` config block in `vendor/sae/sae/config.js` is commented out and marked `/* future */`; there is essentially no FP-instruction code in `cpu.js`.

Where the `$Fxxx` originates is **not yet pinned down** (the next diagnostic step, paused at the user's request): ecomp/EC's own code only emits library *calls* (`jsr`), so the FPU opcode is coming from **inside the ROM math library path** — either the library genuinely executes FPU instructions on this CPU config, or an **FPU-detection probe** (deliberately executing an FPU op to see if it traps) is escalating to a Guru because SAE's line-F **exception delivery** doesn't behave like real hardware. SAE logs the offending opcode + PC at the line above, but only when `SAEV_config.debug.level >= Log` (the IDE runs it silent), so capturing it needs the debug level raised or a temporary unconditional log at that point.

### Options
1. **Capture the trapping opcode** (raise SAE debug level / temporary log at `cpu.js` line-F handler) → identify whether it's a real FP instruction or a detection probe. *This is the unfinished diagnostic.*
2. **If it's a real FP-instruction need:** implement FPU (line-F) emulation in the SAE fork (`gin0115/ScriptedAmigaEmulator`) — a substantial feature: the 68881/68882 instruction set (`FMOVE/FADD/FMUL/FDIV/FSQRT/Fxxx`), FP register file and formats. Could be done as a subset covering what the math libraries use.
3. **If it's a line-F exception-delivery bug:** fix SAE's exception vectoring/`RTE` for vector 11 so the OS's own handler catches the probe (smaller fix).
4. **Route around it:** make E float use `mathffp.library` (Motorola FFP, pure-software, ROM-resident) instead of IEEE — a compiler/runtime change, but keeps float off the FPU path entirely.
5. **Document the limitation:** mark `float` as needing an FPU-class emulator (or vamos) and move on.

### Bottom line
- **ecomp is doing the right thing** — byte-identical to EC, using the standard IEEE software math libraries.
- The wall is **SAE's lack of FPU/line-F emulation** on the A1200 (68EC020) target, *not* the compiler.
- Non-float programs are unaffected (the four games, the module examples, etc. run on SAE).

## 6. Useful commands (quick reference)

```bash
# full ecomp test matrix
node test/run.js                 # unit
node test/e2e/run-e2e.js         # CLI/flags
node test/e2e/run-behavior.js    # behaviour goldens (vamos, no EC)
node test/e2e/run-link.js        # binary-module link goldens (vamos)
node tools/diff-test.js          # 115-case differential vs EC (needs EC + vamos)

# build one ecomp binary for ad-hoc comparison
node tools/_cmp_build.mjs <src.e> <out> <workdir> <moduledir>

# EC oracle build of a single source (inside vamos)
vamos -q -V work:<W> -V mods:<MODS> -a emodules:work:+mods: \
      -V bin:<ec33a-dir> --cwd work: bin:EC <src>.e
```

---

# 7. SESSION HANDOFF — environment, locations, and how to continue

## 7.1 Repos & live deployment
- **IDE repo:** `/media/glynn/2024/devilbox_public/ai-detective/amiga-ide` → GitHub `git@github.com:gin0115/Amiga-E-Web-IDE.git`. Deployed live at **https://ai-detective.gq/amiga-ide/** and **https://amiga-e.com/**. *The live site serves straight from this working tree* — editing files here and reloading the page shows the change live (no build step for index.html / vendor / ecomp). You cannot access local-dev URLs; use the two live URLs.
- **ecomp** (the compiler) lives as a submodule at `amiga-ide/ecomp` → GitHub `git@github.com:gin0115/Amiga-E-Compiler-WebBased.git`. This is the copy the IDE loads and that all the `node test/...` commands above run against. (`.gitmodules` has `ignore = all` on it so the submodule pointer is never accidentally committed into the IDE repo — keep it that way; commit ecomp and IDE **separately**.)
- **Docs submodule:** `amiga-ide/docs` (the public Amiga-E-Docs-Site). Don't push private docs/examples there.

## 7.2 Toolchain locations
- **vamos:** `~/.local/bin/vamos` (amitools). Also `~/.local/bin/xdftool` for ADF read/write/list.
- **EC oracle (ECDEMO v3.3a):** `<research>/extracted/ec33a/ec33a` where `<research>` = `/media/glynn/2024/devilbox_public/ai-detective/amiga-e/research`. Run EC *inside vamos* with `-V bin:<that dir> ... bin:EC`.
- **modules dir** (shipped binary `.m`): `amiga-ide/ecomp/modules`.
- **Kickstart ROM:** `amiga-e/roms/kick31-a1200-40.68.rom` (also in the IDE disk box). It IS a real 68EC020 A1200 ROM — no FPU.
- **`/tmp/psw`** holds the path of a persistent vamos work dir (pre-created work files live there). `W=$(cat /tmp/psw)` in the harness commands.
- **FAKE libs string** for running under vamos: `'*.library=mode:fake,version:40+dos.library=mode:auto+exec.library=mode:auto'` (add `+mathieeesingbas.library=mode:auto+mathieeesingtrans.library=mode:auto` for float).

## 7.3 The SAE emulator (where the float fix would go)
- **Upstream:** `github.com/naTmeg/ScriptedAmigaEmulator` (GPL-2, unmaintained for years).
- **Fork to work in:** `github.com/gin0115/ScriptedAmigaEmulator` — **cloned at `amiga-ide/vendor/ScriptedAmigaEmulator`** (branch `master`, full repo incl. `disass.js`/`disass.htm` which are useful for disassembling Amiga code). No commits made to the fork yet.
- **IMPORTANT — what the IDE actually loads:** the live IDE uses a *separate vendored copy* at **`amiga-ide/vendor/sae/sae/*.js`** (NOT the fork clone). So to test an SAE change live: edit `vendor/sae/sae/<file>.js`, reload the IDE. To preserve the change: also apply it in `vendor/ScriptedAmigaEmulator` and push to the fork. (`vendor/` is git-ignored in the IDE repo.)
- Key CPU files: `vendor/sae/sae/cpu.js` (~10k lines, the 68000/010/020/030 core), `m68k.js`, `config.js` (the `fpu` block is commented `/* future */` — **no FPU emulation exists**).

## 7.4 The float blocker — exact state & the ONE next step
- All float (E `!` ops, `Fsqrt`) Gurus with **`#8000000B`** = CPU **line-F** (vector 11, `$Fxxx`/FPU opcodes) on the IDE's SAE+Kickstart. ecomp is byte-identical to EC and **EC's own float crashes identically** → it's the emulator, not the compiler (see §5).
- **The paused diagnostic (do this first in the new session):** find out *which* `$Fxxx` opcode traps and *where*. SAE logs it in `vendor/sae/sae/cpu.js` in `function illegal()` at the `if ((opcode & 0xF000) == 0xF000)` branch (~line 1651):
  ```js
  SAEF_log("cpu.illegal() B-Trap %04X at %08X -> %08X (VBR %08X)", opcode, pc, ...);
  ```
  …but `SAEF_log` only prints when `SAEV_config.debug.level >= SAEC_Config_Debug_Level_Log` (the IDE runs silent). **To capture it:** either raise that debug level, or temporarily replace that `SAEF_log(...)` with an unconditional `console.error(...)` of `opcode`+`pc`, reload `ai-detective.gq/amiga-ide`, run a float program (`PROC main()\n DEF x,a\n x:=!2.5*4.0\n a:=!x!\n WriteF('\\d\\n',a)\nENDPROC`), and read the browser console for the F-line opcode + PC. **Revert the edit after** (vendor/sae is the live-served copy — the user is strict about not leaving debug edits in).
  - If the opcode is a real FP instruction (`$F2xx` cpGEN etc.) → route 2: implement an FPU subset in the fork.
  - If it's a one-off probe and the PC is in OS/library detection code → route 3: fix SAE's line-F **exception delivery** (vector 11 / RTE) so the OS handler catches it.
- **Test disks already built** in `amiga-ide/disks/`: `float-ec-test.adf` (EC full float, auto-runs on boot), `floatmul-ec-test.adf` (EC multiply-only float). Both Guru `#8000000B` on SAE. (`spaceinvaders.adf` is a leftover game disk.)

## 7.5 Git / build state at handoff
- **ecomp:** PR #20 merged to `main` (68000-safe linking, ADF extension blocks, WriteF field-width `\d[n]/\h[n]/\s[n]`, build stats, `__readstr` fix, `--emit` golden mode, new adf/codegen/format/thirdparty tests). Local `main`, clean. **242/242 tests green.**
- **IDE:** PR #16 merged to `main` (custom `.m` module import + verbose link log; four games — breakout/snake/invaders/asteroids — that open their **own screen via `OpenS`** with a player-picked size 320×256/640×256/640×512-laced; `.gitmodules ignore=all`). Local `main`, clean.
- **SAE fork:** cloned, no changes/commits yet.
- Open product item: the **float/SAE blocker** above. Also pending (from earlier this session, not started): converting the *drawing* gallery demos (life/primes/spiro/gfx/catchbox) to open their **own 640×256 screen via `OpenS`** (decided: fixed 640×256, no picker) so they aren't cramped on the Workbench screen.

## 7.6 House rules carried over
- **Ask before any git/gh/npm/composer/mysql command, every time.** Commit only when asked; never push to `main`/protected branches directly — feature branch + PR + merge.
- ecomp and IDE are **separate repos**; never stage the `ecomp` submodule pointer into the IDE.
- vamos proves *ecomp == EC*; it does **not** prove the output runs on SAE/real Kickstart (the float lesson). Visual GUI things are confirmed by the user in the live IDE (synthetic clicks/keys don't register in the SAE canvas).

