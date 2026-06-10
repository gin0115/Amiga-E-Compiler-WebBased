// Differential-testing oracle: compile (and run) E source with the REAL
// Amiga E v3.3a compiler (ECDEMO) under vamos m68k emulation on the host.
//
// stdout of child binaries doesn't surface reliably through vamos, so run
// probes write their results to a file on the work: volume instead and we
// read it host-side.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(root, 'research/extracted/amigae33a/E_v3.3a/Bin');
const MODS = join(root, 'research/extracted/amigae33a/E_v3.3a/Modules.lha.x/Modules');
const VAMOS = join(process.env.HOME, '.local/bin/vamos');

// E executables unconditionally open intuition.library + graphics.library at
// startup and exit silently before main() if either fails — fake every
// library except dos/exec when running compiled programs.
const FAKE_LIBS = '*.library=mode:fake,version:40+dos.library=mode:auto+exec.library=mode:auto';

function vamos(work, amiCmd, args, { fakeLibs = false, timeoutMs = 60000 } = {}) {
  const argv = [
    '-q',
    ...(fakeLibs ? ['-O', FAKE_LIBS] : []),
    '-V', `work:${work}`,
    '-V', `mods:${MODS}`,
    '-V', `bin:${BIN}`,
    '-a', 'emodules:mods:',
    '--cwd', 'work:',
    amiCmd, ...args,
  ];
  try {
    const out = execFileSync(VAMOS, argv, {
      timeout: timeoutMs, encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

// Compile `source` with the real ec. Returns {ok, out, exe} where exe is the
// host path of the produced AmigaOS executable (null on compile error).
export function oracleCompile(source, name = 'probe') {
  const work = mkdtempSync(join(tmpdir(), 'ecomp-oracle-'));
  writeFileSync(join(work, `${name}.e`), source, 'latin1');
  const r = vamos(work, 'bin:ECDEMO', [`${name}.e`]);
  const exe = join(work, name);
  const ok = existsSync(exe);
  return { ok, out: r.out, exe: ok ? exe : null, work };
}

// Compile and run a probe whose E source writes its answer to work:out.txt.
// Returns {compiled, ran, result} with result = contents of out.txt or null.
export function oracleRun(source, name = 'probe') {
  const c = oracleCompile(source, name);
  if (!c.ok) return { compiled: false, ran: false, result: null, out: c.out, work: c.work };
  const r = vamos(c.work, `work:${name}`, [], { fakeLibs: true });
  const outFile = join(c.work, 'out.txt');
  const result = existsSync(outFile) ? readFileSync(outFile, 'latin1') : null;
  return { compiled: true, ran: result !== null, result, out: r.out, work: c.work };
}

// E program template: evaluate EXPR and write it formatted to work:out.txt.
export function probeExpr(expr, fmt = '\\d') {
  return `PROC main()
  DEF fh, s[300]:STRING
  StringF(s, '${fmt}', ${expr})
  fh:=Open('out.txt', NEWFILE)
  Write(fh, s, EstrLen(s))
  Close(fh)
ENDPROC
`;
}

export function cleanup(work) {
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}
