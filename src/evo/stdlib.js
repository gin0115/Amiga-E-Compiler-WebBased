// E-VO standard-library functions, written in Amiga E. Activated only in evo
// mode: parse() compiles this source once and injects the *referenced* procs
// into the user program (transitively), so e.g. StrAddChar resolves to a real
// proc. Keeping them in E (not hand-coded asm) makes the stdlib maintainable
// and lets ecomp's own codegen + the differential tests cover them.
//
// These mirror the E-VO library semantics (verified against the EVO oracle).
// estring helpers (EstrLen/StrMax/SetStr/StrCopy/StrLen/String) and the EVO
// char/memory builtins (LowerChar/UpperChar/PutChar/…) are provided by ecomp.
export const EVO_STDLIB_SRC = `
-> ===== String family =====

PROC StrCompare(s1:PTR TO CHAR, s2:PTR TO CHAR, len=-1)
  DEF i=0, a, b
  WHILE (len=-1) OR (i<len)
    a:=s1[i]; b:=s2[i]
    IF a<>b
      IF a<b THEN RETURN -1
      RETURN 1
    ENDIF
    IF a=0 THEN RETURN 0
    i:=i+1
  ENDWHILE
ENDPROC 0

PROC StriCmp(s1:PTR TO CHAR, s2:PTR TO CHAR, len=-1)
  DEF i=0, a, b
  WHILE (len=-1) OR (i<len)
    a:=LowerChar(s1[i]); b:=LowerChar(s2[i])
    IF a<>b THEN RETURN FALSE
    IF a=0 THEN RETURN TRUE
    i:=i+1
  ENDWHILE
ENDPROC TRUE

PROC StrAddChar(s:PTR TO CHAR, c)
  DEF len
  len:=EstrLen(s)
  IF len<StrMax(s)
    s[len]:=c
    SetStr(s, len+1)
  ENDIF
ENDPROC

PROC StrClone(src:PTR TO CHAR)
  DEF len, d:PTR TO CHAR
  len:=StrLen(src)
  d:=String(len)
  IF d THEN StrCopy(d, src)
ENDPROC d

PROC StrIns(s:PTR TO CHAR, ins:PTR TO CHAR, pos)
  DEF slen, ilen, max, i, nl, d
  slen:=EstrLen(s); ilen:=StrLen(ins); max:=StrMax(s)
  -> shift the tail right by ilen (clamped to max), then drop in ins
  FOR i:=slen-1 TO pos STEP -1
    d:=i+ilen
    IF d<max THEN s[d]:=s[i]
  ENDFOR
  FOR i:=0 TO ilen-1
    d:=pos+i
    IF d<max THEN s[d]:=ins[i]
  ENDFOR
  nl:=slen+ilen
  IF nl>max THEN nl:=max
  SetStr(s, nl)
ENDPROC

PROC StrRem(s:PTR TO CHAR, pos, count=-1)
  DEF slen, i, n
  slen:=EstrLen(s)
  IF count=-1 THEN count:=slen-pos
  n:=slen-(pos+count)
  IF n<0 THEN n:=0
  FOR i:=0 TO n-1
    s[pos+i]:=s[pos+count+i]
  ENDFOR
  SetStr(s, pos+n)
ENDPROC

PROC EndsWith(s:PTR TO CHAR, suf:PTR TO CHAR)
  DEF sl, fl, i
  sl:=StrLen(s); fl:=StrLen(suf)
  IF fl>sl THEN RETURN FALSE
  FOR i:=0 TO fl-1
    IF s[sl-fl+i]<>suf[i] THEN RETURN FALSE
  ENDFOR
ENDPROC TRUE

PROC CharInStr(s:PTR TO CHAR, c, start=0)
  DEF i
  i:=start
  WHILE s[i]
    IF s[i]=c THEN RETURN i
    i:=i+1
  ENDWHILE
ENDPROC -1

PROC CharInStri(s:PTR TO CHAR, c, start=0)
  DEF i, lc
  lc:=LowerChar(c); i:=start
  WHILE s[i]
    IF LowerChar(s[i])=lc THEN RETURN i
    i:=i+1
  ENDWHILE
ENDPROC -1

PROC InStri(s:PTR TO CHAR, sub:PTR TO CHAR, start=0)
  DEF i, j, sl, bl
  sl:=StrLen(s); bl:=StrLen(sub)
  i:=start
  WHILE i+bl<=sl
    j:=0
    WHILE (j<bl) AND (LowerChar(s[i+j])=LowerChar(sub[j]))
      j:=j+1
    ENDWHILE
    IF j=bl THEN RETURN i
    i:=i+1
  ENDWHILE
ENDPROC -1
`;
