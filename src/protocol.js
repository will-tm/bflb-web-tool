// Bouffalo Lab ISP / eflash_loader protocol over UART.
//
// Frame layout for commands:
//   [0]      command id
//   [1]      checksum (sum of length bytes + payload, low byte) or 0
//   [2..3]   payload length (little endian uint16)
//   [4..]    payload
//
// Response layout:
//   "OK"             - success, no payload
//   "OK" + LEN(2) + PAYLOAD  - success with payload
//   "PD"             - pending (long op, retry read)
//   "FL" + ERR(2)    - failure with error code

import { buildEflashLoaderBootHeader, buildSegmentHeader } from './bootheader.js';
import { sleep } from './transport.js';

export const CMD = {
  GET_BOOT_INFO:     0x10,
  LOAD_BOOT_HEADER:  0x11,
  LOAD_SEG_HEADER:   0x17,
  LOAD_SEG_DATA:     0x18,
  CHECK_IMAGE:       0x19,
  RUN_IMAGE:         0x1A,
  CHANGE_BAUD:       0x20,
  RESET:             0x21,
  CLOCK_SET:         0x22,
  SET_TIMEOUT:       0x23,
  FLASH_ERASE:       0x30,
  FLASH_WRITE:       0x31,
  FLASH_READ:        0x32,
  FLASH_BOOT:        0x33,
  FLASH_XIP_READ:    0x34,
  FLASH_READ_JID:    0x36,
  PROGRAM_CHECK:     0x3A,
  FLASH_LOAD_PARA:   0x3B,
  FLASH_CHIP_ERASE:  0x3C,
  FLASH_READ_SHA:    0x3D,
  FLASH_XIP_READ_SHA:0x3E,
  EFUSE_WRITE:       0x40,
  EFUSE_READ:        0x41,
  MEM_WRITE:         0x50,
  MEM_READ:          0x51,
};

const ERR_NAMES = {
  0x0001: 'flash init error',
  0x0002: 'flash erase error',
  0x0003: 'flash write error',
  0x0004: 'flash boot error',
  0x0005: 'flash set parameter error',
  0x0006: 'flash read jedec id error',
  0x0007: 'flash read XIP register error',
  0x0008: 'flash CRC error',
  0x0009: 'flash sec block read error',
  0x000A: 'flash sec block write error',
  0x000B: 'flash 32 bit address read error',
  0x000C: 'cmd ID error',
  0x000D: 'cmd length error',
  0x000E: 'cmd checksum error',
  0x000F: 'cmd CRC error',
  0x0010: 'image bootheader length error',
  0x0011: 'image bootheader not loaded',
  0x0012: 'image bootheader magic error',
  0x0013: 'image bootheader CRC error',
  0x0014: 'image bootheader encrypt not fit',
  0x0015: 'image bootheader sign not fit',
  0x0016: 'image segment count error',
  0x0017: 'image AES IV length error',
  0x0018: 'image AES IV CRC error',
  0x0019: 'image public key length error',
  0x001A: 'image public key hash error',
  0x001B: 'image signature length error',
  0x001C: 'image signature parse error',
  0x001D: 'image signature verify error',
  0x001E: 'image segment header length error',
  0x001F: 'image segment header CRC error',
  0x0020: 'image segment AES decrypt error',
  0x0021: 'image segment magic error',
  0x0022: 'image segment data length error',
  0x0023: 'image segment data decrypt error',
  0x0024: 'image segment data tail invalid',
  0x0025: 'image segment data hash error',
  0x0026: 'image segment data CRC error',
};

export function describeError(code) {
  const hex = '0x' + code.toString(16).padStart(4, '0').toUpperCase();
  const name = ERR_NAMES[code] || 'unknown';
  return `${hex} (${name})`;
}

const TEXT_DECODER = new TextDecoder();

export class ISPClient {
  /**
   * @param {object} chip - chip definition (see chips.js)
   * @param {SerialTransport} transport - opened transport
   * @param {(msg)=>void} [log]
   */
  constructor(chip, transport, log = () => {}) {
    this.chip = chip;
    this.transport = transport;
    this.log = log;
    this.inEflashLoader = false;
  }

  // ----------- low level frame I/O -----------

  async sendCommand(cmd, payload = new Uint8Array(0), withChecksum = true) {
    const len = payload.length;
    const buf = new Uint8Array(4 + len);
    buf[0] = cmd;
    buf[1] = 0;
    buf[2] = len & 0xFF;
    buf[3] = (len >> 8) & 0xFF;
    buf.set(payload, 4);
    if (withChecksum) {
      let cs = (buf[2] + buf[3]) & 0xFF;
      for (let i = 0; i < len; i++) cs = (cs + payload[i]) & 0xFF;
      buf[1] = cs;
    }
    await this.transport.write(buf);
  }

  /**
   * Read a response frame.
   * @param {boolean} expectPayload - whether to read trailing length+payload
   * @param {number} timeout - ms; 0 = wait forever (used for long erases)
   *
   * Mirrors bflb_interface_uart.if_deal_response: when payload is expected,
   * read 2-byte chunks in a loop and discard any extra "OK" sequences before
   * treating the next 2 bytes as the length field. Some firmware sometimes
   * emits a duplicate OK ack before the length, especially over USB-CDC.
   */
  async receiveResponse(expectPayload = false, timeout = 1000) {
    const head = await this.transport.read(2, timeout);
    const tag = TEXT_DECODER.decode(head);
    if (tag === 'OK') {
      if (!expectPayload) return new Uint8Array(0);
      // Skip any extra "OK" pairs (defensive — see if_deal_response()).
      let lenBuf;
      while (true) {
        lenBuf = await this.transport.read(2, timeout);
        if (!(lenBuf[0] === 0x4F && lenBuf[1] === 0x4B)) break;
      }
      const dataLen = lenBuf[0] | (lenBuf[1] << 8);
      if (dataLen === 0) return new Uint8Array(0);
      return await this.transport.read(dataLen, timeout);
    }
    if (tag === 'PD') return 'pending';
    if (tag === 'FL') {
      const errBuf = await this.transport.read(2, timeout);
      const code = errBuf[0] | (errBuf[1] << 8);
      throw new ISPError(code, `chip returned error ${describeError(code)}`);
    }
    throw new Error(`unexpected response head: ${[...head].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
  }

  /** Send + receive, retrying on PD until OK / FL / timeout. */
  async cmdAck(cmd, payload, expectPayload = false, timeout = 1000) {
    // Drain any stale bytes in the RX buffer first. If a previous response
    // got out of sync (eg. UART noise inserting a phantom 0xff), the leftover
    // would otherwise corrupt this read. Discarded bytes are gone; the next
    // legit response is fully framed by sendCommand.
    const stale = this.transport.drainBuffered();
    if (stale.length) {
      this.log(`drained ${stale.length} stale RX byte(s) before cmd 0x${cmd.toString(16)}`);
    }
    await this.sendCommand(cmd, payload, true);
    while (true) {
      const r = await this.receiveResponse(expectPayload, timeout);
      if (r === 'pending') continue;
      return r;
    }
  }

  // ----------- handshake / boot info -----------

  async toggleBootMode({ holdMs = 50, releaseMs = 100 } = {}) {
    // Normal DTR/RTS dance per blisp:
    //   RTS=on, DTR=on  -> reset asserted, BOOT high
    //   wait 50 ms
    //   DTR=off         -> release boot pin (still in reset)
    //   wait 100 ms
    //   RTS=off         -> release reset
    //   wait 50 ms      -> let BootROM init
    await this.transport.setSignals({ requestToSend: true,  dataTerminalReady: true });
    await sleep(holdMs);
    await this.transport.setSignals({ dataTerminalReady: false });
    await sleep(releaseMs);
    await this.transport.setSignals({ requestToSend: false });
    await sleep(50);
  }

  async sendSyncBytes(baudRate) {
    let n = Math.floor(this.chip.handshake_byte_multiplier * baudRate / 10);
    if (n > 600) n = 600;
    if (n < 1) n = 1;
    const buf = new Uint8Array(n).fill(0x55);
    await this.transport.write(buf);
    if (this.chip.second_handshake) {
      await sleep(300);
      await this.transport.write(this.chip.second_handshake);
    }
  }

  async handshake({ doToggleBootMode = true, attempts = 5, baudRate = null } = {}) {
    baudRate = baudRate || this.chip.boot_speed;
    for (let i = 0; i < attempts; i++) {
      if (doToggleBootMode) await this.toggleBootMode();
      this.transport.drainBuffered();
      await this.sendSyncBytes(baudRate);
      const ack = await this.transport.readUpTo(150);
      // Look for 'O','K' anywhere in the response window.
      for (let k = 0; k + 1 < ack.length; k++) {
        if (ack[k] === 0x4F && ack[k + 1] === 0x4B) {
          this.log(`handshake OK (attempt ${i + 1})`);
          return true;
        }
      }
      this.log(`handshake retry ${i + 1}/${attempts}` + (ack.length ? ` got ${[...ack].map(b => b.toString(16).padStart(2, '0')).join(' ')}` : ' (no reply)'));
      doToggleBootMode = doToggleBootMode; // keep toggling between attempts
    }
    throw new Error('handshake failed after all attempts');
  }

  async getBootInfo() {
    const payload = await this.cmdAck(CMD.GET_BOOT_INFO, new Uint8Array(0), true, 500);
    const bootRom = payload.slice(0, 4);
    const off = this.chip.chipid_offset;
    const idLen = this.chip.chipid_len;
    const chipIdRaw = payload.slice(off, off + idLen);
    // BL602/BL808/BL616: store reversed for "natural" reading (matches Bouffalo).
    let chipId;
    if (this.chip.type === 'bl702' || this.chip.type === 'bl702l') {
      chipId = chipIdRaw;
    } else {
      chipId = new Uint8Array(idLen);
      for (let i = 0; i < idLen; i++) chipId[i] = chipIdRaw[idLen - 1 - i];
    }
    return {
      bootRom,
      chipId,
      bootRomStr: [...bootRom].map(b => b.toString().padStart(1, '0')).join('.'),
      chipIdHex: [...chipId].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(''),
      raw: payload,
      alreadyInLoader: bootRom[0] === 0xFF && bootRom[1] === 0xFF && bootRom[2] === 0xFF && bootRom[3] === 0xFF,
    };
  }

  /**
   * Resolve flash_pin from the GET_BOOT_INFO payload, mirroring
   * bflb_eflash_loader.flash_get_pin_from_bootinfo.
   *
   * @param {Uint8Array} bootInfoRaw - raw payload bytes from GET_BOOT_INFO
   * @param {string} kind - 'bl702l' | 'bl616' | 'bl808'
   */
  static resolveFlashPin(bootInfoRaw, kind) {
    const dv = new DataView(bootInfoRaw.buffer, bootInfoRaw.byteOffset, bootInfoRaw.byteLength);
    if (kind === 'bl808' || kind === 'bl616') {
      // sw_usage_data = u32_le at offset 8
      const sw = dv.getUint32(8, true) >>> 0;
      const mask = kind === 'bl808' ? 0x1F : 0x3F;
      return (sw >>> 14) & mask;
    }
    if (kind === 'bl702l') {
      // dev_info_data = u32_le at offset 12
      const dev = dv.getUint32(12, true) >>> 0;
      const flash_cfg = (dev >>> 26) & 7;
      const sf_reverse = (dev >>> 29) & 1;
      const sf_swap_cfg = (dev >>> 22) & 3;
      if (flash_cfg === 0) return 0;
      return sf_reverse === 0 ? sf_swap_cfg + 1 : sf_swap_cfg + 5;
    }
    return 0x80;
  }

  // ----------- BootROM RAM-load (eflash_loader path) -----------

  async loadBootHeader(headerBytes) {
    if (headerBytes.length !== this.chip.bootheader_data_len) {
      throw new Error(`boot header length ${headerBytes.length} != expected ${this.chip.bootheader_data_len}`);
    }
    await this.sendCommand(CMD.LOAD_BOOT_HEADER, headerBytes, false);
    await this.receiveResponse(false, 1000);
  }

  async loadSegmentHeader(segHdr) {
    await this.sendCommand(CMD.LOAD_SEG_HEADER, segHdr, false);
    await this.receiveResponse(true, 1000); // returns decrypted seg header echo
  }

  async loadSegmentData(payload, onProgress) {
    const CHUNK = 4080;
    let sent = 0;
    while (sent < payload.length) {
      const left = Math.min(CHUNK, payload.length - sent);
      await this.sendCommand(CMD.LOAD_SEG_DATA, payload.subarray(sent, sent + left), false);
      await this.receiveResponse(false, 2000);
      sent += left;
      if (onProgress) onProgress(sent, payload.length);
    }
  }

  async checkImage() {
    await this.sendCommand(CMD.CHECK_IMAGE, new Uint8Array(0), false);
    await this.receiveResponse(false, 1000);
  }

  async runImage() {
    if (this.chip.custom_run_image) {
      // BL70x errata: write to TCM via memory_write instead of run_image opcode.
      await this.memWrite(0x4000F100, 0x4E424845, true);
      await this.memWrite(0x4000F104, 0x22010000, true);
      await this.memWrite(0x40000018, 0x00000002, false);
      return;
    }
    await this.sendCommand(CMD.RUN_IMAGE, new Uint8Array(0), false);
    await this.receiveResponse(false, 2000);
  }

  async loadEflashLoader(loaderBin, onProgress) {
    const header = buildEflashLoaderBootHeader(this.chip, loaderBin.length);
    await this.loadBootHeader(header);
    const segHdr = buildSegmentHeader(this.chip.tcm_address, loaderBin.length);
    await this.loadSegmentHeader(segHdr);
    await this.loadSegmentData(loaderBin, onProgress);
    await this.checkImage();
    await this.runImage();
    await sleep(500);
    // Re-handshake without resetting (we are now talking to eflash_loader).
    await this.handshake({ doToggleBootMode: false });
    this.inEflashLoader = true;
  }

  // ----------- newer-chip BootROM flash path (bl616/bl808/bl702l/bl606p) -----------

  async setClockPll({ irqEn = true, speed = null, clockPara = new Uint8Array(0), changeBaud = null } = {}) {
    speed = speed || this.chip.work_speed;
    const payload = new Uint8Array(8 + clockPara.length);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, irqEn ? 1 : 0, true);
    dv.setUint32(4, speed >>> 0, true);
    if (clockPara.length) payload.set(clockPara, 8);
    await this.cmdAck(CMD.CLOCK_SET, payload, false, 2000);
    // Chip switches its UART to `speed` after responding. Only reopen the port
    // if the baud actually changes — Web Serial mandates a close+open cycle
    // for baud changes which is wasteful (and breaks fake transports) when the
    // host is already talking at that rate.
    const target = changeBaud !== undefined && changeBaud !== null ? changeBaud : speed;
    if (changeBaud !== false && target !== this.transport.baudRate) {
      await this.transport.setBaudRate(target);
    }
    await sleep(50);
  }

  /**
   * Send cmd 0x3B (flash_set_para). Payload = u32 flash_set + optional 84-byte
   * flash_para blob. flash_set is (pin) | (clk_cfg<<8) | (io_mode<<16) | (delay<<24).
   */
  async setFlashPara(flashSet, flashPara = new Uint8Array(0)) {
    const payload = new Uint8Array(4 + flashPara.length);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, flashSet >>> 0, true);
    if (flashPara.length) payload.set(flashPara, 4);
    await this.cmdAck(CMD.FLASH_LOAD_PARA, payload, false, 2000);
  }

  async clearBootStatus() {
    if (!this.chip.clear_boot_status_addr) return;
    // memory_write: write 0x00000000 to the chip's "boot status" HBN reserved
    // register. The chip ACKs this one (matches bflb_eflash_loader.clear_boot_status).
    await this.memWrite(this.chip.clear_boot_status_addr, 0x00000000, true);
  }

  // ----------- flash ops (work in both eflash_loader and BootROM-direct chips) -----------

  async memWrite(addr, value, waitForAck = true) {
    const p = new Uint8Array(8);
    const dv = new DataView(p.buffer);
    dv.setUint32(0, addr >>> 0, true);
    dv.setUint32(4, value >>> 0, true);
    if (waitForAck) await this.cmdAck(CMD.MEM_WRITE, p, false, 1000);
    else await this.sendCommand(CMD.MEM_WRITE, p, true);
  }

  async flashErase(start, end) {
    const p = new Uint8Array(8);
    const dv = new DataView(p.buffer);
    dv.setUint32(0, start >>> 0, true);
    dv.setUint32(4, end >>> 0, true);
    const t = this.chip.long_erase_timeout ? 0 : 30000;
    await this.cmdAck(CMD.FLASH_ERASE, p, false, t);
  }

  async chipErase() {
    const t = this.chip.long_erase_timeout ? 0 : 60000;
    await this.cmdAck(CMD.FLASH_CHIP_ERASE, new Uint8Array(0), false, t);
  }

  async flashWrite(start, payload, onProgress) {
    const CHUNK = 2048; // eflash_loader supports up to 8184 but 2KB is conservative
    let sent = 0;
    while (sent < payload.length) {
      const left = Math.min(CHUNK, payload.length - sent);
      const buf = new Uint8Array(4 + left);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, (start + sent) >>> 0, true);
      buf.set(payload.subarray(sent, sent + left), 4);
      await this.cmdAck(CMD.FLASH_WRITE, buf, false, 5000);
      sent += left;
      if (onProgress) onProgress(sent, payload.length);
    }
  }

  /**
   * Ask the chip for SHA256 of a flash region. Returns a 32-byte Uint8Array.
   * One short round-trip — much more reliable than reading the whole region
   * back over the wire (one dropped chunk would invalidate a byte-compare).
   */
  async flashReadSha(start, length) {
    const p = new Uint8Array(8);
    const dv = new DataView(p.buffer);
    dv.setUint32(0, start >>> 0, true);
    dv.setUint32(4, length >>> 0, true);
    // Larger regions take longer for the chip to hash; budget conservatively.
    const timeout = Math.max(5000, 2000 + Math.ceil(length / 1024) * 2);
    const sha = await this.cmdAck(CMD.FLASH_READ_SHA, p, true, timeout);
    if (sha.length !== 32) throw new Error(`flash_readSha returned ${sha.length} bytes, expected 32`);
    return sha;
  }

  async flashRead(start, length, onProgress) {
    const CHUNK = 2048;
    const out = new Uint8Array(length);
    let off = 0;
    while (off < length) {
      const left = Math.min(CHUNK, length - off);
      const p = new Uint8Array(8);
      const dv = new DataView(p.buffer);
      dv.setUint32(0, (start + off) >>> 0, true);
      dv.setUint32(4, left, true);
      const data = await this.cmdAck(CMD.FLASH_READ, p, true, 5000);
      out.set(data, off);
      off += data.length;
      if (onProgress) onProgress(off, length);
    }
    return out;
  }

  async programCheck() {
    await this.cmdAck(CMD.PROGRAM_CHECK, new Uint8Array(0), false, 5000);
  }

  async reset() {
    try {
      await this.cmdAck(CMD.RESET, new Uint8Array(0), false, 1000);
    } catch (e) {
      // Some chips drop the ack and reboot immediately; ignore.
    }
  }
}

export class ISPError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}
