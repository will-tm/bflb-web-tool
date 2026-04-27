# BLFB Web Flasher

Flash any **Bouffalo Lab BL chip** (BL602/BL604, BL616/BL618, BL702/BL704,
BL702L/BL704L, BL606P, BL808) from a Chromium-based browser over UART. No
install — it's a static page that uses the Web Serial API.

**Hosted at <https://bflb.will-tm.io>.**

## Usage

1. Open <https://bflb.will-tm.io> (or serve it yourself, see below).
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

## Production deployment

There is **no build step**. Ship the repository contents as static files. Two
caveats apply to every host:

1. **Web Serial requires HTTPS** (or `http://localhost`). HTTP from a remote
   origin will silently disable the API.
2. **`.bin` MIME type** must be served as `application/octet-stream`
   (most static hosts already do this; nginx ships it by default).

Files that need to be served:

```
index.html
styles.css
src/                  # ES modules
assets/eflash_loaders/  # *.bin
assets/chip_para/       # *.bin
```

`node_modules/`, `test/`, `.github/`, `package.json`, and the `LICENSE` /
`README.md` can be excluded from the deploy bundle.

### GitHub Pages

```bash
# in repo root, on main
git switch -c gh-pages
git push -u origin gh-pages
```

Then in the repo Settings → Pages, point the source at `gh-pages` / `/`. The
URL becomes `https://<user>.github.io/bflb-web-tool/`.

### Netlify / Vercel / Cloudflare Pages

Connect the repo, set:
- **Build command**: *(empty)*
- **Publish directory**: `.` (the repo root)

### Plain nginx

```nginx
server {
    listen 443 ssl;
    server_name flasher.example.com;
    root /var/www/bflb-web-tool;

    # .bin compresses well — saves ~30% on first load
    gzip on;
    gzip_types application/octet-stream application/javascript text/css;

    location / { try_files $uri $uri/ =404; }
}
```

### Docker / nginx one-liner

```bash
docker run -d -p 8080:80 -v $(pwd):/usr/share/nginx/html:ro nginx:alpine
```

(Add a TLS-terminating reverse proxy for production.)

## License

MIT.
