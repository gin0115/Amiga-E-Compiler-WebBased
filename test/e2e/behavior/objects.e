OBJECT counter
  n:LONG
ENDOBJECT
PROC bump(by) OF counter
  self.n := self.n + by
ENDPROC self.n
PROC main()
  DEF c:PTR TO counter
  NEW c.bump(5)
  WriteF('\d \d \d\n', c.bump(10), c.n, SIZEOF counter)
  END c
ENDPROC
