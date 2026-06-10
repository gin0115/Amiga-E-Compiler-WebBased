-> a broad sweep: strings, objects, heap, lists, exceptions, floats
MODULE 'dos/dos'
OBJECT score
  points:LONG, level:INT
ENDOBJECT
PROC bump(n) OF score
  self.points := self.points + n
ENDPROC self.points
PROC main() HANDLE
  DEF s[20]:STRING, p:PTR TO score, l:PTR TO LONG, x
  StrCopy(s, 'abc')
  NEW p
  p.level := 3
  l := [10, 20, 30]
  x := !2.5 * 2.0
  WriteF('\s \d \d \d \d\n', s, p.bump(7), l[1], ListLen(l), MODE_NEWFILE)
  Raise("E2E")
EXCEPT
  WriteF('caught \d\n', exception)
ENDPROC
