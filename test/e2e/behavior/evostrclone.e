-> evo
-> E-VO StrClone must clone the source's CAPACITY (StrMax), not just its
-> length, so a later StrAdd has room to grow -- matching real E-VO.
PROC main()
  DEF a[20]:STRING, c
  StrCopy(a, 'amiga')
  c := StrClone(a)
  WriteF('clone="\s" len=\d max=\d\n', c, StrLen(c), StrMax(c))
  StrAdd(c, '-rocks')
  WriteF('after StrAdd: "\s" len=\d max=\d\n', c, StrLen(c), StrMax(c))
ENDPROC
