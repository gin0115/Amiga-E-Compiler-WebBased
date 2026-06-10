PROC main()
  DEF s[30]:STRING, t[30]:STRING
  StrCopy(s, 'Hello')
  StrAdd(s, ' World')
  MidStr(t, 'abcdefgh', 2, 3)
  UpperStr(t)
  WriteF('\s \d \s \d\n', s, EstrLen(s), t, StrCmp(s, s))
ENDPROC
