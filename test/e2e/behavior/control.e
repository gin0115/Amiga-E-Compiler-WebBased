PROC fib(n)
  IF n<2 THEN RETURN n
ENDPROC fib(n-1)+fib(n-2)
PROC main()
  DEF i
  FOR i:=0 TO 10 DO WriteF('\d ', fib(i))
  WriteF('\n')
  SELECT 3
    CASE 1
      WriteF('one\n')
    CASE 3
      WriteF('three\n')
    DEFAULT
      WriteF('other\n')
  ENDSELECT
ENDPROC
