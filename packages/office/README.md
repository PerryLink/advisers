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
npm i -g advisers@next advisers-office@next
advisers office docx spec.json out.docx
advisers office xlsx spec.json out.xlsx
advisers office pptx spec.json out.pptx
advisers office mermaid spec.json out.mmd
advisers office drawio spec.json out.drawio
```

All builders are deterministic; no macros, no external links, no remote
templates. CJK fonts default to Microsoft YaHei, with a system fallback.

## Status

`0.1.0-preview.1`. XMind import/export is not implemented yet; Mermaid and
draw.io are the editable diagram outputs.

## License

MIT.
