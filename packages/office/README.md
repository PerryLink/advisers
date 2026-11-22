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
# stable channel: advisers@latest / advisers-office@latest (now 0.4.2, published 2026-11-22)
# pre-release channel: advisers@next / advisers-office@next (also 0.4.2)
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

`0.4.2` was published on 2026-11-22 (npm `latest` = `0.4.2`; `next` is also `0.4.2`);
0.4.2 is the current release (lockstep version), a patch on the 0.4.1 same-day follow-up,
and this package's public surface is unchanged from 0.3.2. 0.3.1 was a release-metadata patch over 0.3.0 with no runtime,
CLI or interface changes; 0.3.2 added the customer/performance closeout in the `advisers`
and `dsh-advisers` packages. The 0.2.4 candidate superseded by the 0.3.0 line was never published, and
`0.2.2`/`0.2.1`/`0.2.0` remain installable by pinning. Builders: DOCX/XLSX/PPTX/Mermaid/draw.io/XMind; 7 templates; `readOffice`/`editOffice`/`verifyOffice`; the CLI adds deterministic quote/proposal templates on top of these builders. The recalculation subprocess (`ADVISERS_VERIFY_RECALC_CMD`) now runs with an explicit OS-basics environment allowlist. Structural verification only (no Word/WPS/LibreOffice application layer in this package).

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
