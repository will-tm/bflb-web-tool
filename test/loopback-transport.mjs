// In-memory transport for protocol unit tests.
// Wraps two paired streams: the "host" side has a queue of bytes that the
// fake chip will consume, and the chip pushes responses back into the host's RX.

export class LoopbackTransport {
  constructor() {
    this.rx = []; // bytes available to host's read()
    this.txLog = []; // everything the host has written (chip POV input)
    this.signals = { dataTerminalReady: false, requestToSend: false };
    this._waiters = [];
  }

  // SerialTransport API surface -----------------------------------------
  async write(data) { for (const b of data) this.txLog.push(b); }

  async read(n, timeout = 1000) {
    if (this.rx.length >= n) return Uint8Array.from(this.rx.splice(0, n));
    return new Promise((resolve, reject) => {
      const w = { n, resolve, reject, timer: null };
      if (timeout > 0) {
        w.timer = setTimeout(() => {
          const i = this._waiters.indexOf(w);
          if (i >= 0) this._waiters.splice(i, 1);
          reject(new Error(`loopback read timeout (wanted ${n}, have ${this.rx.length})`));
        }, timeout);
      }
      this._waiters.push(w);
    });
  }

  drainBuffered() {
    const out = Uint8Array.from(this.rx);
    this.rx = [];
    return out;
  }

  async readUpTo(ms) { await new Promise(r => setTimeout(r, ms)); return this.drainBuffered(); }
  async setSignals(s) { Object.assign(this.signals, s); }
  async setBaudRate(b) { this.baud = b; }
  async close() {}
  usbInfo() { return this._usb || null; }
  setUsbInfo(usb) { this._usb = usb; }
  async magicTriggerBoufBootMode() { this.magicCalled = (this.magicCalled || 0) + 1; }
  async magicResetNativeUsb() { this.magicResetCalled = (this.magicResetCalled || 0) + 1; }

  // Helpers for the fake chip --------------------------------------------
  /** Push bytes that the host will receive next. */
  injectRx(bytes) {
    for (const b of bytes) this.rx.push(b);
    while (this._waiters.length && this.rx.length >= this._waiters[0].n) {
      const w = this._waiters.shift();
      clearTimeout(w.timer);
      w.resolve(Uint8Array.from(this.rx.splice(0, w.n)));
    }
  }

  /** Pull what the host has sent so far. */
  takeTx() {
    const out = Uint8Array.from(this.txLog);
    this.txLog = [];
    return out;
  }
}
