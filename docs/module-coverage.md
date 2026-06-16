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
- [ ] `RUN?  ` amigalib/lists
- [ ] `RUN?  ` amigalib/ports
- [ ] `RUN?  ` amigalib/random
- [ ] `RUN?  ` amigalib/time

## class (4)

- [ ] `RUN?  ` class/hash
- [ ] `RUN?  ` class/sc
- [ ] `RUN?  ` class/sctext
- [ ] `RUN?  ` class/stack

## oomodules (35)

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
- [ ] `RUN?  ` other/bitfield
- [ ] `RUN?  ` other/bits
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
- [ ] `RUN?  ` other/initlist
- [ ] `RUN?  ` other/isdigit
- [ ] `RUN?  ` other/isidentifier
- [ ] `RUN?  ` other/lowerchar
- [ ] `RUN?  ` other/misc
- [ ] `RUN?  ` other/mod
- [ ] `RUN?  ` other/potgo
- [ ] `RUN?  ` other/qualifieditemaddress
- [ ] `RUN?  ` other/readstr
- [ ] `RUN?  ` other/sendexplorer
- [ ] `RUN?  ` other/sendrexx
- [ ] `RUN?  ` other/setprogname
- [ ] `RUN?  ` other/skipnonwhite
- [ ] `RUN?  ` other/skiptochar
- [ ] `RUN?  ` other/skiptoedelim
- [ ] `RUN?  ` other/skipwhite
- [ ] `RUN?  ` other/split
- [ ] `RUN?  ` other/stack
- [ ] `RUN?  ` other/strcopy
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
- [ ] `RUN?  ` tools/constructors
- [ ] `RUN?  ` tools/cookrawkey
- [ ] `RUN?  ` tools/copylist
- [ ] `RUN?  ` tools/ctype
- [ ] `RUN?  ` tools/exceptions
- [ ] `RUN?  ` tools/file
- [ ] `RUN?  ` tools/filledvector
- [ ] `RUN?  ` tools/ghost
- [ ] `RUN?  ` tools/ilbm
- [ ] `RUN?  ` tools/inithook
- [ ] `RUN?  ` tools/installhook
- [ ] `RUN?  ` tools/iterators
- [ ] `RUN?  ` tools/lisp
- [ ] `RUN?  ` tools/longreal
- [ ] `RUN?  ` tools/longrealtiny
- [ ] `RUN?  ` tools/macros
- [ ] `RUN?  ` tools/muicustomclass
- [ ] `RUN?  ` tools/pt
- [ ] `RUN?  ` tools/scrbuffer
- [ ] `RUN?  ` tools/simplelex
- [ ] `RUN?  ` tools/stack
- [ ] `RUN?  ` tools/textlen
- [ ] `RUN?  ` tools/trapguru

