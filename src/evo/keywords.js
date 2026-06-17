// E-VO (modern Amiga E) extension keywords. These are NOT keywords in the
// classic EC v3.3a language the ecomp core targets — in native mode they lex
// as ordinary identifiers/constants, exactly as the EC oracle sees them. The
// lexer folds this set into KEYWORDS only when EVO mode is enabled.
//
// Part of the optional E-VO extension (src/evo/*), activated by the `evo`
// compiler flag. See src/evo/README or the EVO-Support branch history.
export const EVO_KEYWORDS = [
  // negative / extended control flow
  'IFN', 'ELSEIFN', 'WHILEN', 'ELSEWHILE', 'ELSEWHILEN', 'ALWAYS', 'UNTILN',
  'EXITN', 'CONT', 'CONTN',
  // unary size/offset operators
  'PSIZEOF', 'ARRAYSIZE', 'OFFSETOF',
  // object unions
  'UNION', 'ENDUNION',
];
