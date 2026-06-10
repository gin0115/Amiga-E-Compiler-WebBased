MODULE 'dos/dos'
MODULE '*bhelper'
PROC main()
  WriteF('\d \d \d\n', MODE_NEWFILE, SIZEOF fileinfoblock, triple(9))
ENDPROC
