-> Links a third-party binary module (mymath.m) that is NOT part of the shipped
-> module set — the same path a user-imported .m takes. mymath was compiled from
-> source by the real EC; ecomp links its gcd/fib/ipow procs into this program.
MODULE 'mymath'
PROC main()
  DEF i
  WriteF('gcd(48,36)=\d  gcd(1071,462)=\d\n', gcd(48,36), gcd(1071,462))
  WriteF('fib:')
  FOR i := 0 TO 12 DO WriteF(' \d', fib(i))
  WriteF('\n')
  WriteF('ipow(2,10)=\d  ipow(3,5)=\d\n', ipow(2,10), ipow(3,5))
ENDPROC
