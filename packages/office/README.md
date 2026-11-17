# advisers-office

Office artifact builders for **Advisers**. The model writes a small JSON spec;
this package produces a real, editable file:

| Builder | Output |
|---|---|
| `buildDocx(spec)` | Word `.docx` (title, headings, paragraphs, bullets, tables) |
| `buildXlsx(spec)` | Excel `.xlsx` (columns, rows, number formats, frozen header, formulas) |
| `buildPptx(spec)` | PowerPoint `.pptx` (cover, bullets, tables, speaker notes) |
| `buildMermaid(spec)` | Mermaid source (`flowchart`, `mindmap`, `gantt`) |
| `buildDrawio(spec)` | draw.io / diagrams.net XML (editable Visio alternative) |
| `buildXmind(spec)` | XMind mind map (`.xmind`; minimal XMind 2020+ file, no styling) |
| `validateOffice(buffer, kind)` | ZIP/OOXML sanity check |
| `containsText(buffer, text)` | assert that the text made it into the package |

## Example

```ts
import { buildDocx, validateOffice } from 'advisers-office'

const buffer = await buildDocx({
  title: 'Q4 预算说明',
  sections: [
    { heading: '结论', paragraphs: ['预算整体可控。'] },
    { heading: '明细', table: { headers: ['项目', '金额'], rows: [['市场', '120']] } },
  ],
})

const check = await validateOffice(buffer, 'docx')
```

## CLI

```sh
# stable channel: advisers@latest / advisers-office@latest (0.2.0 until 0.2.1 is approved)
# pre-release channel: advisers@next / advisers-office@next (currently also 0.2.0)
npm i -g advisers@latest advisers-office@latest
advisers office docx spec.json out.docx
advisers office xlsx spec.json out.xlsx
advisers office pptx spec.json out.pptx
advisers office mermaid spec.json out.mmd
advisers office drawio spec.json out.drawio
```

All builders are deterministic; no macros, no external links, no remote
templates. CJK fonts default to Microsoft YaHei, with a system fallback.

## Status

`0.2.1` is the current release (published on npm `latest`, 2026-11-17). Builders: DOCX/XLSX/PPTX/Mermaid/draw.io/XMind; 7 templates; `readOffice`/`editOffice`/`verifyOffice`. Structural verification only (no Word/WPS/LibreOffice application layer in this package).

## License

Software: [PolyForm Noncommercial License 1.0.0](LICENSE) (SPDX
`PolyForm-Noncommercial-1.0.0`); see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Source-available, not open source and not an OSI-approved open source license;
commercial use requires a separate commercial license (open an issue at
<https://github.com/PerryLink/advisers/issues>).

Documentation, evaluation data and design materials of the repository are licensed under
[CC BY-NC-SA 4.0](https://github.com/PerryLink/advisers/blob/main/LICENSE-DOCS); this
package README ships with the software and is covered by PolyForm NC. Third-party
components keep their own licenses: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Versions published before 0.2.0 keep their original licenses (MIT; Apache-2.0 for
`advisers@0.2.0-preview.71`); the change is not retroactive. See the repository
LICENSING.md, LICENSE-DOCS and NOTICE.
