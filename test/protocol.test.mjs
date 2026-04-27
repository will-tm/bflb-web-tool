import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopbackTransport } from './loopback-transport.mjs';
import { ISPClient, CMD, ISPError } from '../src/protocol.js';
import { CHIPS } from '../src/chips.js';
import { crc32 } from '../src/crc.js';

const ENC_OK = [0x4F, 0x4B];      // "OK"
const ENC_FL = [0x46, 0x4C];      // "FL"
const ENC_PD = [0x50, 0x44];      // "PD"

test('crc32 matches known IEEE 802.3 reference', () => {
  // crc32("123456789") === 0xCBF43926
  const data = new TextEncoder().encode('123456789');
  assert.equal(crc32(data) >>> 0, 0xCBF43926);
});

test('frame layout matches blisp send_command', async () => {
  const t = new LoopbackTransport();
  const c = new ISPClient(CHIPS.bl702, t);
  // No reply expected; just inspect what was written.
  await c.sendCommand(CMD.GET_BOOT_INFO, new Uint8Array(0), false);
  assert.deepEqual([...t.takeTx()], [0x10, 0x00, 0x00, 0x00]);

  // mem_write payload: addr=0x4000F100, value=0x4E424845
  await c.memWrite(0x4000F100, 0x4E424845, false);
  const tx = t.takeTx();
  assert.equal(tx[0], 0x50);                                   // cmd
  assert.equal(tx[2] | (tx[3] << 8), 8);                       // payload len
  // checksum = (low+high length bytes + payload bytes) & 0xff
  let sum = (tx[2] + tx[3]) & 0xff;
  for (let i = 4; i < 4 + 8; i++) sum = (sum + tx[i]) & 0xff;
  assert.equal(tx[1], sum);
  // payload addr/value little-endian
  const dv = new DataView(tx.buffer, tx.byteOffset + 4, 8);
  assert.equal(dv.getUint32(0, true) >>> 0, 0x4000F100);
  assert.equal(dv.getUint32(4, true) >>> 0, 0x4E424845);
});

test('receiveResponse parses OK with payload', async () => {
  const t = new LoopbackTransport();
  const c = new ISPClient(CHIPS.bl702, t);
  // queue: OK + len=4 + 0xAA 0xBB 0xCC 0xDD
  t.injectRx([...ENC_OK, 0x04, 0x00, 0xAA, 0xBB, 0xCC, 0xDD]);
  const r = await c.receiveResponse(true, 200);
  assert.deepEqual([...r], [0xAA, 0xBB, 0xCC, 0xDD]);
});

// cmdAck now drains rxBuf at the start of every command (defensive against
// off-by-one corruption from UART noise). For tests that exercise cmdAck via
// public methods, inject the canned response *after* sendCommand has run.
function injectAfterSend(t, bytes, delayMs = 5) {
  setTimeout(() => t.injectRx(bytes), delayMs);
}

test('receiveResponse FL throws ISPError with code', async () => {
  const t = new LoopbackTransport();
  const c = new ISPClient(CHIPS.bl702, t);
  t.injectRx([...ENC_FL, 0x0E, 0x00]); // 0x000E = checksum error
  await assert.rejects(c.receiveResponse(false, 200), (e) => e instanceof ISPError && e.code === 0x000E);
});

test('cmdAck retries through PD and resolves on OK', async () => {
  const t = new LoopbackTransport();
  const c = new ISPClient(CHIPS.bl702, t);
  // first reply PD, then OK with no payload — inject after the cmd is sent
  injectAfterSend(t, [...ENC_PD]);
  injectAfterSend(t, [...ENC_OK], 20);
  await c.cmdAck(CMD.FLASH_ERASE, new Uint8Array(8), false, 200);
});

test('flashWrite chunks payload and includes leading address', async () => {
  const t = new LoopbackTransport();
  const c = new ISPClient(CHIPS.bl702, t);
  const payload = new Uint8Array(2048 + 100); // 2 chunks (2048-byte chunk, then 100)
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  // Inject responses after each chunk's drain+send.
  injectAfterSend(t, [...ENC_OK], 5);
  injectAfterSend(t, [...ENC_OK], 30);
  await c.flashWrite(0x10000, payload);
  const tx = t.takeTx();
  // First frame: cmd=0x31, len=2048+4=2052
  assert.equal(tx[0], 0x31);
  assert.equal(tx[2] | (tx[3] << 8), 2052);
  const dv = new DataView(tx.buffer, tx.byteOffset);
  assert.equal(dv.getUint32(4, true) >>> 0, 0x10000);
  // Second frame at offset 4 + 2052 = 2056
  const off2 = 4 + 2052;
  assert.equal(tx[off2], 0x31);
  assert.equal(tx[off2 + 2] | (tx[off2 + 3] << 8), 4 + 100);
  assert.equal(dv.getUint32(off2 + 4, true) >>> 0, 0x10000 + 2048);
});

test('handshake sends 0x55 burst sized for chip multiplier and accepts OK', async () => {
  const t = new LoopbackTransport();
  const c = new ISPClient(CHIPS.bl702, t);
  // Handshake calls drainBuffered() before sending sync, so we must inject the
  // OK *after* it starts. Schedule inside the readUpTo window.
  const done = c.handshake({ doToggleBootMode: false, attempts: 1, baudRate: 2_000_000 });
  setTimeout(() => t.injectRx([...ENC_OK]), 30);
  await done;
  const tx = t.takeTx();
  // BL702 multiplier=0.003 @ 2,000,000 baud / 10 = 600 bytes of 0x55
  assert.equal(tx.length, 600);
  for (const b of tx) assert.equal(b, 0x55);
});

test('toggleBootMode uses CKLink magic strings on VID:PID 42BF:B210', async () => {
  const t = new LoopbackTransport();
  t.setUsbInfo({ vid: 0x42BF, pid: 0xB210 });
  // Sentinel — toggleBootMode should NOT touch this if it picks the magic path.
  t.signals.requestToSend = 'untouched';
  const c = new ISPClient(CHIPS.bl702l, t);
  await c.toggleBootMode();
  assert.equal(t.magicCalled, 1, 'should have called magicTriggerBoufBootMode once');
  assert.equal(t.signals.requestToSend, 'untouched', 'should NOT have touched setSignals');
});

test('toggleBootMode uses BOUFFALOLAB5555RESET on VID:PID FFFF:FFFF (native USB)', async () => {
  const t = new LoopbackTransport();
  t.setUsbInfo({ vid: 0xFFFF, pid: 0xFFFF });
  const c = new ISPClient(CHIPS.bl702l, t);
  await c.toggleBootMode();
  assert.equal(t.magicResetCalled, 1, 'should have called magicResetNativeUsb once');
});

test('toggleBootMode falls back to standard DTR/RTS on generic USB-Serial', async () => {
  const t = new LoopbackTransport();
  t.setUsbInfo({ vid: 0x10C4, pid: 0xEA60 }); // Silicon Labs CP2102
  const c = new ISPClient(CHIPS.bl702l, t);
  await c.toggleBootMode();
  // After the dance, DTR ends low and RTS ends low.
  assert.equal(t.signals.dataTerminalReady, false);
  assert.equal(t.signals.requestToSend, false);
  assert.ok(!t.magicCalled);
  assert.ok(!t.magicResetCalled);
});

test('handshake throws after exhausting attempts', async () => {
  const t = new LoopbackTransport();
  const c = new ISPClient(CHIPS.bl702, t);
  await assert.rejects(c.handshake({ doToggleBootMode: false, attempts: 2 }), /handshake failed/);
});

test('getBootInfo decodes BL702 chip id correctly', async () => {
  const t = new LoopbackTransport();
  const c = new ISPClient(CHIPS.bl702, t);
  // OK + len=24 + 4 boot rom + 12 reserved + 8 chipid
  const reply = new Uint8Array(24);
  reply.set([1, 2, 3, 4], 0);
  reply.set([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x11, 0x22, 0x33], 16);
  injectAfterSend(t, [...ENC_OK, 24, 0, ...reply]);
  const info = await c.getBootInfo();
  assert.deepEqual([...info.bootRom], [1, 2, 3, 4]);
  // BL702 chip id is preserved verbatim
  assert.equal(info.chipIdHex, 'DEADBEEF00112233');
});

test('getBootInfo reverses chip id for BL602/BL616/BL808 family', async () => {
  const t = new LoopbackTransport();
  const c = new ISPClient(CHIPS.bl616, t);
  const reply = new Uint8Array(20);
  reply.set([0xFF, 0xFF, 0xFF, 0xFF], 0);
  // chip id bytes at offset 12, length 8
  reply.set([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88], 12);
  injectAfterSend(t, [...ENC_OK, 20, 0, ...reply]);
  const info = await c.getBootInfo();
  assert.equal(info.chipIdHex, '8877665544332211');
  assert.equal(info.alreadyInLoader, true);
});
