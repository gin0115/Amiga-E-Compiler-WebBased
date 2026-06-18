// Host CLI for the (browser-pure) compiler pipeline: ecc file.e [-o out]
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sem.js';
import { compileProgram } from '../src/codegen.js';
import { makeResolver } from './modules.js';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  const { readFileSync: rf } = await import('node:fs');
  const pkg = JSON.parse(rf(new URL('../package.json', import.meta.url)));
  console.log(`ecc (ecomp) ${pkg.version}`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`ecc — Amiga E compiler (ecomp)
usage: node tools/ecc.js [--source=]file.e [options]

options:
  --out=FILE        output path (default: source without .e)
  -o FILE           same as --out
  --adf=FILE.adf    also write a bootable 880K floppy image that runs
                    the program at boot (mount as DF0: in any emulator)
  --moduledir=DIR   extra directory to search for binary .m modules
                    (repeatable; like ec's EMODULES: assign)
  --evo             enable E-VO (modern Amiga E) language extensions
  --warn            print semantic warnings
  --quiet           suppress informational output
  --version         print version
  --help            this text

OPT MODULE sources produce a binary .m interface module instead of
an executable.`);
  process.exit(args.length === 0 ? 1 : 0);
}
const flag = name => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const input = flag('source') ?? args.find(a => !a.startsWith('-') && a !== args[args.indexOf('-o') + 1]);
if (!input) { console.error('ecc: no source file given'); process.exit(1); }
const oIdx = args.indexOf('-o');
const output = flag('out') ?? (oIdx >= 0 ? args[oIdx + 1] : input.replace(/\.e$/i, ''));
const quiet = args.includes('--quiet');
const showWarn = args.includes('--warn');
const evo = args.includes('--evo');
const adfOut = flag('adf');
const moduleDirs = args.filter(a => a.startsWith('--moduledir=')).map(a => a.slice(12));

const src = readFileSync(input).toString('latin1');
const { program, errors: parseErrors } = parse(src, input, { evo });
if (parseErrors.length) {
  for (const e of parseErrors) console.error(`${input}:${e.line}:${e.col} ${e.msg}`);
  process.exit(1);
}
const sem = analyze(program, { evo, resolveModule: makeResolver(dirname(input), moduleDirs) });
if (showWarn) for (const w of sem.warnings) console.error(`${input}:${w.line ?? '?'} warning: ${w.msg}`);
if ((program.opts ?? []).some(o => /^MODULE/.test(o))) {
  const { writeEmod } = await import('../src/emodwrite.js');
  const exportAll = (program.opts ?? []).some(o => /^EXPORT/.test(o));
  const consts = [];
  for (const d of program.decls) {
    if ((d.kind === 'Const' || d.kind === 'Enum') && (d.exported || exportAll)) {
      for (const it of d.items) consts.push({ name: it.name, value: sem.consts.get(it.name) ?? 0 });
    } else if (d.kind === 'Set' && (d.exported || exportAll)) {
      for (const n of d.names) consts.push({ name: n, value: sem.consts.get(n) ?? 0 });
    }
  }
  const objects = [];
  for (const d of program.decls) {
    if (d.kind === 'Object' && (d.exported || exportAll)) {
      const so = sem.objects.get(d.name);
      objects.push({ name: d.name, size: so.size,
        members: [...so.members.entries()].map(([mn, m]) => ({ name: mn, val: m.size || 0, offset: m.offset })) });
    }
  }
  const out2 = input.replace(/\.e$/i, '.m');
  writeFileSync(out2, writeEmod({ consts, objects }));
  console.log(`${out2}: interface module (${consts.length} consts, ${objects.length} objects)`);
  process.exit(0);
}
if (sem.errors.length) {
  for (const e of sem.errors) console.error(`${input}:${e.line ?? '?'} ${e.msg}`);
  process.exit(1);
}
const { bin, errors } = compileProgram(program, sem);
if (errors.length) {
  for (const e of errors) console.error(`${input}: ${e.msg}`);
  process.exit(1);
}
writeFileSync(output, bin);
if (adfOut) {
  const { bootableAdf } = await import('../src/adf.js');
  const adf = bootableAdf(bin, { volume: 'ECOMP', command: 'prog' });
  writeFileSync(adfOut, adf);
  if (!quiet) console.log(`${adfOut}: bootable 880K floppy`);
}
if (!quiet) {
  console.log(`${output}: ${bin.length} bytes`);
  console.log('E v40 modules \u00a9 Wouter van Oortmerssen (Aminet dev/e/amigae33a) \u2014 used with his kind permission. Thank you, Wouter!');
}
