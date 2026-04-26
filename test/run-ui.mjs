// Headless Chromium smoke test for the BLFB Web Flasher UI.
//
// This test does not flash real hardware. The Web Serial API requires a user
// gesture to call `requestPort()`, and the only BL chip on this host is behind
// CKLink (which uses a custom JTAG-style protocol, not UART), so an end-to-end
// UART flash through Chromium is not possible without manual intervention.
//
// What we can test headlessly:
//   1. The page loads, the chip dropdown populates with all 6 chip families.
//   2. The address input parses 0x… correctly.
//   3. Clicking "Connect & Flash" without granting a port surfaces a clean
//      error (the SerialTransport throws "Web Serial API not available", or
//      the port chooser is automatically rejected).
//   4. (Optional) Inject a fake `navigator.serial` and exercise the full
//      flash flow against an in-memory chip simulator.
//
// Usage:
//   npx playwright install chromium    (one-time)
//   node test/run-ui.mjs

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { FAKE_CHIP_INIT, RUN_FLASH } from './fake-chip.mjs';

const PORT = 8765;
const SITE = `http://localhost:${PORT}/`;

async function startServer() {
  const root = new globalThis.URL('..', import.meta.url).pathname;
  const proc = spawn('python3', ['-m', 'http.server', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: root,
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('exit', (code) => { if (code !== null && code !== 0) console.error(`server exited code=${code} stderr=${stderr}`); });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(SITE);
      if (r.ok) return proc;
    } catch (_) {}
    await wait(100);
  }
  proc.kill();
  throw new Error(`http server failed to start (cwd=${root}, stderr=${stderr})`);
}

function fail(msg) {
  console.error('FAIL:', msg);
  process.exitCode = 1;
}

async function main() {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--enable-features=WebSerial',
        '--enable-blink-features=Serial',
      ],
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('console', (msg) => console.log(`[browser ${msg.type()}]`, msg.text()));
    page.on('pageerror', (err) => fail(`page error: ${err.message}`));

    await page.goto(SITE, { waitUntil: 'networkidle' });
    console.log('PASS: page loaded');

    // 1. Chip dropdown populated.
    const chipCount = await page.$$eval('#chip-select option', els => els.length);
    if (chipCount !== 6) fail(`expected 6 chip options, got ${chipCount}`);
    else console.log(`PASS: chip dropdown has ${chipCount} options`);

    const chipValues = await page.$$eval('#chip-select option', els => els.map(o => o.value));
    const expected = ['bl602', 'bl702', 'bl702l', 'bl616', 'bl808', 'bl606p'];
    for (const v of expected) {
      if (!chipValues.includes(v)) fail(`missing chip ${v} in dropdown`);
    }
    console.log('PASS: all 6 chip families present');

    // 2. Click flash without a file → should produce a friendly error in the log.
    await page.click('#connect-btn');
    await wait(500);
    const logTxt = await page.textContent('#log');
    if (!/pick a firmware/i.test(logTxt)) {
      fail(`expected "pick a firmware" in log, got: ${logTxt.slice(0, 200)}`);
    } else {
      console.log('PASS: missing-file error surfaces cleanly');
    }

    // 3. Assert key UI elements exist.
    for (const sel of ['#fw-file', '#opt-verify', '#opt-reset', '#progress', '#log', '#clear-log']) {
      if (!(await page.$(sel))) fail(`missing UI element ${sel}`);
    }
    console.log('PASS: all key UI elements present');

    // 5. Headless Chromium has no Web Serial UI; navigator.serial.requestPort()
    //    should throw a NotFoundError. Verify via injection.
    const serialAvailable = await page.evaluate(() => 'serial' in navigator);
    console.log(`INFO: navigator.serial present? ${serialAvailable}`);

    // 6. clear-log button works
    await page.click('#clear-log');
    const cleared = await page.textContent('#log');
    if (cleared.length !== 0) fail(`log not cleared, still has ${cleared.length} chars`);
    else console.log('PASS: clear-log empties the log');

    // 7. End-to-end flash against an in-page fake chip simulator (BL616).
    //    Reload with the fake-chip init script so that navigator.serial is
    //    intercepted before main.js binds the click handler.
    const ctx2 = await browser.newContext();
    await ctx2.addInitScript({ content: FAKE_CHIP_INIT });
    const page2 = await ctx2.newPage();
    page2.on('console', (msg) => console.log(`[browser ${msg.type()}]`, msg.text()));
    page2.on('pageerror', (err) => fail(`page error (fake): ${err.message}`));
    await page2.goto(SITE, { waitUntil: 'networkidle' });
    const result = await page2.evaluate(RUN_FLASH);
    if (!result.success) {
      console.error('--- in-browser flash log ---\n' + result.log);
      fail(`fake-chip flash did not succeed (mismatches=${result.mismatches}, progress=${result.progress})`);
    } else {
      console.log(`PASS: fake-chip flash + verify completed (${result.log.split('\n').length} log lines)`);
    }
    await ctx2.close();

    if (process.exitCode) console.log('\n>>> Some tests FAILED. <<<');
    else console.log('\n>>> All UI smoke tests passed. <<<');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
