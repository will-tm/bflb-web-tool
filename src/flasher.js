// High-level flash flow: open port -> handshake -> set up loader/clock ->
// erase -> write -> verify -> reset.

import { SerialTransport, sleep } from './transport.js';
import { ISPClient, describeError } from './protocol.js';
import { buildFlashRegions, hasBootHeader } from './whole_img.js';

export async function fetchEflashLoader(chip) {
  if (!chip.eflash_loader) return null;
  const r = await fetch(chip.eflash_loader);
  if (!r.ok) throw new Error(`failed to fetch ${chip.eflash_loader}: HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (chip.eflash_loader_clock_offset != null) {
    buf[chip.eflash_loader_clock_offset] = chip.eflash_loader_clock_value;
  }
  return buf;
}

async function fetchAsset(url) {
  if (!url) return null;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} failed: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * Wrap user's payload in a BootROM-bootable image if it isn't already one.
 * Returns the regions list to pass to flash().
 */
export async function prepareRegions(chip, rawPayload) {
  if (hasBootHeader(rawPayload)) {
    return { regions: [{ address: 0x0, data: rawPayload }], wrapped: false };
  }
  const bootinfoTemplate = await fetchAsset(chip.bootinfo_template);
  if (!bootinfoTemplate) {
    throw new Error(`raw payload missing BFNP boot header and chip ${chip.type} has no bundled bootinfo template`);
  }
  const group1Bootinfo = await fetchAsset(chip.bootinfo_group1_template); // null if undef
  const regions = await buildFlashRegions(chip, rawPayload, { bootinfoTemplate, group1Bootinfo });
  return { regions, wrapped: true };
}

/**
 * Run a full flash job.
 * @param {object} opts
 * @param {object} opts.chip            chip definition
 * @param {SerialPort} opts.port        already-granted Web Serial port
 * @param {Array<{address:number,data:Uint8Array}>} opts.regions  what to write
 * @param {number} [opts.flashBaud]     desired flash baud (overrides chip.work_speed)
 * @param {boolean} [opts.verify=true]  read-back + sha-compare each region
 * @param {boolean} [opts.reset=true]   reset chip when done
 * @param {(pct:number, msg:string)=>void} [opts.onProgress]
 * @param {(line:string)=>void}            [opts.onLog]
 */
export async function flash({ chip, port, regions, flashBaud = null, verify = true, reset = true, onProgress, onLog } = {}) {
  const log = onLog || (() => {});
  const setProg = onProgress || (() => {});

  const transport = new SerialTransport(port);
  await transport.open(chip.boot_speed);

  const isp = new ISPClient(chip, transport, log);
  const workSpeed = flashBaud || chip.work_speed;

  try {
    log(`Connecting at ${chip.boot_speed} baud (will switch to ${workSpeed}), chip = ${chip.name}`);
    setProg(0.02, 'Handshaking...');
    await isp.handshake();
    setProg(0.05, 'Reading boot info');
    const info = await isp.getBootInfo();
    log(`BootROM ${info.bootRomStr}, ChipID ${info.chipIdHex}`);

    if (chip.load_function === 1) {
      // Load eflash_loader into TCM.
      const loader = await fetchEflashLoader(chip);
      if (!loader) throw new Error(`chip ${chip.type} has no eflash_loader bundled`);
      log(`Loading eflash_loader (${loader.length} bytes) into TCM @ 0x${chip.tcm_address.toString(16)}`);
      await isp.loadEflashLoader(loader, (s, t) => setProg(0.05 + 0.10 * (s / t), `Uploading loader ${s}/${t}`));
    } else {
      // BootROM-direct path. Mirror bflb_eflash_loader load_function==2:
      //  1. set_clock_pll with chip's clock_para (always — chip won't accept
      //     flash commands without it, even if baud doesn't change)
      //  2. clear_boot_status (BL616/BL808/BL606P)
      //  3. flash_set_para with flash_set | (pin from bootinfo if 0x80) + flash_para
      if (chip.needs_clock_pll) {
        const clockPara = await fetchAsset(chip.clock_para);
        log(`Setting clock PLL @ ${workSpeed} (clock_para ${clockPara ? clockPara.length : 0} B)`);
        await isp.setClockPll({ speed: workSpeed, clockPara: clockPara || new Uint8Array(0) });
      }
      if (chip.clear_boot_status_addr) {
        log(`Clearing boot status @ 0x${chip.clear_boot_status_addr.toString(16)}`);
        await isp.clearBootStatus();
      }
      if (chip.flash_set_base != null) {
        let pin = (chip.flash_set_base >>> 0) & 0xFF;
        if (pin === 0 && chip.flash_pin_from_bootinfo) {
          // 0x80 marker (or bare 0) — resolve from bootinfo payload
          pin = ISPClient.resolveFlashPin(info.raw, chip.flash_pin_from_bootinfo);
        }
        const flashSet = ((chip.flash_set_base >>> 0) & 0xFFFFFF00) | (pin & 0xFF);
        const flashPara = await fetchAsset(chip.flash_para);
        log(`Setting flash para: flash_set=0x${flashSet.toString(16)} (pin=0x${pin.toString(16)}, para=${flashPara ? flashPara.length : 0} B)`);
        await isp.setFlashPara(flashSet, flashPara || new Uint8Array(0));
      }
    }

    setProg(0.18, 'Loader ready');

    // Phase: erase + write per region.
    let total = regions.reduce((a, r) => a + r.data.length, 0);
    let done = 0;

    for (const region of regions) {
      const { address, data } = region;
      const end = address + data.length - 1;
      log(`Erasing 0x${address.toString(16)}..0x${end.toString(16)} (${data.length} bytes)`);
      await isp.flashErase(address, end);

      log(`Writing 0x${address.toString(16)}+${data.length}`);
      await isp.flashWrite(address, data, (sent, t) => {
        const frac = (done + sent) / total;
        setProg(0.20 + 0.55 * frac, `Writing ${(sent / 1024).toFixed(1)}/${(t / 1024).toFixed(1)} kB @ 0x${address.toString(16)}`);
      });
      done += data.length;
    }

    if (verify) {
      let vDone = 0;
      for (const { address, data } of regions) {
        log(`Verifying 0x${address.toString(16)}+${data.length}`);
        const back = await isp.flashRead(address, data.length, (s, t) => {
          const frac = (vDone + s) / total;
          setProg(0.78 + 0.18 * frac, `Verifying ${(s / 1024).toFixed(1)}/${(t / 1024).toFixed(1)} kB`);
        });
        for (let i = 0; i < data.length; i++) {
          if (back[i] !== data[i]) {
            throw new Error(`verify mismatch at 0x${(address + i).toString(16)}: wrote 0x${data[i].toString(16)}, read 0x${back[i].toString(16)}`);
          }
        }
        vDone += data.length;
      }
    }

    setProg(0.97, 'Resetting');
    if (reset) await isp.reset();
    setProg(1, 'Done');
    log('Flash complete!');
  } finally {
    try { await transport.close(); } catch (e) {}
  }
}
