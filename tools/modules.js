// Host-side module resolver: loads binary .m files from the canonical
// E v3.3a v40 module set on demand.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEmod } from '../src/emod.js';
import { parse } from '../src/parser.js';

const here = dirname(fileURLToPath(import.meta.url));
// canonical module set: the research copy when present (dev), else the
// tracked web/modules (CI / fresh clones — Wouter's v40 set)
const roots = [
  join(here, '..', 'research/extracted/amigae33a/E_v3.3a/Modules.lha.x/Modules'),
  join(here, '..', 'web/modules'),
];

const cache = new Map();

export function resolveModule(name) {
  const key = name.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let mod = null;
  outer: for (const root of roots) {
    for (const candidate of [key, name]) {
      try {
        const buf = new Uint8Array(readFileSync(join(root, candidate + '.m')));
        mod = readEmod(buf, name);
        break outer;
      } catch { /* try next */ }
    }
  }
  cache.set(key, mod);
  return mod;
}

// resolver aware of the source file's directory: MODULE '*local' (and plain
// names as fallback) load sibling .m files, like real ec does
export function makeResolver(sourceDir, extraDirs = []) {
  return name => {
    const local = name.startsWith('*') ? name.slice(1) : null;
    const candidates = [];
    if (local) {
      candidates.push(join(sourceDir, local + '.m'), join(sourceDir, local.toLowerCase() + '.m'));
    } else {
      candidates.push(join(sourceDir, name + '.m'), join(sourceDir, name.toLowerCase() + '.m'));
    }
    for (const p of local ? candidates : []) {
      try {
        const mod = readEmod(new Uint8Array(readFileSync(p)), name);
        if (!mod.error && !mod.partial) return mod;
      } catch { /* next */ }
    }
    if (local) {
      // code modules: compile from source into the importing unit
      for (const p of [join(sourceDir, local + '.e'), join(sourceDir, local.toLowerCase() + '.e')]) {
        try {
          const text = readFileSync(p).toString('latin1');
          const r = parse(text, p);
          if (!r.errors.length) return { name, sourceProgram: r.program, consts: new Map(), objects: new Map(), lib: null };
        } catch { /* next */ }
      }
    }
    if (!local) {
      // --moduledir search paths take priority (like ec's EMODULES:)
      for (const dir of extraDirs) {
        for (const cand of [name + '.m', name.toLowerCase() + '.m']) {
          try {
            const mod = readEmod(new Uint8Array(readFileSync(join(dir, cand))), name);
            if (!mod.error && !mod.partial) return mod;
          } catch { /* next */ }
        }
      }
      const global = resolveModule(name);
      if (global && !global.error && !global.partial) return global;
      for (const p of candidates) {
        try {
          const mod = readEmod(new Uint8Array(readFileSync(p)), name);
          if (!mod.error && !mod.partial) return mod;
        } catch { /* next */ }
      }
      // code modules referenced by plain name: sibling source fallback
      const base = name.split('/').pop();
      for (const p of [join(sourceDir, base + '.e'), join(sourceDir, base.toLowerCase() + '.e')]) {
        try {
          const text = readFileSync(p).toString('latin1');
          const r = parse(text, p);
          if (!r.errors.length) return { name, sourceProgram: r.program, consts: new Map(), objects: new Map(), lib: null };
        } catch { /* next */ }
      }
      if (global) return global;   // partial beats nothing
    }
    return null;
  };
}
