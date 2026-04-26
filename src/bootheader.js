// Build a 176-byte BFNP boot header used to load the eflash_loader into TCM.
// Mirrors the structure that blisp_easy_load_ram_app() fills in.

import { crc32 } from './crc.js';

function u32le(view, off, v) { view.setUint32(off, v >>> 0, true); }
function u16le(view, off, v) { view.setUint16(off, v & 0xFFFF, true); }
function u8(view, off, v)    { view.setUint8(off, v & 0xFF); }
function bytes(view, off, arr) { for (let i = 0; i < arr.length; i++) view.setUint8(off + i, arr[i]); }

/**
 * Build a single-segment RAM boot header for the eflash_loader.
 * @param {object} chip - chip definition
 * @param {number} payloadLen - eflash_loader.bin length (already trimmed)
 * @returns {Uint8Array} 176-byte header
 */
export function buildEflashLoaderBootHeader(chip, payloadLen) {
  const buf = new Uint8Array(176);
  const dv = new DataView(buf.buffer);

  // magiccode "BFNP"
  bytes(dv, 0, [0x42, 0x46, 0x4E, 0x50]);
  u32le(dv, 4, 0x01); // revision

  // flashCfg: magic "FCFG" + 84-byte cfg + 4-byte CRC = 92 bytes total starting at 8
  bytes(dv, 8, [0x46, 0x43, 0x46, 0x47]);
  const flashCfgOff = 12;
  // ioMode .. qeData (84 bytes)
  const fc = [
    0x04, 0x01, 0x01, 0x01, // ioMode, cReadSupport, clkDelay, clkInvert
    0x66, 0x99, 0xFF, 0x03, // resetEnCmd, resetCmd, resetCreadCmd, resetCreadCmdSize
    0x9F, 0x00, 0x9F, 0x00, // jedecIdCmd, jedecIdCmdDmyClk, qpiJedecIdCmd, qpiJedecIdCmdDmyClk
    0x04, 0xEF,             // sectorSize, mid
    0x00, 0x01,             // pageSize little-endian = 0x0100
    0xC7, 0x20, 0x52, 0xD8, // chipEraseCmd, sectorEraseCmd, blk32EraseCmd, blk64EraseCmd
    0x06, 0x02, 0x32, 0x00, // writeEnableCmd, pageProgramCmd, qpageProgramCmd, qppAddrMode
    0x0B, 0x01, 0x0B, 0x01, // fastReadCmd, frDmyClk, qpiFastReadCmd, qpiFrDmyClk
    0x3B, 0x01, 0xBB, 0x00, // fastReadDoCmd, frDoDmyClk, fastReadDioCmd, frDioDmyClk
    0x6B, 0x01, 0xEB, 0x02, // fastReadQoCmd, frQoDmyClk, fastReadQioCmd, frQioDmyClk
    0xEB, 0x02, 0x02,       // qpiFastReadQioCmd, qpiFrQioDmyClk, qpiPageProgramCmd
    0x50, 0x00, 0x01, 0x00, // writeVregEnableCmd, wrEnableIndex, qeIndex, busyIndex
    0x01, 0x01, 0x00,       // wrEnableBit, qeBit, busyBit
    0x02, 0x01, 0x01, 0x01, // wrEnableWriteRegLen, wrEnableReadRegLen, qeWriteRegLen, qeReadRegLen
    0xAB, 0x01,             // releasePowerDown, busyReadRegLen
    0x05, 0x35, 0x00, 0x00, // readRegCmd[0..3]
    0x01, 0x31, 0x00, 0x00, // writeRegCmd[0..3]
    0x38, 0xFF, 0x20, 0xFF, // enterQpi, exitQpi, cReadMode, cRExit
    0x77, 0x03, 0x02, 0x40, // burstWrapCmd, burstWrapCmdDmyClk, burstWrapDataMode, burstWrapData
    0x77, 0x03, 0x02, 0xF0, // deBurstWrapCmd, ..., deBurstWrapData
    0x2C, 0x01,             // timeEsector  uint16 LE = 0x012C
    0xB0, 0x04,             // timeE32k     uint16 LE = 0x04B0
    0xB0, 0x04,             // timeE64k     uint16 LE = 0x04B0
    0x05, 0x00,             // timePagePgm  uint16 LE = 0x0005
    0x40, 0x0D,             // timeCe       uint16 LE = 0x0D40
    0x03, 0x00,             // pdDelay, qeData
  ];
  if (fc.length !== 84) throw new Error(`flashCfg length mismatch: ${fc.length}`);
  bytes(dv, flashCfgOff, fc);
  // crc32 over the 84 cfg bytes
  const fcCrc = crc32(buf.subarray(flashCfgOff, flashCfgOff + 84));
  u32le(dv, flashCfgOff + 84, fcCrc); // off 96

  // clkCfg: 8-byte cfg + 4-byte CRC, starting at 100
  // xtal=4 (40M), pll_clk=4, hclk_div=0, bclk_div=1, flash_clk_type=2, flash_clk_div=0, rsvd[0,1]=0
  const clkOff = 100;
  bytes(dv, clkOff, [0x04, 0x04, 0x00, 0x01, 0x02, 0x00, 0x00, 0x00]);
  const clkCrc = crc32(buf.subarray(clkOff, clkOff + 8));
  u32le(dv, clkOff + 8, clkCrc); // off 108

  // bootcfg (4 bytes) starting at 112: just set crc_ignore=1, hash_ignore=1, no_segment=1, cache_enable=1
  // bit layout: [0:1]=sign, [2:3]=encrypt, [4:5]=key_sel, [6:7]=rsvd, [8]=no_segment,
  //             [9]=cache_enable, ..., [16]=crc_ignore, [17]=hash_ignore
  const bootcfg = (1 << 8) | (1 << 9) | (1 << 16) | (1 << 17);
  u32le(dv, 112, bootcfg);

  // segment_cnt (2 bytes) at 116, then 2 bytes reserved
  u16le(dv, 116, 1);
  u16le(dv, 118, 0);

  // bootentry @ 120
  u32le(dv, 120, 0);

  // flashoffset @ 124 = TCM dest
  u32le(dv, 124, chip.tcm_address >>> 0);

  // hash[32] @ 128 — fill with deadbeef pattern (ignored)
  bytes(dv, 128, [0xEF, 0xBE, 0xAD, 0xDE]);

  // rsv1@160, rsv2@164
  u32le(dv, 160, 0);
  u32le(dv, 164, 0);

  // crc32 placeholder @ 172 (last 4 bytes) — final header CRC over first 172 bytes
  const hdrCrc = crc32(buf.subarray(0, 172));
  u32le(dv, 172, hdrCrc);

  return buf;
}

/**
 * 16-byte segment header { dest_addr, length, reserved=0, crc32(first 12 bytes) }.
 */
export function buildSegmentHeader(destAddr, length) {
  const buf = new Uint8Array(16);
  const dv = new DataView(buf.buffer);
  u32le(dv, 0, destAddr);
  u32le(dv, 4, length);
  u32le(dv, 8, 0);
  const c = crc32(buf.subarray(0, 12));
  u32le(dv, 12, c);
  return buf;
}
