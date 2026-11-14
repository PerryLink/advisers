# OFD / OCR boundary (E7)

## OFD (implemented, read-only)

`advisers office-read file.ofd` and attachments (`.ofd`) extract text from an OFD
package (ZIP + XML): it scans `Content.xml` / `Pages/*.xml` for `TextCode`
elements and returns decoded text. It does **not** edit/render OFD.

Tests: `packages/advisers/test/ofd.test.js` builds an OFD fixture with
`OFD.xml` + `Doc_0/Pages/Page_0/Content.xml` and verifies extraction.

## OCR (local adapter; no cloud OCR)

Advisers does **not** bundle an OCR engine and never calls a cloud OCR service.

- `advisers ocr <image> [--out text]` runs a local executable configured with
  `ADVISERS_OCR_CMD` (e.g. tesseract), passing the image path as its only arg.
- Image attachments (`.png/.jpg/.jpeg/.webp/.bmp/.tif/.tiff`) use the same local
  adapter; without it they fail closed with a clear error.
- Output is capped (200k chars) and the child process has a 30s timeout; no shell
  interpolation, no network.
- Scanned PDFs are still rejected (`no extractable text`) because PDF→image
  conversion is not part of this adapter.
- `docs/REMOTE-PARSE-PRIVACY.md` remains design-only; remote OCR is not enabled.

This is an explicit opt-in local adapter, not a claim of built-in OCR quality.
