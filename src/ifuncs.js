// E intrinsic-function ("ifunc") table — the ordered list of compiler builtins.
// When the original compiler builds a MODULE, calls to these builtins can't be
// resolved until the module is linked into a program (which carries the runtime
// that implements them), so it emits a placeholder `jsr abs.L` and a reloc with
// bit31 set; the ifunc number is encoded in the call site. At link time the
// linker patches `jsr.l` (0x4EB9) -> `bsr.l` (0x61FF) targeting the runtime
// implementation.
//
// Source of truth: ECX 2.3.1 ecxmain.e (the IFUNCDEF table). The first entry,
// WriteF, is ifunc number 10, so IFUNCS[number - 10] gives the name. Names with
// a leading '#' are deprecated/internal slots kept for numbering. The v3.3a /
// v40 module set only uses numbers up to ~140.
export const IFUNC_BASE = 10;

export const IFUNCS = [
  'WriteF', 'Mul', 'Div', 'OpenW', 'OpenS', 'Mouse', 'Plot', 'Line', 'TextF', 'Colour', // 10-19
  'SetStdRast', 'SetStdOut', 'Long', 'Int', 'Char', 'PutLong', 'PutInt', 'PutChar', 'New', 'CleanUp', // 20-29
  'CloseW', 'CloseS', 'And', 'Or', '#Not_OLD', 'Gadget', 'SetTopaz', 'StrCmp', 'StrCopy', 'StrAdd', // 30-39
  'StrLen', 'EstrLen', 'StrMax', '#String_OLD', 'RightStr', 'MidStr', 'StringF', 'Val', 'InStr', 'TrimStr', // 40-49
  'UpperStr', 'LowerStr', 'ReadStr', 'Out', 'Inp', 'KickVersion', 'FileLength', 'MouseX', 'MouseY', 'FreeStack', // 50-59
  'CtrlC', '#List_OLD', 'ListCopy', 'ListAdd', 'ListCmp', 'ListLen', 'ListMax', 'Even', 'Odd', 'Eval', // 60-69
  'ForAll', 'Exists', 'MapList', '#Abs_OLD', 'Shl', 'Shr', 'Box', 'Dispose', '#DisposeLink_OLD', 'Link', // 70-79
  'Next', 'Forward', 'SetStr', 'SetList', 'WaitIMessage', 'MsgCode', 'MsgQualifier', 'MsgIaddr', 'Rnd', 'RndQ', // 80-89
  'Mod', 'Eor', 'Raise', 'ListItem', 'NewR', 'Sign', 'PrintF', 'WaitLeftMouse', 'LeftMouse', 'SetStdIn', // 90-99
  'Throw', 'ReThrow', 'SelectList', 'SetColour', 'NewM', 'Bounds', 'RealF', 'RealVal', 'Fabs', 'Ffloor', // 100-109
  'Fceil', 'Fsin', 'Fcos', 'Ftan', 'Fexp', 'Flog', 'Fpow', 'Fsqrt', 'Flog10', 'FastDispose', // 110-119
  'FastNew', 'Min', 'Max', 'OstrCmp', 'AstrCopy', '#Cell_removed', '#FreeCells', '#SetChunkSize', '#Car', '#Cdr', // 120-129
  '#Cons', 'FastDisposeList', 'Fatan', 'Fsincos', 'Fsinh', 'Fcosh', 'Ftanh', 'Ftieee', 'Ffieee', 'Fasin', // 130-139
  'Facos', 'ObjName', 'ObjSize', 'DebugF', 'Double', 'PutDouble', 'Ptr', 'PutPtr', 'Byte', 'PutByte', // 140-149
  'Word', 'PutWord', 'Float', 'PutFloat', 'Real', 'PutReal', 'NewList', 'String', 'List', 'DisposeLink', // 150-159
  'Wide', 'PutWide', 'UlongToWide', // 160-162
];

export function ifuncName(number) {
  return IFUNCS[number - IFUNC_BASE] ?? null;
}
