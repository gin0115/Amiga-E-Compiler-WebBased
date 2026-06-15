-> {proc} yields a procedure's address (a callback / function pointer, as used
-> by EasyGUI action procs). Each is a distinct, non-zero, even code address.
PROC main()
  DEF fa, fb
  fa := {alpha}
  fb := {beta}
  WriteF('\d \d \d\n', IF fa<>fb THEN 1 ELSE 0, IF (fa>0) AND (fb>0) THEN 1 ELSE 0, fa AND 1)
ENDPROC
PROC alpha()
ENDPROC
PROC beta()
ENDPROC
