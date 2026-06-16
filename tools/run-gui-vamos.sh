#!/bin/sh
# Run a compiled Amiga GUI binary under vamos with REAL Kickstart libraries
# (extracted from a ROM via: romtool split <rom> -o <dir>). Reaches as far as
# the Workbench-screen lock (vamos has no display), but proves EasyGUI/intuition
# link correctly. Usage: run-gui-vamos.sh <binary> <libsdir>
BIN="$1"; LIBS="$2"
exec ~/.local/bin/vamos -q -C 68020 -H ignore \
  -O 'graphics.library=mode:fake,version:40' \
  -V "work:$(dirname $BIN)" -V "LIBS:$LIBS" --cwd 'work:' "work:$(basename $BIN)"
