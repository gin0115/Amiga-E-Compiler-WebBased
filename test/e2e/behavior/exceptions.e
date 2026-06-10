PROC risky(n) HANDLE
  IF n THEN Raise("BOOM")
  WriteF('safe\n')
EXCEPT DO
  WriteF('finally exc=\d\n', exception)
ENDPROC 99
PROC main()
  WriteF('\d \d\n', risky(0), risky(1))
ENDPROC
