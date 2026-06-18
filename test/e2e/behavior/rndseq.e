-> Rnd()/RndQ() must match EC v3.3a byte-for-byte (Galois LFSR, seed starts 0).
PROC main()
  DEF i
  FOR i := 1 TO 8 DO WriteF('\d\n', Rnd(1000))
  WriteF('q=\h\n', RndQ($12345678))
ENDPROC
