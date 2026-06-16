# Module coverage tracker (ecomp binary code-module sweep)

Goal: every shipped binary code module **buildable** (links) and, where it has a
testable surface, **runs correctly** vs the EC oracle. Status legend:
- `LINKS` compiles+links (minimal import)  
- `RUN?` links, runtime not yet verified  
- `RUN-OK` verified running correctly (vs EC / under vamos)  
- `BUG` reproduced ecomp bug, fixing  
- `NOTE` cannot complete now (reason recorded), moved on

Updated continuously by the /loop sweep. 149 code modules.

## afc (20)

- [ ] `RUN?  ` afc/BeBox
- [ ] `RUN?  ` afc/Bitmapper
- [ ] `RUN?  ` afc/DirList
- [ ] `RUN?  ` afc/Displayer
- [ ] `RUN?  ` afc/IFFParser
- [ ] `RUN?  ` afc/Localer
- [ ] `RUN?  ` afc/Mousepointer
- [ ] `RUN?  ` afc/NodeMaster
- [ ] `RUN?  ` afc/Parser
- [ ] `RUN?  ` afc/ReqTooller
- [ ] `RUN?  ` afc/StringNode
- [ ] `RUN?  ` afc/ToolType
- [ ] `RUN?  ` afc/Worldbuilder
- [ ] `RUN?  ` afc/explain_exception
- [ ] `RUN?  ` afc/hardsprite
- [ ] `RUN?  ` afc/mgui
- [ ] `RUN?  ` afc/rexxer
- [ ] `RUN?  ` afc/super_picture
- [ ] `RUN?  ` afc/tasker
- [ ] `RUN?  ` afc/validPortName

## amigalib (10)

- [ ] `RUN?  ` amigalib/Tasks
- [ ] `RUN?  ` amigalib/argarray
- [ ] `RUN?  ` amigalib/boopsi
- [ ] `RUN?  ` amigalib/cx
- [ ] `RUN?  ` amigalib/interrupts
- [ ] `RUN?  ` amigalib/io
- [x] `RUN-OK` amigalib/lists (newList inits MinList; identical to EC)
- [ ] `RUN?  ` amigalib/ports
- [x] `RUN-OK` amigalib/random (fixed: GLOBS drel binding — RNG seed; rangeRand identical to EC)
- [ ] `RUN?  ` amigalib/time

## class (4)

- [ ] `RUN?  ` class/hash
- [ ] `RUN?  ` class/sc
- [ ] `RUN?  ` class/sctext
- [ ] `RUN?  ` class/stack

## oomodules (35)

> **Status:** cross-module class inheritance now links + binds (integer->number->sort->object chain resolves; 0 unbound jsr $0). Remaining: these classes also do MODULE-INTERNAL NEW that reads class-descriptor pointers from fixed A4 slots the module bakes in (same as afc/StringNode) — a separate descriptor-table layer still to crack. So they link but crash at runtime on the first internal NEW.

- [ ] `RUN?  ` oomodules/commodity
- [ ] `RUN?  ` oomodules/coordinate
- [ ] `RUN?  ` oomodules/coordinate/line
- [ ] `RUN?  ` oomodules/coordinate/polyline
- [ ] `RUN?  ` oomodules/library
- [ ] `RUN?  ` oomodules/library/asl
- [ ] `RUN?  ` oomodules/library/commodities
- [ ] `RUN?  ` oomodules/library/device
- [ ] `RUN?  ` oomodules/library/device/keyboard
- [ ] `RUN?  ` oomodules/library/device/printer
- [ ] `RUN?  ` oomodules/library/device/trackdisk
- [ ] `RUN?  ` oomodules/library/exec/port
- [ ] `RUN?  ` oomodules/library/exec/port/arexxport
- [ ] `RUN?  ` oomodules/library/exec/port/portlist
- [ ] `RUN?  ` oomodules/library/gadtools
- [ ] `RUN?  ` oomodules/library/locale
- [ ] `RUN?  ` oomodules/library/locale/cataloglist
- [ ] `RUN?  ` oomodules/library/reqtools
- [ ] `RUN?  ` oomodules/list/associativearray
- [ ] `RUN?  ` oomodules/list/associativearray/associativestringarray
- [ ] `RUN?  ` oomodules/list/doublylinked
- [ ] `RUN?  ` oomodules/list/elist
- [ ] `RUN?  ` oomodules/list/execlist
- [ ] `RUN?  ` oomodules/list/queuestack
- [ ] `RUN?  ` oomodules/list/stringlist/stringlist
- [ ] `RUN?  ` oomodules/object
- [ ] `RUN?  ` oomodules/sort
- [ ] `RUN?  ` oomodules/sort/address
- [ ] `RUN?  ` oomodules/sort/numbers
- [ ] `RUN?  ` oomodules/sort/numbers/float
- [ ] `RUN?  ` oomodules/sort/numbers/fraction
- [ ] `RUN?  ` oomodules/sort/numbers/integer
- [ ] `RUN?  ` oomodules/sort/numbers/twonumbers
- [ ] `RUN?  ` oomodules/sort/string
- [ ] `RUN?  ` oomodules/sort/string/rawstring

## other (34)

- [ ] `RUN?  ` other/battclock
- [ ] `RUN?  ` other/battmem
- [x] `RUN-OK` other/bitfield (lshr; identical to EC)
- [x] `RUN-OK` other/bits (setBit/toggleBit/bitState identical to EC)
- [ ] `RUN?  ` other/cia
- [ ] `RUN?  ` other/clearlist
- [ ] `RUN?  ` other/cloneworkbench
- [ ] `RUN?  ` other/disk
- [ ] `RUN?  ` other/dispose
- [ ] `RUN?  ` other/disposeelinkedlist
- [ ] `RUN?  ` other/disposelink
- [ ] `RUN?  ` other/dll
- [ ] `RUN?  ` other/ecode
- [ ] `RUN?  ` other/fastinsert
- [x] `RUN-OK` other/initlist (initList; identical to EC)
- [ ] `RUN?  ` other/isdigit
- [x] `RUN-OK` other/isidentifier (identical to EC)
- [ ] `RUN?  ` other/lowerchar
- [ ] `RUN?  ` other/misc
- [x] `RUN-OK` other/mod (identical to EC)
- [ ] `RUN?  ` other/potgo
- [ ] `RUN?  ` other/qualifieditemaddress
- [ ] `RUN?  ` other/readstr
- [ ] `RUN?  ` other/sendexplorer
- [ ] `RUN?  ` other/sendrexx
- [ ] `RUN?  ` other/setprogname
- [x] `RUN-OK` other/skipnonwhite (identical to EC)
- [ ] `RUN?  ` other/skiptochar
- [x] `RUN-OK` other/skiptoedelim (identical to EC)
- [ ] `RUN?  ` other/skipwhite
- [x] `RUN-OK` other/split (argSplit identical to EC)
- [ ] `RUN?  ` other/stack
- [x] `RUN-OK` other/strcopy (strCopy identical to EC)
- [ ] `RUN?  ` other/upperchar

## plugins (14)

- [ ] `RUN?  ` plugins/animcontrol
- [ ] `RUN?  ` plugins/button
- [ ] `RUN?  ` plugins/calendar
- [ ] `RUN?  ` plugins/colorwheel
- [ ] `RUN?  ` plugins/gradient
- [ ] `RUN?  ` plugins/iconify
- [ ] `RUN?  ` plugins/imagebutton
- [ ] `RUN?  ` plugins/led
- [ ] `RUN?  ` plugins/password
- [ ] `RUN?  ` plugins/tabs
- [ ] `RUN?  ` plugins/tapedeck
- [ ] `RUN?  ` plugins/text_plug
- [ ] `RUN?  ` plugins/ticker
- [ ] `RUN?  ` plugins/toolify

## tools (32)

- [ ] `RUN?  ` tools/Boopsi
- [ ] `NOTE  ` tools/EasyGUI — list codegen verified IDENTICAL to EC. Built a real-Kickstart-libs vamos harness (romtool split the ROM -> native-load intuition/gadtools/utility; tools/run-gui-vamos.sh): EC and ecomp behave BYTE-IDENTICAL up to the Workbench-screen lock. The "Egui" is in screen-only code (checkgadget/minsize after GetVisualInfo) which vamos cannot reach (no display). Needs live SAE test, ideally linking tools/EasyGUI_debug (its myraise prints the exact error ref). RELOC32 emitted (6 entries).
- [ ] `RUN?  ` tools/EasyGUI_debug
- [ ] `RUN?  ` tools/EasyGUI_lite
- [ ] `RUN?  ` tools/EasyGUI_notag
- [ ] `RUN?  ` tools/Vector
- [ ] `RUN?  ` tools/arexx
- [ ] `RUN?  ` tools/async
- [ ] `RUN?  ` tools/clonescreen
- [x] `RUN-OK` tools/constructors (newlist/newnode + AddTail; fixed: exec sysbase slot — identical to EC)
- [ ] `RUN?  ` tools/cookrawkey
- [ ] `RUN?  ` tools/copylist
- [x] `RUN-OK` tools/ctype (is*/toupper/tolower identical to EC)
- [ ] `RUN?  ` tools/exceptions
- [x] `RUN-OK` tools/file (readfile/writefile/countstrings; fixed: binary-proc DEFAULT ARGS now captured+emitted — identical to EC)
- [ ] `RUN?  ` tools/filledvector
- [ ] `RUN?  ` tools/ghost
- [ ] `RUN?  ` tools/ilbm
- [ ] `RUN?  ` tools/inithook
- [ ] `RUN?  ` tools/installhook
- [ ] `RUN?  ` tools/iterators
- [ ] `RUN?  ` tools/lisp
- [ ] `NOTE  ` tools/longreal — links+runs, but needs REAL mathieeedoub libraries to verify; under faked libs both EC and ecomp get 0 (IEEEDP* return 0), with a minor dFormat formatting artifact. Re-verify with real-Kickstart-libs harness.
- [ ] `RUN?  ` tools/longrealtiny
- [ ] `RUN?  ` tools/macros
- [ ] `RUN?  ` tools/muicustomclass
- [ ] `RUN?  ` tools/pt
- [ ] `RUN?  ` tools/scrbuffer
- [x] `RUN-OK` tools/simplelex (6 module-private globals + cross-module isalnum call; identical to EC)
- [ ] `RUN?  ` tools/stack
- [ ] `RUN?  ` tools/textlen
- [ ] `RUN?  ` tools/trapguru


---
## SOLVED: class-descriptor table (module-internal NEW)

EC builds EVERY class descriptor at program STARTUP and stores each pointer at a
fixed A4 slot. A class method that internally `NEW`s a sub-object reads that
class's descriptor pointer from its slot via a `move.l ($0,A4),(A0)` placeholder
the linker binds. ecomp previously built descriptors lazily, only at main-level
NEW, so module-internal NEW read empty slots and crashed (jsr through a null
`descriptor[slot]`).

**How EC records the slot references** (the missing piece — verified by
instruction-tracing `oomodules/.../integer` vs ecomp, command-by-command):
- **MODINFO** records CROSS-module descriptor refs, in two flavors:
  1. `jsr abs.L $0` (`4e b9`) — call the parent class's descriptor BUILDER
     (inheritance); patched to `bsr.L moddescr_<parent>`.
  2. `move.l ($0,A4),…` (`20 ac …`) — read the parent class's descriptor
     POINTER from its A4 slot; the 16-bit displacement at `coff` is a `$0`
     placeholder, patched to the parent's descriptor slot.
- **OACC list** (the OBJ-section `[TYP.w][CODE.l]*` access list, previously
  discarded) records SAME-module self/sibling descriptor refs — also `$0`
  displacement placeholders, patched to the class's own descriptor slot.

**Fix** (codegen.js + emod.js + sem.js):
- `emod.js` now captures each class's `oacc` list.
- `emitDescriptorTable()` builds EVERY linked binary class's descriptor at
  startup (just before `bsr proc_main`) into its `__descrptr_<class>` slot.
- `emitBinaryModules()` patches MODINFO flavor-2 refs (to the parent's slot) and
  all OACC refs (to the class's own slot).

Verified by `tools/internal-new-verify.js`: the full integer inheritance chain
(integer→number→sort→object→catalogList→nuArray→string) runs `val=0`, identical
to EC. No regressions (95/95 unit, 4/4 OOP, 29/29 intrinsics, xmod all green).
This unlocks module-internal NEW for the oomodules + complex afc classes; the
remaining oomodule corpus "EC could not build" entries are the synthetic test
harness, not ecomp — each needs a real example program written against it.

## Proc-module sweep status (loop)

Console-verifiable computational/string modules are DONE (RUN-OK, byte-identical to EC):
ctype, split, mod, strCopy, bits, random, isdigit, lowerchar, upperchar, skipwhite,
skiptochar, simplelex, tools/file, isidentifier, skipnonwhite, skiptoedelim, bitfield.

Systemic linker/runtime bugs found+fixed via the sweep: class-descriptor table (PR #8),
GLOBS drel binding (#9), cross-module proc calls (#11), binary-proc DEFAULT ARGS (#14),
WriteF \h hex (#15).

REMAINING proc modules are mostly NOT cleanly verifiable under the faked-libs console
harness — they need real hardware/libraries or complex exec setups:
- exec-list builders/iterators: tools/constructors, tools/iterators, tools/copylist,
  amigalib/lists, other/initlist, other/clearlist, other/fastinsert, other/dll,
  other/disposeelinkedlist. (NOTE: a draft tools/constructors test where EC ran
  clean-but-empty made ecomp CRASH — but the test's exec-list API usage was itself
  wrong, so not a confirmed ecomp bug; revisit with a correct AddTail/traversal test.)
- hardware/device: other/cia, potgo, disk, battclock, battmem, misc, clonescreen,
  cloneworkbench, tools/scrbuffer/clonescreen/pt (need real chips/intuition/display).
- timer/task: amigalib/time, Tasks, ports, interrupts, io, cx.
- double math: tools/longreal/longrealtiny (need real mathieeedoub libs).
These need the real-Kickstart-libs harness (tools/run-gui-vamos.sh) or live SAE, not
the faked console oracle.
