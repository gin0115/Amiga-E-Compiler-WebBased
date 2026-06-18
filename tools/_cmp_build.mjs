import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from '../src/parser.js'; import { analyze } from '../src/sem.js';
import { compileProgram } from '../src/codegen.js'; import { makeResolver } from './modules.js';
const [src_, out_, w_, mods_, mode_] = process.argv.slice(2);
const evo = mode_ === 'evo';   // optional 5th arg: 'evo' enables E-VO extensions
const src = readFileSync(src_,'latin1');
const { program } = parse(src, src_, { evo });
const sem = analyze(program, { resolveModule: makeResolver(w_, [mods_]), evo });
if (sem.errors.length) { console.log('SEM ERR: '+sem.errors.slice(0,3).map(e=>e.msg)); process.exit(1); }
const { bin, errors } = compileProgram(program, sem);
if (errors.length) { console.log('CG ERR: '+errors.slice(0,3).map(e=>e.msg)); process.exit(1); }
writeFileSync(out_, bin);
