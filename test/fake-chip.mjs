// Browser-side stub: replaces navigator.serial with an in-memory fake BL chip
// and exercises the full flash flow. Returns a JSON report.
//
// This script string is injected verbatim via Playwright; it must be self-
// contained ECMAScript that evaluates inside the page.

export const FAKE_CHIP_INIT = String.raw`
(function() {
  const log = (...a) => console.log('[fake-chip]', ...a);

  // Minimal Web Serial fake. The "fake chip" responds to ISP frames sent by the
  // host and stores writes in an internal flash buffer, which we expose for
  // verification via window.__fakeFlash.
  function makeFakePort() {
    const flash = new Uint8Array(64 * 1024); // 64 KB
    let segCnt = 0;
    let lastSegLen = 0;
    let baud = 0;
    let inLoader = true; // pretend we already booted into ef_loader

    let outQueue = [];
    let outResolve = null;

    function pushOut(bytes) {
      outQueue.push(...bytes);
      if (outResolve) {
        const r = outResolve; outResolve = null; r();
      }
    }

    function handleFrame(buf) {
      // [cmd][checksum][len_lo][len_hi][payload...]
      const cmd = buf[0];
      const len = buf[2] | (buf[3] << 8);
      const payload = buf.slice(4, 4 + len);

      if (cmd === 0x10) { // GET_BOOT_INFO
        // OK + payload (24 bytes)
        const info = new Uint8Array(24);
        info.set([1,2,3,4], 0);
        info.set([0xCA,0xFE,0xBA,0xBE,0,0,0,0], 16);
        pushOut([0x4F, 0x4B, 24, 0, ...info]);
      } else if (cmd === 0x11 || cmd === 0x17) { // boot/seg header
        if (cmd === 0x17) {
          lastSegLen = payload[4] | (payload[5]<<8) | (payload[6]<<16) | (payload[7]<<24);
          pushOut([0x4F, 0x4B, 16, 0, ...payload]);
        } else {
          pushOut([0x4F, 0x4B]);
        }
      } else if (cmd === 0x18) { // load segment data
        pushOut([0x4F, 0x4B]);
      } else if (cmd === 0x19) { // check image
        pushOut([0x4F, 0x4B]);
      } else if (cmd === 0x1A) { // run image
        pushOut([0x4F, 0x4B]);
        inLoader = true;
      } else if (cmd === 0x22) { // clk_set
        pushOut([0x4F, 0x4B]);
      } else if (cmd === 0x3B) { // flash_set_para
        pushOut([0x4F, 0x4B]);
      } else if (cmd === 0x21) { // reset
        pushOut([0x4F, 0x4B]);
      } else if (cmd === 0x30) { // flash erase
        pushOut([0x4F, 0x4B]);
      } else if (cmd === 0x31) { // flash write
        const addr = payload[0] | (payload[1]<<8) | (payload[2]<<16) | (payload[3]<<24);
        for (let i = 0; i < payload.length - 4; i++) {
          flash[addr + i] = payload[4 + i];
        }
        pushOut([0x4F, 0x4B]);
      } else if (cmd === 0x32) { // flash read
        const addr = payload[0] | (payload[1]<<8) | (payload[2]<<16) | (payload[3]<<24);
        const length = payload[4] | (payload[5]<<8) | (payload[6]<<16) | (payload[7]<<24);
        const data = flash.slice(addr, addr + length);
        pushOut([0x4F, 0x4B, length & 0xFF, (length >> 8) & 0xFF, ...data]);
      } else if (cmd === 0x50) { // mem_write
        pushOut([0x4F, 0x4B]);
      } else if (cmd === 0x3A) { // program check
        pushOut([0x4F, 0x4B]);
      } else if (cmd === 0xFF) {
        // sync byte burst (0x55) won't even reach here as a frame; ignore
      } else {
        pushOut([0x46, 0x4C, 0x0C, 0x00]); // FL + ERR_CMD_ID
      }
    }

    let inBuf = [];
    function consumeIncoming(bytes) {
      // Detect the 0x55 sync burst — chip simply replies "OK"
      const allSync = bytes.length > 4 && bytes.every(b => b === 0x55);
      if (allSync) {
        pushOut([0x4F, 0x4B]);
        return;
      }
      for (const b of bytes) inBuf.push(b);
      while (inBuf.length >= 4) {
        const len = inBuf[2] | (inBuf[3] << 8);
        if (inBuf.length < 4 + len) break;
        const frame = inBuf.splice(0, 4 + len);
        handleFrame(frame);
      }
    }

    const writable = new WritableStream({
      write(chunk) {
        consumeIncoming(Array.from(chunk));
      }
    });

    const readable = new ReadableStream({
      async pull(controller) {
        if (outQueue.length === 0) {
          await new Promise(r => { outResolve = r; });
        }
        const out = Uint8Array.from(outQueue.splice(0, outQueue.length));
        controller.enqueue(out);
      }
    });

    return {
      async open(opts) { baud = opts.baudRate; },
      async close() {},
      async setSignals(_) {},
      writable,
      readable,
      _flash: flash,
    };
  }

  const fakePort = makeFakePort();
  window.__fakePort = fakePort;
  window.__fakeFlash = fakePort._flash;

  // Override Web Serial. navigator.serial is non-configurable in some
  // Chromium builds, so attempt to override the prototype methods first;
  // fall back to defining an own property.
  const proto = navigator.serial && Object.getPrototypeOf(navigator.serial);
  const wrap = {
    requestPort: async () => fakePort,
    getPorts:    async () => [fakePort],
    addEventListener:    () => {},
    removeEventListener: () => {},
    dispatchEvent:       () => true,
  };
  if (proto) {
    for (const k of ['requestPort', 'getPorts']) {
      try {
        Object.defineProperty(proto, k, { value: wrap[k], configurable: true, writable: true });
      } catch (e) { log('proto override fail', k, e.message); }
    }
  } else {
    try {
      Object.defineProperty(navigator, 'serial', { value: wrap, configurable: true, writable: true });
    } catch (e) {
      log('serial override fail', e.message);
    }
  }
})();
`;

export const RUN_FLASH = String.raw`
(async () => {
  // Build a 4 KB firmware payload with a BFNP boot header so the auto-wrap
  // path is bypassed (BL616 wrapper isn't implemented yet — only BL702L).
  const fw = new Uint8Array(4096);
  fw[0] = 0x42; fw[1] = 0x46; fw[2] = 0x4E; fw[3] = 0x50; // "BFNP"
  for (let i = 4; i < fw.length; i++) fw[i] = (i * 31) & 0xFF;

  // Inject as if the user picked a file
  const dt = new DataTransfer();
  dt.items.add(new File([fw], 'fake.bin'));
  const fileInput = document.getElementById('fw-file');
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change'));

  // Pick BL616 (a chip that uses BootROM-direct flash, no eflash_loader fetch)
  const sel = document.getElementById('chip-select');
  sel.value = 'bl616';
  sel.dispatchEvent(new Event('change'));

  // Click Connect & Flash
  document.getElementById('connect-btn').click();

  // Wait until progress hits 1 or an error appears
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const p = document.getElementById('progress').value;
    const log = document.getElementById('log').textContent;
    if (p >= 1 || /SUCCESS/.test(log)) break;
    if (/ERROR:/.test(log)) break;
    await new Promise(r => setTimeout(r, 100));
  }

  const log = document.getElementById('log').textContent;
  const flash = window.__fakeFlash;
  // verify first 4096 bytes match
  let mismatches = 0;
  for (let i = 0; i < fw.length; i++) {
    if (flash[i] !== fw[i]) mismatches++;
  }
  return {
    log,
    progress: document.getElementById('progress').value,
    mismatches,
    success: /SUCCESS/.test(log) && mismatches === 0,
  };
})();
`;
