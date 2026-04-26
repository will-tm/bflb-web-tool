// UI controller: wires the form to the flasher.

import { listChips, chipById } from './chips.js';
import { SerialTransport } from './transport.js';
import { flash, prepareRegions } from './flasher.js';
import { hasBootHeader } from './whole_img.js';
import { openMonitor } from './monitor.js';

let activeMonitor = null;

const $ = (id) => document.getElementById(id);

function init() {
  const sel = $('chip-select');
  for (const c of listChips()) {
    const o = document.createElement('option');
    o.value = c.type;
    o.textContent = `${c.name}  (${c.type})`;
    sel.appendChild(o);
  }

  $('clear-log').addEventListener('click', () => { $('log').textContent = ''; });
  $('connect-btn').addEventListener('click', onFlash);
  $('monitor-btn').addEventListener('click', onMonitorToggle);

  setupFilePicker();
  setupDragDrop();

  if (!('serial' in navigator)) {
    log('Web Serial API is not available in this browser. Use Chrome/Edge/Opera 89+ on a secure origin.', 'err');
    $('connect-btn').disabled = true;
  }
}

function setupFilePicker() {
  $('fw-file').addEventListener('change', () => {
    const f = $('fw-file').files[0];
    setFileLabel(f);
  });
}

function setFileLabel(file) {
  const el = $('fw-file-name');
  if (file) {
    el.textContent = `${file.name}  (${file.size.toLocaleString()} B)`;
    el.classList.add('has-file');
  } else {
    el.textContent = 'No file selected';
    el.classList.remove('has-file');
  }
}

function setupDragDrop() {
  const body = document.body;
  let depth = 0;

  // Prevent the browser from navigating away when dropping anywhere on the page.
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => {
    window.addEventListener(ev, (e) => { e.preventDefault(); }, false);
  });

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    body.classList.add('drag-active');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) body.classList.remove('drag-active');
  });
  window.addEventListener('drop', (e) => {
    depth = 0;
    body.classList.remove('drag-active');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.(bin|img)$/i.test(file.name)) {
      log(`Ignored ${file.name} — only .bin / .img firmware files are accepted.`, 'warn');
      return;
    }
    // Mirror into the hidden <input type="file"> so the rest of the flow stays the same.
    const dt = new DataTransfer();
    dt.items.add(file);
    $('fw-file').files = dt.files;
    setFileLabel(file);
    log(`Loaded ${file.name} via drag-and-drop.`);
  });
}

function hasFiles(e) {
  if (!e.dataTransfer) return false;
  const t = e.dataTransfer.types;
  if (!t) return false;
  for (let i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
  return false;
}

function log(msg, cls = '') {
  const el = $('log');
  const ts = new Date().toLocaleTimeString();
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = `[${ts}] ${msg}\n`;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function setProgress(p, msg) {
  $('progress').value = p;
  $('progress-label').textContent = msg ? `${(p * 100).toFixed(1)}%  ${msg}` : '';
}

function selectedFlashBaud() {
  const v = $('opt-baud').value;
  return v ? parseInt(v, 10) : null;
}

async function onFlash() {
  const btn = $('connect-btn');
  btn.disabled = true;

  // Stop any active monitor — flashing needs exclusive port access.
  if (activeMonitor) {
    try { await activeMonitor.close(); } catch (_) {}
    activeMonitor = null;
    setMonitorBtn(false);
    log('Closed monitor before flashing.', 'warn');
  }

  let port = null;
  try {
    const chip = chipById($('chip-select').value);
    if (!chip) throw new Error('pick a chip');

    const file = $('fw-file').files[0];
    if (!file) throw new Error('pick a firmware .bin');

    const data = new Uint8Array(await file.arrayBuffer());
    const wrapped = !hasBootHeader(data);
    log(`Firmware: ${file.name} (${data.length} bytes)`);
    if (wrapped) {
      log('No BFNP header found — building boot header (sha256 + crc) and flashing as bootinfo @ 0x0 + payload @ 0x2000.');
    } else {
      log('BFNP boot header detected — flashing whole image at 0x0.');
    }

    const { regions } = await prepareRegions(chip, data);
    for (const r of regions) {
      log(`  -> 0x${r.address.toString(16).padStart(8, '0')} (${r.data.length} bytes)`);
    }

    port = await SerialTransport.request();
    log('Port granted');

    const baud = selectedFlashBaud();
    await flash({
      chip,
      port,
      regions,
      flashBaud: baud,
      verify: $('opt-verify').checked,
      reset:  $('opt-reset').checked,
      onLog: (m) => log(m),
      onProgress: (p, m) => setProgress(p, m),
    });
    log('SUCCESS', 'ok');

    if ($('opt-monitor-after').checked) {
      try {
        await openMonitorOnPort(port);
      } catch (e) {
        log(`Could not auto-open monitor: ${e.message}`, 'warn');
      }
    }
  } catch (e) {
    console.error(e);
    log(`ERROR: ${e.message}`, 'err');
    setProgress(0, 'Failed');
  } finally {
    btn.disabled = false;
  }
}

async function onMonitorToggle() {
  if (activeMonitor) {
    try { await activeMonitor.close(); } catch (_) {}
    activeMonitor = null;
    setMonitorBtn(false);
    log('Monitor closed.');
    return;
  }
  try {
    await openMonitorOnPort(null);
  } catch (e) {
    log(`Monitor failed: ${e.message}`, 'err');
  }
}

async function openMonitorOnPort(existingPort) {
  const baud = parseInt($('opt-monitor-baud').value, 10) || 115200;
  log(`Opening monitor @ ${baud} baud${existingPort ? ' (reusing flash port)' : ''}...`);
  activeMonitor = await openMonitor({
    baud,
    port: existingPort,
    onLine: (line) => log(`> ${line}`),
  });
  setMonitorBtn(true);
}

function setMonitorBtn(open) {
  const b = $('monitor-btn');
  b.textContent = open ? 'Close serial monitor' : 'Open serial monitor…';
  b.classList.toggle('primary', open);
  b.classList.toggle('ghost', !open);
}

init();
