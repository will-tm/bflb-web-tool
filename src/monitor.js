// Bare-bones serial monitor. Opens a SerialPort at the requested baud and
// streams everything that comes in. The host->device direction is intentionally
// not exposed in the UI yet — flash output is mostly one-way for these chips.

import { sleep } from './transport.js';

const TEXT = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

export class SerialMonitor {
  /**
   * @param {SerialPort} port
   * @param {number} baudRate
   * @param {(line:string)=>void} onLine - called per newline-terminated line
   * @param {(raw:Uint8Array)=>void} [onRaw] - optional raw byte sink
   */
  constructor(port, baudRate, onLine, onRaw) {
    this.port = port;
    this.baudRate = baudRate;
    this.onLine = onLine;
    this.onRaw = onRaw;
    this._buf = '';
    this._reader = null;
    this._stop = false;
    this._task = null;
  }

  async open() {
    await this.port.open({
      baudRate: this.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 16384,
    });
    this._task = this._pump();
  }

  async _pump() {
    try {
      this._reader = this.port.readable.getReader();
      while (!this._stop) {
        const { value, done } = await this._reader.read();
        if (done) break;
        if (value && value.length) {
          if (this.onRaw) this.onRaw(value);
          const text = TEXT.decode(value, { stream: true });
          this._buf += text;
          let nl;
          while ((nl = this._buf.indexOf('\n')) !== -1) {
            const line = this._buf.slice(0, nl).replace(/\r$/, '');
            this._buf = this._buf.slice(nl + 1);
            this.onLine(line);
          }
        }
      }
    } catch (e) {
      this.onLine(`<monitor read error: ${e.message}>`);
    }
  }

  async close() {
    this._stop = true;
    try { await this._reader?.cancel(); } catch (_) {}
    try { this._reader?.releaseLock(); } catch (_) {}
    if (this._task) {
      try { await this._task; } catch (_) {}
    }
    if (this._buf.length) {
      this.onLine(this._buf);
      this._buf = '';
    }
    try { await this.port.close(); } catch (_) {}
  }
}

/**
 * Convenience: ask the user to pick a port (or reuse one), open it at `baud`,
 * pipe lines into `onLine`, and return the monitor instance so the caller can
 * close it later.
 */
export async function openMonitor({ baud, onLine, port = null }) {
  if (!('serial' in navigator)) throw new Error('Web Serial API unavailable');
  const sp = port || await navigator.serial.requestPort();
  const m = new SerialMonitor(sp, baud, onLine);
  await m.open();
  return m;
}
