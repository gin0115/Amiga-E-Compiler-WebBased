// dev helper: build an ecomp binary from a source file. usage:
//   node tools/_dbg-build.js <src.e> <sourceDir> <outBin>
import { parse } from '../src/parser.js';
import { analyze } from '../src/sem.js';
import { compileProgram } from '../src/codegen.js';
import { makeResolver } from './modules.js';
import { writeFileSync, readFileSync } from 'node:fs';
const [src, dir, out] = process.argv.slice(2);
const text = readFileSync(src, 'latin1');
const { program } = parse(text, src);
const sem = analyze(program, { resolveModule: makeResolver(dir, [process.cwd() + '/modules']) });
if (sem.errors.length) { console.log('SEM ERR:', sem.errors.map(e => e.msg).join('; ')); process.exit(1); }
const { bin, errors } = compileProgram(program, sem);
if (errors.length) { console.log('CG ERR:', errors.map(e => e.msg).join('; ')); process.exit(1); }
writeFileSync(out, bin);
console.log('built', bin.length, 'bytes');
