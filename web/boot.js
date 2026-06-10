// Standalone SAE bootstrap for the Amiga E research rig.
//
// Adapted from amiga-desktop/src/lib/sae-loader.js, but stripped of React,
// Vite env and module syntax so it runs as a plain <script>. Boots a REAL
// Commodore Kickstart 3.1 (A1200, rev 40.68) — so unlike the AROS setup it
// needs NO extension ROM. Mounts a Workbench 3.1 floppy in DF0 to reach a
// genuine Workbench desktop, then exposes mountADF() so the research system
// can swap in Amiga E disk images at runtime.

(function () {
  'use strict';

  var SAE_BASE = './vendor/sae/sae';
  var SAE_FILES = [
    'prototypes', 'utils', 'dms', 'config', 'roms', 'memory', 'autoconf',
    'expansion', 'events', 'gayle', 'ide', 'filesys', 'hardfile', 'dongle',
    'input', 'serpar', 'custom', 'blitter', 'copper', 'playfield', 'video',
    'audio', 'cia', 'disk', 'rtc', 'm68k', 'cpu', 'amiga',
  ];

  // SAE numeric constants are `const`-scoped inside config.js and never reach
  // globalThis, so we mirror the literal values (see config.js).
  var SAE_MODEL_A1200 = 5;
  var SAE_VIDEO_API_CANVAS = 0;
  var SAE_HRES_HIRES = 1;
  var SAE_VRES_DOUBLE = 1;
  var SAE_ERR_NONE = 0;

  var ROM_URL = './roms/kick31-a1200-40.68.rom';

  // Optional extra mounts via URL params, e.g. ?df1=./disks/ETEST.adf&hdf=./disks/work.hdf
  // ?df0=... overrides the boot floppy. Lets the research workflow mount any
  // ADF/HDF without editing the harness.
  var PARAMS = new URLSearchParams(location.search);
  var BOOT_FLOPPY_URL = PARAMS.get('df0') || './disks/workbench31-boot.adf';

  var statusEl, progressEl;
  var sae = null;

  function setStatus(msg, isError) {
    if (statusEl) {
      statusEl.textContent = msg;
      statusEl.className = isError ? 'status error' : 'status';
    }
    // eslint-disable-next-line no-console
    (isError ? console.error : console.log)('[amiga-e]', msg);
  }

  function setProgress(p) {
    if (progressEl) progressEl.style.width = Math.round(p * 100) + '%';
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = src;
      tag.async = false; // preserve declared order
      tag.onload = function () { resolve(); };
      tag.onerror = function () { reject(new Error('SAE script failed: ' + src)); };
      document.head.appendChild(tag);
    });
  }

  async function loadSaeScripts() {
    for (var i = 0; i < SAE_FILES.length; i++) {
      await loadScript(SAE_BASE + '/' + SAE_FILES[i] + '.js');
    }
  }

  async function fetchAsUint8(url, onProgress) {
    var res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch ' + url + ': ' + res.status);
    var total = Number(res.headers.get('content-length')) || 0;
    if (!total || !res.body || !res.body.getReader) {
      var buf = new Uint8Array(await res.arrayBuffer());
      if (onProgress) onProgress(1);
      return buf;
    }
    var reader = res.body.getReader();
    var chunks = [];
    var received = 0;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      received += step.value.length;
      if (onProgress) onProgress(received / total);
    }
    var out = new Uint8Array(received);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return out;
  }

  function computeCrc(buf) {
    var fn = globalThis.SAEF_crc32;
    if (typeof fn !== 'function') return 0;
    return fn(buf, 0, buf.byteLength) >>> 0;
  }

  async function boot() {
    statusEl = document.getElementById('status');
    progressEl = document.getElementById('progress-bar');
    var container = document.getElementById('sae-host');

    try {
      setStatus('Loading SAE engine…');
      await loadSaeScripts();

      var ScriptedAmigaEmulator = globalThis.ScriptedAmigaEmulator;
      if (typeof ScriptedAmigaEmulator !== 'function') {
        throw new Error('SAE scripts did not register ScriptedAmigaEmulator');
      }

      setStatus('Fetching Kickstart 3.1 ROM + Workbench floppy…');
      var rom = await fetchAsUint8(ROM_URL, function (p) { setProgress(p * 0.3); });
      var floppy = await fetchAsUint8(BOOT_FLOPPY_URL, function (p) { setProgress(0.3 + p * 0.4); });

      setStatus('Configuring A1200…');
      sae = new ScriptedAmigaEmulator();
      var cfg = sae.getConfig();
      sae.setModel(SAE_MODEL_A1200, null);

      // Real Commodore Kickstart 3.1 — no extension ROM required.
      cfg.memory.rom.name = 'kick31-a1200.rom';
      cfg.memory.rom.data = rom;
      cfg.memory.rom.size = rom.byteLength;
      cfg.memory.rom.crc32 = computeCrc(rom);

      if (floppy && cfg.floppy && cfg.floppy.drive && cfg.floppy.drive[0]) {
        cfg.floppy.drive[0].file.name = 'workbench31-boot.adf';
        cfg.floppy.drive[0].file.data = floppy;
        cfg.floppy.drive[0].file.size = floppy.byteLength;
      }

      // Optional extra floppies via ?df1=...&df2=...&df3=... (35" DD = type 1).
      var SAE_FLOPPY_DD = 1;
      for (var d = 1; d <= 3; d++) {
        var url = PARAMS.get('df' + d);
        if (!url || !cfg.floppy.drive[d]) continue;
        setStatus('Fetching DF' + d + ': ' + url + '…');
        var data = await fetchAsUint8(url);
        cfg.floppy.drive[d].type = SAE_FLOPPY_DD;
        cfg.floppy.drive[d].file.name = url.split('/').pop();
        cfg.floppy.drive[d].file.data = data;
        cfg.floppy.drive[d].file.size = data.byteLength;
      }

      // Optional hardfile via ?hdf=... — mounted as A1200 mainboard-IDE unit 0
      // (SAE mounts HDFs through Gayle IDE, not the no-op cfg.hardfile). The HDF
      // must be RDB-formatted so Workbench auto-mounts its partition (DH0:).
      var hdfUrl = PARAMS.get('hdf');
      if (hdfUrl && cfg.mount && cfg.mount.config && cfg.mount.config[0]) {
        setStatus('Fetching hardfile ' + hdfUrl + '…');
        var hdfData = await fetchAsUint8(hdfUrl, function (p) { setProgress(0.7 + p * 0.2); });
        if (typeof sae.setMountInfoDefaults === 'function') sae.setMountInfoDefaults(0);
        if (cfg.chipset && !cfg.chipset.ide) cfg.chipset.ide = 1; // A600/A1200 IDE
        var ci = cfg.mount.config[0].ci;
        ci.controller_type = 1; // SAEC_Config_Mount_Controller_Type_MB_IDE
        ci.controller_unit = 0;
        ci.blocksize = 512;
        ci.file.name = hdfUrl.split('/').pop();
        ci.file.data = hdfData;
        ci.file.size = hdfData.byteLength;
      }

      cfg.video.id = container.id;
      cfg.video.enabled = true;
      cfg.video.api = SAE_VIDEO_API_CANVAS;
      cfg.video.hresolution = SAE_HRES_HIRES;
      cfg.video.vresolution = SAE_VRES_DOUBLE;
      cfg.video.size_win.width = 720;
      cfg.video.size_win.height = 568;
      if (cfg.video.size_fs) {
        cfg.video.size_fs.width = 720;
        cfg.video.size_fs.height = 568;
      }
      cfg.memory.z2FastSize = 2 << 20;

      if (cfg.hook && cfg.hook.log) {
        cfg.hook.log.error = function (err, msg) { console.error('[SAE]', err, msg); };
      }
      if (cfg.hook && cfg.hook.event) {
        cfg.hook.event.started = function () { setStatus('Running — Workbench 3.1 booting.'); setProgress(1); };
        cfg.hook.event.stopped = function () { setStatus('Stopped.'); };
      }

      // Enable the serial subsystem (off by default) so SER: output streams
      // through hook.serial.put. Serial has no printer-BUSY handshake, so it
      // won't block the boot the way PAR: does.
      if (cfg.serial) cfg.serial.enabled = true;

      // Output capture: redirecting Amiga output to PAR:/SER: streams each byte
      // through these hooks — avoids the FFS write-cache/flush problem entirely.
      window.__cap = [];
      if (cfg.hook && cfg.hook.parallel) {
        cfg.hook.parallel.put = function (v) { window.__cap.push(v & 0xff); };
      }
      if (cfg.hook && cfg.hook.serial) {
        cfg.hook.serial.put = function (v) { window.__cap.push(v & 0xff); };
      }

      setStatus('Starting emulator…');
      var err = sae.start();
      if (err !== SAE_ERR_NONE && err !== undefined) {
        throw new Error('SAE start failed with code ' + err);
      }
      window.sae = sae; // expose for the research console
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  }

  // Runtime ADF mount for the research workflow: feed an ArrayBuffer into a
  // floppy slot (0..3) and reinsert so Workbench sees a fresh disk.
  window.mountADF = function mountADF(slot, arrayBuffer, name) {
    if (!sae) { setStatus('Emulator not running yet.', true); return; }
    var cfg = sae.getConfig();
    var drive = cfg.floppy && cfg.floppy.drive && cfg.floppy.drive[slot];
    if (!drive) { setStatus('No floppy drive ' + slot, true); return; }
    var data = new Uint8Array(arrayBuffer);
    drive.file.name = name || ('df' + slot + '.adf');
    drive.file.data = data;
    drive.file.size = data.byteLength;
    // SAE re-reads drive config on insert; toggle via its insert API if present.
    if (sae.insertFloppy) {
      try { sae.insertFloppy(slot, data, drive.file.name); } catch (e) { /* fall through */ }
    }
    setStatus('Mounted ' + drive.file.name + ' in DF' + slot + ':');
  };

  // Dump the live in-memory hardfile back to the host (so Amiga-side writes,
  // e.g. ShowModule output, can be recovered). POSTs to the upload server.
  // Capture stream helpers (PAR:/SER: bytes the Amiga emitted).
  window.capLen = function () { return window.__cap ? window.__cap.length : 0; };
  window.postCapture = function postCapture(name) {
    var bytes = Uint8Array.from(window.__cap || []);
    return fetch('http://127.0.0.1:8199/upload?name=' + encodeURIComponent(name || 'capture.txt'), {
      method: 'POST', body: bytes,
    }).then(function () { setStatus('Posted capture (' + bytes.byteLength + ' bytes).'); return bytes.byteLength; })
      .catch(function (e) { setStatus('postCapture failed: ' + e.message, true); });
  };

  window.dumpHDF = function dumpHDF(name) {
    if (!sae) { setStatus('Emulator not running.', true); return; }
    var cfg = sae.getConfig();
    var ci = cfg.mount && cfg.mount.config && cfg.mount.config[0] && cfg.mount.config[0].ci;
    var data = ci && ci.file && ci.file.data;
    if (!data) { setStatus('No hardfile data to dump.', true); return; }
    fetch('http://127.0.0.1:8199/upload?name=' + encodeURIComponent(name || 'dump.hdf'), {
      method: 'POST', body: data,
    }).then(function () { setStatus('Dumped hardfile (' + data.byteLength + ' bytes) to host.'); })
      .catch(function (e) { setStatus('dumpHDF failed: ' + e.message, true); });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
