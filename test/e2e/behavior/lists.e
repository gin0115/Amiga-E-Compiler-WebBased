DEF v
PROC main()
  DEF src:PTR TO LONG, dst[10]:LIST, x, y, r
  src := [3,1,4,1,5]
  MapList({v}, src, dst, `v*10)
  FOR v := 0 TO 4 DO WriteF('\d ', dst[v])
  r := src <=> [3,x,4,y,5]
  WriteF('| \d \d \d\n', r, x, y)
ENDPROC
