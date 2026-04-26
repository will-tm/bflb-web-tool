import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEflashLoaderBootHeader, buildSegmentHeader } from '../src/bootheader.js';
import { CHIPS } from '../src/chips.js';
import { crc32 } from '../src/crc.js';

test('boot header is 176 bytes and starts with BFNP magic', () => {
  const h = buildEflashLoaderBootHeader(CHIPS.bl702, 1024);
  assert.equal(h.length, 176);
  assert.deepEqual([...h.slice(0, 4)], [0x42, 0x46, 0x4E, 0x50]);
});

test('flash cfg block uses FCFG magic and has self-consistent CRC', () => {
  const h = buildEflashLoaderBootHeader(CHIPS.bl702, 1024);
  assert.deepEqual([...h.slice(8, 12)], [0x46, 0x43, 0x46, 0x47]);
  const cfg = h.slice(12, 12 + 84);
  const dv = new DataView(h.buffer, h.byteOffset);
  const expected = crc32(cfg);
  assert.equal(dv.getUint32(96, true) >>> 0, expected);
});

test('clock cfg CRC is correct', () => {
  const h = buildEflashLoaderBootHeader(CHIPS.bl602, 1024);
  const dv = new DataView(h.buffer, h.byteOffset);
  const cfg = h.slice(100, 108);
  assert.equal(dv.getUint32(108, true) >>> 0, crc32(cfg));
});

test('header CRC covers first 172 bytes', () => {
  const h = buildEflashLoaderBootHeader(CHIPS.bl702, 1024);
  const dv = new DataView(h.buffer, h.byteOffset);
  assert.equal(dv.getUint32(172, true) >>> 0, crc32(h.slice(0, 172)));
});

test('flashoffset matches chip TCM address', () => {
  for (const chip of [CHIPS.bl602, CHIPS.bl702]) {
    const h = buildEflashLoaderBootHeader(chip, 4096);
    const dv = new DataView(h.buffer, h.byteOffset);
    assert.equal(dv.getUint32(124, true) >>> 0, chip.tcm_address >>> 0);
  }
});

test('segment header has dest, length, reserved=0 and CRC over first 12 bytes', () => {
  const sh = buildSegmentHeader(0x22010000, 0x4000);
  const dv = new DataView(sh.buffer);
  assert.equal(sh.length, 16);
  assert.equal(dv.getUint32(0, true) >>> 0, 0x22010000);
  assert.equal(dv.getUint32(4, true) >>> 0, 0x4000);
  assert.equal(dv.getUint32(8, true) >>> 0, 0);
  assert.equal(dv.getUint32(12, true) >>> 0, crc32(sh.slice(0, 12)));
});
