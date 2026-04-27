// Web Serial transport. Wraps a SerialPort behind a small async API
// (read/write/setSignals/setBaudRate) so the protocol layer is environment-agnostic.

const SUPPORTED_BAUDS = [115200, 230400, 460800, 921600, 1_000_000, 1_500_000, 2_000_000, 3_000_000];

export class SerialTransport {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this._rxBuf = new Uint8Array(0);
    this._closed = false;
    this._readLoop = null;
    this._waiters = [];
  }

  static async request({ filters = [] } = {}) {
    if (!('serial' in navigator)) {
      throw new Error('Web Serial API not available. Use Chromium 89+, an HTTPS origin or http://localhost.');
    }
    const port = await navigator.serial.requestPort({ filters });
    return port;
  }

  async open(baudRate) {
    await this.port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 16384,
    });
    this.baudRate = baudRate;
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this._closed = false;
    this._readLoop = this._pump();
  }

  async _pump() {
    try {
      while (!this._closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) {
          this._appendRx(value);
        }
      }
    } catch (e) {
      // Reader was cancelled or port lost.
    }
  }

  _appendRx(chunk) {
    const merged = new Uint8Array(this._rxBuf.length + chunk.length);
    merged.set(this._rxBuf, 0);
    merged.set(chunk, this._rxBuf.length);
    this._rxBuf = merged;
    while (this._waiters.length && this._rxBuf.length >= this._waiters[0].n) {
      const w = this._waiters.shift();
      const out = this._rxBuf.slice(0, w.n);
      this._rxBuf = this._rxBuf.slice(w.n);
      clearTimeout(w.timer);
      w.resolve(out);
    }
  }

  async write(data) {
    if (!this.writer) throw new Error('port not open');
    await this.writer.write(data);
  }

  /**
   * Read exactly `n` bytes or reject after `timeout` ms.
   * Pass timeout = 0 for "wait forever" (used for long erase ops).
   */
  read(n, timeout = 1000) {
    return new Promise((resolve, reject) => {
      if (this._rxBuf.length >= n) {
        const out = this._rxBuf.slice(0, n);
        this._rxBuf = this._rxBuf.slice(n);
        return resolve(out);
      }
      const w = { n, resolve, reject, timer: null };
      if (timeout > 0) {
        w.timer = setTimeout(() => {
          const idx = this._waiters.indexOf(w);
          if (idx >= 0) this._waiters.splice(idx, 1);
          reject(new Error(`read timeout: wanted ${n} bytes, have ${this._rxBuf.length}`));
        }, timeout);
      }
      this._waiters.push(w);
    });
  }

  /** Drain whatever is currently buffered. */
  drainBuffered() {
    const out = this._rxBuf;
    this._rxBuf = new Uint8Array(0);
    return out;
  }

  /** Wait `ms` milliseconds, then return whatever arrived. */
  async readUpTo(ms) {
    await sleep(ms);
    return this.drainBuffered();
  }

  async setSignals({ dataTerminalReady, requestToSend } = {}) {
    const sig = {};
    if (typeof dataTerminalReady === 'boolean') sig.dataTerminalReady = dataTerminalReady;
    if (typeof requestToSend === 'boolean') sig.requestToSend = requestToSend;
    if (Object.keys(sig).length) await this.port.setSignals(sig);
  }

  /**
   * VID/PID of the underlying USB device, if exposed by the browser.
   * Returns null on non-USB ports or when the browser hides the IDs.
   */
  usbInfo() {
    try {
      const info = this.port.getInfo?.() || {};
      if (info.usbVendorId == null || info.usbProductId == null) return null;
      return { vid: info.usbVendorId, pid: info.usbProductId };
    } catch (_) {
      return null;
    }
  }

  /**
   * Bouffalo "magic string" boot-mode trigger used by USB-CDC bridges that
   * ignore the standard CDC SetControlLineState (CKLink-Lite, etc).
   *
   * The bridge firmware intercepts these literal strings written to the data
   * endpoint and translates them into GPIO toggles on the chip's BOOT/RESET
   * pins. Mirrors bflb_interface_uart.py "bouffalo" mode (lines 924-936,
   * 1159-1171): DTR0 then RTS0 then RTS1.
   */
  async magicTriggerBoufBootMode() {
    const enc = new TextEncoder();
    await this.write(enc.encode('BOUFFALOLAB5555DTR0'));
    await sleep(10);
    await this.write(enc.encode('BOUFFALOLAB5555RTS0'));
    await sleep(10);
    await this.write(enc.encode('BOUFFALOLAB5555RTS1'));
  }

  /**
   * Magic-string reset for chips with NATIVE USB (BL702/BL702L USB variants,
   * etc — VID:PID FFFF:FFFF). The chip's BootROM listens for this exact
   * string + 2 trailing bytes (boot_revert, reset_revert) and self-resets
   * into ISP mode. Mirrors bflb_interface_uart.bl_usb_serial_write.
   */
  async magicResetNativeUsb({ bootRevert = 0, resetRevert = 1 } = {}) {
    const enc = new TextEncoder();
    const head = enc.encode('BOUFFALOLAB5555RESET');
    const buf = new Uint8Array(head.length + 2);
    buf.set(head, 0);
    buf[head.length]     = bootRevert & 0xFF;
    buf[head.length + 1] = resetRevert & 0xFF;
    await this.write(buf);
    await sleep(50);
  }

  async setBaudRate(baud) {
    // Web Serial cannot mutate baud on an open port; close + reopen.
    if (!SUPPORTED_BAUDS.includes(baud)) {
      // not fatal — many ports accept arbitrary bauds.
    }
    await this._closeStreams();
    await this.port.close();
    await this.open(baud);
  }

  async _closeStreams() {
    this._closed = true;
    try { await this.reader.cancel(); } catch (e) {}
    try { this.reader.releaseLock(); } catch (e) {}
    try { this.writer.releaseLock(); } catch (e) {}
    if (this._readLoop) {
      try { await this._readLoop; } catch (e) {}
    }
  }

  async close() {
    await this._closeStreams();
    try { await this.port.close(); } catch (e) {}
  }
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
