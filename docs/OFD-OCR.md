# OFD / OCR boundary (E7)

## OFD (implemented, read-only)

`advisers office-read file.ofd` and attachments (`.ofd`) extract text from an OFD
package (ZIP + XML): it scans `Content.xml` / `Pages/*.xml` for `TextCode`
elements and returns decoded text. It does **not** edit/render OFD.

Tests: `packages/advisers/test/ofd.test.js` builds an OFD fixture with
`OFD.xml` + `Doc_0/Pages/Page_0/Content.xml` and verifies extraction.

## OCR (not implemented; fail closed)

Scanned PDFs/images are **not** silently accepted. Today:

- `attachments` rejects a PDF with no extractable text (`scanned PDF?`).
- There is no OCR dependency, no external OCR binary requirement, and no image
  upload/model path.
- `docs/REMOTE-PARSE-PRIVACY.md` is design-only; remote parsing is not enabled.

A future OCR implementation must be an explicit opt-in local adapter (not a
network service), with page/byte limits, a clear error code when confidence is
low, and an audit event. Until then, the product must say "scanned files are not
supported", not pretend to read them.
