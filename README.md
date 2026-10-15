# QR Scanner · TekiDeki

A universal QR and barcode scanner that runs entirely in the browser. Scan with the camera or from an image file, and get product details for EAN/UPC codes from Open Food Facts. **No account, no tracking, no backend, no CDN, no build step to use it.**

[Live app](https://tekideki.github.io/QR-Scanner/) · [Apache-2.0](LICENSE) · [Support with a coffee](https://paypal.me/TekiDeki)

## What it does

- Reads **QR codes and 1D/2D barcodes**: QR, Data Matrix, EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, ITF (ITF-14).
- Understands the content instead of dumping raw text: links, plain text, **WiFi** credentials, **vCard** contacts, e-mail, phone, SMS, geo coordinates and product codes.
- **Product enrichment from Open Food Facts** for EAN/UPC codes: name, brand, quantity, Nutri-Score, NOVA group, ingredients, allergens and a small product image. Lookups are optional, cached on the device for 30 days and can be turned off at any time.
- **Scans from an image**: choose a file, drag and drop it onto the drop zone, or paste a screenshot with `Ctrl+V`.
- **Scan history** (last 500 codes) with search, type filters, statistics, per-entry show/copy/delete, JSON export and JSON import with duplicate and invalid-record reporting.
- **Camera controls**: front/rear switch, torch/flashlight where the device supports it, continuous or single-shot scanning, vibration and beep feedback.
- **Română, English, Srpski (Latin), Српски (Cyrillic)**. Language links below.
- Light and dark theme, keyboard navigation, screen-reader announcements, skip link, visible focus, reduced-motion and high-contrast friendly styles.
- **Works offline** after the first visit: an installable PWA with an offline app shell. Scanning, history and imported codes keep working with no network at all; only the product lookup needs a connection.

## Decoding engines

The app picks the best engine available on the device and falls back gracefully:

1. **Native `BarcodeDetector`** when the browser provides it (Chrome/Edge on desktop and Android). This is fast and hardware-assisted.
2. **Bundled ZXing** ([`@zxing/library`](https://github.com/zxing-js/library) 0.23.0, Apache-2.0, inlined into `index.html`) as the dependable fallback, for example on iOS Safari where `BarcodeDetector` is not available.

Both engines decode the same formats, so behavior is consistent between browsers and between the live camera and image files.

## Product data from Open Food Facts

- Lookups go **directly from your browser** to `https://world.openfoodfacts.org/api/v2/product/<barcode>.json`, with a `fields=` filter so only the displayed fields are transferred, and with a descriptive User-Agent that identifies the app.
- Results are **cached on the device** (up to 300 products, 30 days) and re-used; the app also keeps working with no network at all.
- Product data is made available by [Open Food Facts](https://world.openfoodfacts.org/) under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Attribution ("Open Food Facts (ODbL)") is shown next to any product data. No Open Food Facts data is redistributed with this repository.
- Nutri-Score and NOVA values are shown exactly as Open Food Facts reports them. This app adds no nutritional judgment of its own.
- The OFF API is free and public. **Please do not hammer it** - the built-in cache is there for that reason.

## Open or install

Use the [hosted app](https://tekideki.github.io/QR-Scanner/), or download the repository and open `index.html` directly. Direct file opening does not support service workers, and camera access from `file://` is blocked by browsers - scanning from an image still works.

For local testing (camera and PWA need `http://localhost` or HTTPS):

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. Android/desktop browsers may offer **Install app**. On iPhone/iPad, open in Safari and use **Share → Add to Home Screen**. Installation availability depends on browser support and policy.

### Language and deep links

- [RO](https://tekideki.github.io/QR-Scanner/?lang=ro) · [EN](https://tekideki.github.io/QR-Scanner/?lang=en) · [SR Latin](https://tekideki.github.io/QR-Scanner/?lang=sr-Latn) · [SR Cyrillic](https://tekideki.github.io/QR-Scanner/?lang=sr-Cyrl)
- `?tab=scan`, `?tab=history`, `?tab=about` open a specific tab (used by the installable app shortcuts).
- The chosen language is stored locally and wins over the browser language on later visits; a `?lang=` link always wins for that visit.

### Keyboard

- `Space` - start or stop the camera (ignored while a control has focus)
- `1` / `2` / `3` - Scan, History, About tabs
- `Ctrl` + `V` - scan a code from an image in the clipboard
- `Tab` / `Shift+Tab` - move through controls; dialogs trap focus and `Esc` closes them

## Privacy

- No accounts, no analytics, no ads, no cookies, no server of ours.
- Camera frames are processed **in the page** and are never uploaded or stored. Nothing is captured until you press start, and the camera stops when you leave the tab or press stop.
- History, settings and the product cache live in your browser's local storage. They are removed by the app's own "clear" actions, or by clearing site data.
- The only network requests are the two the app makes on your behalf: loading the page itself, and product lookups to Open Food Facts.
- Scanned codes can contain personal data (WiFi passwords, contacts). They stay on your device unless you export them yourself, and the app warns before opening unknown links.

## Limits and known behavior

- Image files up to 12 MB are accepted; larger ones are refused with a message.
- History keeps the most recent 500 entries, the product cache 300 entries / 30 days.
- The torch button only appears when the active camera actually reports torch support.
- Very dense or blurry codes may need a second attempt, better light, or a closer image. Cropped photos with a small code benefit from the `TRY_HARDER` decode pass that is always enabled.
- `BarcodeDetector` support varies by browser and platform; when it is missing the bundled ZXing engine is used, so no error is shown - the status line tells you which engine is active.

## Technical notes

- The application is a **single `index.html`**: HTML, CSS, the app script, the translations and the vendored ZXing library are inlined, so the app also runs from a plain file or a USB stick. No framework, no runtime dependencies, no CDN.
- The repository also ships the small files a PWA needs: `manifest.json`, `sw.js`, icons, `og-image.png`, `robots.txt`, `sitemap.xml`.
- The development sources live in `src/` (`template.html`, `styles.css`, `i18n.js`, `app.js`) and are assembled into `index.html` by `build.py`:

```sh
python3 build.py   # writes index.html next to the repository files
```

- The vendored library is unmodified: `@zxing/library` 0.23.0, downloaded from npm, integrity verified against the registry, minified exactly as published upstream, then inlined. Its license text is kept at [`vendor/zxing-LICENSE.txt`](vendor/zxing-LICENSE.txt) and summarized in [`NOTICE`](NOTICE).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The whole application (single file) |
| `manifest.json` | PWA metadata, icons, screenshots, shortcuts |
| `sw.js` | Offline app shell (cache `tekideki-qr-scanner-v1`) |
| `icon-*.png`, `apple-touch-icon.png`, `favicon.ico` | Icons |
| `og-image.png` | Social preview image |
| `screenshots/` | PWA screenshots referenced by the manifest |
| `robots.txt`, `sitemap.xml` | Crawling hints for the hosted copy |
| `NOTICE`, `vendor/zxing-LICENSE.txt` | Third-party licenses |
| `src/`, `build.py` | Development sources and build script |
| `LICENSE` | Apache-2.0 |

The npm tarball the library was taken from is not committed; only the inlined result, its license text and the build script are.

## License

Apache License 2.0 - see [LICENSE](LICENSE) and [NOTICE](NOTICE). Bundled ZXing is Apache-2.0 as well; its full text and copyright notices are reproduced in `vendor/zxing-LICENSE.txt`.

Support: [paypal.me/TekiDeki](https://paypal.me/TekiDeki) or the Sponsor button on the repository.

---

Built by TekiDeki. Scanned content is shown as-is: always check a link or a payment code before trusting it.
