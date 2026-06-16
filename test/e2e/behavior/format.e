-> WriteF field-width directives: \d[n] and \h[n] zero-pad, \s[n] space-pads,
-> width is a minimum (never truncates), negative \d prepends sign then pads the
-> magnitude, and \c does NOT take a width (the [n] stays literal) — all matching
-> the original EC v3.3a runtime.
PROC main()
  WriteF('[\d[6]]\n', 42)
  WriteF('[\h[6]]\n', 42)
  WriteF('[\d[6]]\n', -42)
  WriteF('[\h[4]]\n', $1234)
  WriteF('[\d[2]]\n', 123456)
  WriteF('[\s[8]]\n', 'hi')
  WriteF('[\s[2]]\n', 'hello')
  WriteF('\d=\h[4] \d=\h[4]\n', 10, 10, 255, 255)
  WriteF('[\c[4]]\n', 65)
ENDPROC
