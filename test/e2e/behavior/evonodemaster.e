MODULE 'afc/nodemaster'
OBJECT stuff
  avg
ENDOBJECT
PROC main()
  DEF num:PTR TO nodemaster, l:PTR TO stuff, k
  NEW num.nodemaster()
  FOR k:=1 TO 3
    NEW l
    l.avg:=k*10
    num.add(l)
  ENDFOR
  l:=num.first()
  WHILE l
    WriteF('\d\n', l.avg)
    l:=num.succ()
  ENDWHILE
ENDPROC
