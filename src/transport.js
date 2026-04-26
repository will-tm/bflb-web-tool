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
