import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hasBootHeader, patchBootinfo, buildFlashRegions } from '../src/whole_img.js';
import { CHIPS, listChips } from '../src/chips.js';
import { crc32 } from '../src/crc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BFLB = '/Users/will/Development/Embedded/zephyr-bl702l/.venv/lib/python3.14/site-packages/bflb_mcu_tool';
const TINY_BIN = '/tmp/tiny.bin';

async function loadAsset(rel) { return new Uint8Array(await readFile(join(ROOT, rel))); }
async function loadAbs(p) { try { return new Uint8Array(await readFile(p)); } catch { return null; } }

test('hasBootHeader detects BFNP magic', () => {
  assert.equal(hasBootHeader(new Uint8Array([0x42, 0x46, 0x4E, 0x50, 0xff])), true);
  assert.equal(hasBootHeader(new Uint8Array([0x97, 0x12, 0x00, 0x00])), false);
  assert.equal(hasBootHeader(new Uint8Array(2)), false);
});

test('every chip has a bootinfo_template + bootinfo_layout', () => {
  for (const c of listChips()) {
    assert.ok(c.bootinfo_template, `${c.type} missing bootinfo_template`);
    assert.ok(c.bootinfo_layout, `${c.type} missing bootinfo_layout`);
    const { img_len_off, hash_off, crc_off } = c.bootinfo_layout;
    assert.equal(typeof img_len_off, 'number');
    assert.equal(typeof hash_off, 'number');
    assert.equal(typeof crc_off, 'number');
    assert.ok(crc_off > hash_off, `${c.type} crc must come after hash`);
  }
});

test('every chip template is loadable and large enough for its layout', async () => {
  for (const c of listChips()) {
    const tpl = await loadAsset(c.bootinfo_template);
    assert.ok(tpl.length >= c.bootinfo_layout.crc_off + 4,
      `${c.type} template ${tpl.length}B too small for crc_off=${c.bootinfo_layout.crc_off}`);
  }
});

// Per-chip byte-for-byte comparison against bflb-mcu-tool's own output.
// We feed the SAME tiny.bin into both pipelines and assert identical bootinfo.
const PER_CHIP = [
  { id: 'bl602',  ref: `${BFLB}/chips/bl602/img_create_mcu/bootinfo.bin` },
  { id: 'bl702',  ref: `${BFLB}/chips/bl702/img_create_mcu/bootinfo.bin` },
  { id: 'bl702l', ref: `${BFLB}/chips/bl702l/img_create_mcu/bootinfo.bin` },
  { id: 'bl616',  ref: `${BFLB}/chips/bl616/img_create_mcu/bootinfo.bin` },
  { id: 'bl808',  ref: `${BFLB}/chips/bl808/img_create_mcu/bootinfo_group0.bin` },
  { id: 'bl606p', ref: `${BFLB}/chips/bl606p/img_create_mcu/bootinfo_group0.bin` },
];

for (const { id, ref } of PER_CHIP) {
  test(`${id}: patched bootinfo matches bflb-mcu-tool byte-for-byte for tiny.bin`, async () => {
    const chip = CHIPS[id];
    const tpl = await loadAsset(chip.bootinfo_template);
    const tiny = await loadAbs(TINY_BIN);
    const refBootinfo = await loadAbs(ref);
    if (!tiny || !refBootinfo) {
      console.log(`SKIP ${id}: tiny.bin or reference bootinfo missing (run \`for c in bl602 bl702 bl702l bl616 bl808 bl606p; do bflb-mcu-tool-uart --chipname=$c --port=/dev/null --firmware=/tmp/tiny.bin --build; done\`)`);
      return;
    }
    const { bootinfo, paddedPayload } = await patchBootinfo(tiny, tpl, chip.bootinfo_layout);
    assert.equal(bootinfo.length, refBootinfo.length, `${id} length mismatch`);
    assert.equal(paddedPayload.length, tiny.length, `${id} tiny.bin (${tiny.length}B) is already 16-byte aligned`);
    let mismatch = -1;
    for (let i = 0; i < refBootinfo.length; i++) {
      if (bootinfo[i] !== refBootinfo[i]) { mismatch = i; break; }
    }
    if (mismatch !== -1) {
      const ours = [...bootinfo.slice(Math.max(0, mismatch - 4), mismatch + 8)].map(b => b.toString(16).padStart(2, '0')).join(' ');
      const theirs = [...refBootinfo.slice(Math.max(0, mismatch - 4), mismatch + 8)].map(b => b.toString(16).padStart(2, '0')).join(' ');
      assert.fail(`${id}: byte ${mismatch} (0x${mismatch.toString(16)}) mismatch.  ours=${ours}  ref=${theirs}`);
    }
  });
}

test('payload pads to 16-byte boundary', async () => {
  const chip = CHIPS.bl702l;
  const tpl = await loadAsset(chip.bootinfo_template);
  const payload = new Uint8Array(28332);
  const { paddedPayload } = await patchBootinfo(payload, tpl, chip.bootinfo_layout);
  assert.equal(paddedPayload.length, 28336);
});

test('buildFlashRegions returns extra group1 region for bl808/bl606p only', async () => {
  for (const id of ['bl602', 'bl702', 'bl702l', 'bl616']) {
    const chip = CHIPS[id];
    const tpl = await loadAsset(chip.bootinfo_template);
    const raw = new Uint8Array([0x97, 0, 0, 0]); // raw RV
    const r = await buildFlashRegions(chip, raw, { bootinfoTemplate: tpl });
    assert.equal(r.length, 2, `${id} should have header + payload only`);
    assert.equal(r[0].address, 0x0);
    assert.equal(r[1].address, 0x2000);
  }
  for (const id of ['bl808', 'bl606p']) {
    const chip = CHIPS[id];
    const tpl  = await loadAsset(chip.bootinfo_template);
    const grp1 = await loadAsset(chip.bootinfo_group1_template);
    const raw  = new Uint8Array([0x97, 0, 0, 0]);
    const r = await buildFlashRegions(chip, raw, { bootinfoTemplate: tpl, group1Bootinfo: grp1 });
    assert.equal(r.length, 3, `${id} should have header + group1 + payload`);
    assert.equal(r[0].address, 0x0);
    assert.equal(r[1].address, 0x1000);
    assert.equal(r[2].address, 0x2000);
  }
});

test('whole_img passthrough: BFNP-prefixed bin is flashed as-is at 0x0', async () => {
  const whole = new Uint8Array(2048);
  whole.set([0x42, 0x46, 0x4E, 0x50], 0);
  for (const id of Object.keys(CHIPS)) {
    const r = await buildFlashRegions(CHIPS[id], whole, {});
    assert.equal(r.length, 1, `${id} pass-through`);
    assert.equal(r[0].address, 0x0);
    assert.equal(r[0].data, whole);
  }
});
