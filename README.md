# BLFB Web Flasher

Flash any **Bouffalo Lab BL chip** (BL602/BL604, BL616/BL618, BL702/BL704,
BL702L/BL704L, BL606P, BL808) from a Chromium-based browser over UART. No
install — it's a static page that uses the Web Serial API.

## Usage

1. Open the [hosted page](https://localhost:8765) (or serve it yourself, see
   below).
2. Pick the chip family.
3. Drop your `.bin` on the page or click **Choose .bin…** — works with both raw
   app images (e.g. `zephyr.bin`) and pre-built `whole_img.bin`.
4. (Optional) pick a **Flash baud** — default is 2 000 000.
5. Click **Connect & Flash**, choose the serial port in the browser prompt.
6. (Optional) tick **Auto-open after flash** to drop straight into a serial
   monitor at the chosen **Monitor baud**.

## Self-hosting

```bash
git clone https://github.com/will-tm/bflb-web-tool.git
cd bflb-web-tool
npm run serve              # http://localhost:8765
```

The whole tool is plain HTML / CSS / ES modules — no build step. Drop the
directory onto any HTTPS host (or `http://localhost`) and it works.

## Browser support

Chrome / Edge / Opera 89+ on macOS, Linux, Windows, ChromeOS. Web Serial is
not available on Firefox or Safari.

## License

MIT.
