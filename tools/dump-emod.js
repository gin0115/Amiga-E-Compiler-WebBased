// scratch: dump what readEmod extracts from a module (verification aid)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readEmod } from '../src/emod.js';

const here = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] || join(here, '..', 'modules', 'tools', 'EasyGUI.m');
const buf = new Uint8Array(readFileSync(path));
const m = readEmod(buf, 'EasyGUI');

console.log('version', m.version, 'osvers', m.osvers, 'isCodeModule', m.isCodeModule);
console.log('partial', m.partial, 'error', m.error);
console.log('codeWords', m.codeWords, 'code.length', m.code && m.code.length);
console.log('code[0..3]', m.code && [...m.code.slice(0, 4)].map(b => b.toString(16)));
console.log('procs', m.procs.length, '| labels',
  m.procs.filter(p => p.kind === 'label').length);
for (const n of ['easygui', 'easyguiA', 'easygui_fallbackA']) {
  console.log('  proc', n, '=>', JSON.stringify(m.procs.find(p => p.name === n)));
}
console.log('first 6 procs', m.procs.slice(0, 6).map(p => `${p.name}@${p.offset}/${p.args}`));
console.log('relocs', m.relocs.length,
  '| abs', m.relocs.filter(r => r.kind === 'abs').length,
  '| ifunc', m.relocs.filter(r => r.kind === 'ifunc').length);
console.log('  abs relocs', m.relocs.filter(r => r.kind === 'abs').map(r => '0x' + r.offset.toString(16)));
console.log('globs.xrefs', m.globs.xrefs.map(x => `${x.name}(${x.refs.length})`));
console.log('globs.drels', m.globs.drels.map(d => d.refs.length), '| globalsCount', m.globalsCount);
console.log('consts', m.consts.size, 'objects', m.objects.size);
