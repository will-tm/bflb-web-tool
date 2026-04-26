// Build a flashable image from a raw application .bin by patching a stock
// bootinfo template. Mirrors what bflb_mcu_tool/libs/<chip>/img_create_do.py
// does in img_create_update_bootheader().
//
// The template (one per chip) was generated with `bflb-mcu-tool-uart --build`
// against a tiny .bin and then bundled verbatim under assets/chip_para/. The
// template carries the full FCFG/PCFG/CPU-cfg/FCTG blocks that BootROM needs;
// we only patch three dynamic fields per chip (img_len, hash[32], header crc32)
// and pad the payload to a 16-byte boundary to match what the python tool does.

import { crc32 } from './crc.js';

const APP_FLASH_OFFSET = 0x2000;
const ENCRYPT_BLK = 16; // payload aligned to 16 bytes (matches bflb_img_create.padding)

async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(h);
}

function padToBlock(buf, block = ENCRYPT_BLK) {
  if (buf.length % block === 0) return buf;
  const need = block - (buf.length % block);
  const out = new Uint8Array(buf.length + need);
  out.set(buf, 0);
  return out;
}

function setBytes(buf, off, src) { for (let i = 0; i < src.length; i++) buf[off + i] = src[i]; }
function u32le(view, off, v) { view.setUint32(off, v >>> 0, true); }

/** A bin already starts with "BFNP" → it's a whole_img.bin, flash as-is at 0x0. */
export function hasBootHeader(buf) {
  return buf.length >= 4 && buf[0] === 0x42 && buf[1] === 0x46 && buf[2] === 0x4E && buf[3] === 0x50;
}

/**
 * Patch a chip's bootinfo template for a specific payload.
 * Returns { bootinfo, paddedPayload }.
 *
 * Per-chip offsets come from chips.js -> chip.bootinfo_layout:
 *   img_len_off  - where to write the (padded) payload length (uint32 LE)
 *   hash_off     - where to write the 32-byte SHA256 of the padded payload
 *   crc_off      - where to write the boot-header CRC32 (covers bytes [0..crc_off])
 */
export async function patchBootinfo(rawPayload, template, layout) {
  if (!template || !layout) throw new Error('missing template or layout');
  if (template.length < layout.crc_off + 4) {
    throw new Error(`template too short for layout (got ${template.length}, need >=${layout.crc_off + 4})`);
  }
  const paddedPayload = padToBlock(rawPayload);
  const bootinfo = new Uint8Array(template.length);
  bootinfo.set(template, 0);
  const dv = new DataView(bootinfo.buffer);

  u32le(dv, layout.img_len_off, paddedPayload.length);
  const hash = await sha256(paddedPayload);
  setBytes(bootinfo, layout.hash_off, hash);
  u32le(dv, layout.crc_off, crc32(bootinfo.subarray(0, layout.crc_off)));

  return { bootinfo, paddedPayload };
}

/**
 * Build the full set of regions to flash for a raw payload.
 *
 * Returns [{address, data}, ...]. If the payload already has a BFNP header,
 * returns [{address: 0, data: payload}] unchanged.
 *
 * For chips with secondary group bootheaders (BL808, BL606P), an extra
 * `group1_bootinfo` region is included verbatim — those contain the empty
 * DSP-CPU placeholder that bouffalo's tool always lays down.
 */
export async function buildFlashRegions(chip, rawPayload, assets) {
  if (hasBootHeader(rawPayload)) {
    return [{ address: 0x0, data: rawPayload }];
  }
  if (!chip.bootinfo_layout) {
    throw new Error(`chip ${chip.type} has no bootinfo_layout configured`);
  }
  const tpl = assets.bootinfoTemplate;
  if (!tpl) throw new Error(`chip ${chip.type} bundled bootinfo template missing`);

  const { bootinfo, paddedPayload } = await patchBootinfo(rawPayload, tpl, chip.bootinfo_layout);
  const regions = [{ address: 0x0, data: bootinfo }];
  if (chip.bootinfo_group1_address != null && assets.group1Bootinfo) {
    regions.push({ address: chip.bootinfo_group1_address, data: assets.group1Bootinfo });
  }
  regions.push({ address: chip.app_flash_offset || APP_FLASH_OFFSET, data: paddedPayload });
  return regions;
}
