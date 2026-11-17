# Licensing

Advisers uses a **two-license model**. It is **source-available, not open source**: the
PolyForm Noncommercial License is not an OSI-approved open source license, and Creative
Commons recommends against using CC licenses for software. The software and the
documentation/data have separate licenses, and neither is retroactive.

## Software: PolyForm Noncommercial License 1.0.0

SPDX identifier: **PolyForm-Noncommercial-1.0.0** (not OSI-approved).

- Full terms: [LICENSE](LICENSE)
- Required notice: [NOTICE](NOTICE)
- Official text: <https://polyformproject.org/licenses/noncommercial/1.0.0>

Scope (software):

- **packages/** — source code, dist/bin/lib, tests, package manifests, and the
  README.md/NOTICE/THIRD-PARTY-NOTICES.md files shipped inside npm tarballs;
- **scripts/** — repository automation;
- **.github/** — CI and release workflows;
- root package.json, pnpm-lock.yaml, pnpm-workspace.yaml;
- **executable or source-code files anywhere in the repository**, including
  `eval/**/*.mjs`, other `eval/**/*.{js,cjs,ts}`, `examples/**/*.{ts,js,mjs,cjs}` and
  shell/Python helpers — see boundary rule 1.

Permitted purposes (exact definitions are in the license):

- any noncommercial purpose;
- personal use for research, experiment, testing, study, private entertainment, hobby
  projects, amateur pursuits, or religious observance, without anticipated commercial
  application;
- use by charitable organizations, educational institutions, public research
  organizations, public safety or health organizations, environmental protection
  organizations, or government institutions.

Any other use — including use by or for a for-profit organization, internal trials and
evaluations, and **paid client work by an individual professional** — is **not** a
permitted purpose and requires a separate written commercial license. To request one, open
an issue at <https://github.com/PerryLink/advisers/issues> with the title prefix
`commercial-license`. You must not sublicense or transfer the license, and if you
distribute the software (or changes) you must pass on the license terms or URL plus the
Required Notice line in NOTICE.

## Documentation, evaluation data and design: CC BY-NC-SA 4.0

SPDX identifier: **CC-BY-NC-SA-4.0**.

- Full legal code, scope and attribution template: [LICENSE-DOCS](LICENSE-DOCS)
- Canonical legal code: <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.en>
- Deed: <https://creativecommons.org/licenses/by-nc-sa/4.0/>

Scope (documentation, data, design):

- root README.md, README-zh.md, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md,
  LICENSING.md;
- **docs/** — prose, schemas and machine-readable interface documentation;
- **eval/** — corpora, gold labels, reviews, results and non-code JSON data (the license
  also covers sui generis database rights; never add real personal information);
- **examples/** — non-code prose and data files;
- **templates/** — non-code template text and design materials.

Executable code under `eval/` and `examples/` (for example `eval/run-*.mjs` or
`examples/demo.ts`) is software, not documentation: it is licensed under PolyForm
Noncommercial 1.0.0, not CC BY-NC-SA 4.0 (boundary rule 1). Boundary rule 1 governs if a
scope statement in this file and the file class disagree.

Attribution requirement (CC BY-NC-SA 4.0 section 3(a)(1)) — use a form like:

> Advisers documentation (c) 2026 PerryLink contributors, CC BY-NC-SA 4.0,
> https://github.com/PerryLink/advisers (accessed YYYY-MM-DD); changes: describe them.

You must keep the attribution and license links, indicate whether you modified the
material, and share adaptations under the same or a compatible license (CC BY-NC-SA 4.0
or later). No commercial use. Do not add real personal information to the evaluation
corpora.

## Boundary rules

1. **One primary license per file; code wins.** If two rules seem to apply, the file class
   decides: every executable or source-code file (`*.js`, `*.mjs`, `*.cjs`, `*.ts`,
   `*.tsx`, `*.sh`, `*.py` and equivalent) anywhere in this repository — including
   `eval/` and `examples/` — is **software** and is licensed PolyForm Noncommercial 1.0.0.
   Pure prose, corpora, gold labels, JSON data/schema intended to be read as data, and
   design materials are **documentation/data** and are licensed CC BY-NC-SA 4.0. Package
   files and anything shipped inside an npm tarball are PolyForm; repository-root docs and
   `docs/**` prose are CC (subject to rule 1a). Where a file is ambiguous, code wins:
   PolyForm Noncommercial 1.0.0.
1a. **File-level exception (packaged legal texts).** `packages/advisers/lib/tos/terms.zh-CN.md`,
   `summary.zh-CN.md`, `privacy.zh-CN.md` and `safety.zh-CN.md` are byte-identical copies of
   `docs/TOS.md`, `docs/DISCLAIMER.md`, `docs/PRIVACY.md` and `docs/SAFETY.md`. They are
   shipped inside the npm tarball but remain **CC BY-NC-SA 4.0**; they do not become
   PolyForm merely because they live under `packages/**`. `scripts/check-tos.mjs` enforces
   byte-identical copies and manifest hashes.
2. Code examples inside CC-licensed documentation are licensed with the document (CC),
   unless the block is explicitly marked "SPDX-License-Identifier:
   PolyForm-Noncommercial-1.0.0".
3. **Machine-readable interface contracts are open to implementers.** JSON Schemas, test
   vectors and CLI/JSON/MCP contract documents in `docs/**` are published so third parties
   — including commercial ones — can implement interoperable consumers and producers. As an
   additional permission from the licensor, copying a schema or test vector solely to
   implement the documented interface is **not** subject to the Attribution, ShareAlike or
   NonCommercial conditions of CC BY-NC-SA 4.0; redistributing or adapting the documentation
   itself as a document still is. This permission does not change the software licence:
   running or modifying the software still requires compliance with PolyForm Noncommercial
   1.0.0 (and a commercial licence for commercial use). No trademark or endorsement right is
   granted.
4. Third-party policy packs, DLC and Link providers are licensed by their own
   publisher; this project's LICENSE/NOTICE does not cover them.
5. LICENSE, LICENSE-DOCS and NOTICE are license texts and notices; they are distributed
   as-is and are not themselves relicensed.
6. Evaluations and templates are **not** relicensed by their use: outputs you produce with
   Advisers templates (DOCX/XLSX/PPTX and similar deliverables) are yours to use and
   distribute, including commercially, and the NC/SA conditions of CC BY-NC-SA 4.0 do not
   apply to your output documents. This permission does not allow redistributing the
   templates themselves as templates, and does not change the software licence.
7. The English license texts are authoritative for licensing. This file's Chinese summary
   and the README summaries are working translations for convenience; if a translation and
   the English legal text conflict, the English legal text governs licensing, while
   `docs/TOS.md` (Chinese) governs user conduct.

## Interface contracts and interoperability

Implementing the published interfaces (Pet Brief contract, CLI `--json` contract, MCP
resources/tools, source schema) is free for everyone, including commercial integrators, and
does not by itself make your implementation a derivative work of the documentation. The
permission in boundary rule 3 is an additional, non-exclusive permission: the licensor
grants it to all recipients of the repository at once, and it is not a separate licence for
the software. Commercial use of the Advisers software itself (for example using the CLI to
do paid client work) still requires a commercial licence.

## Language

The PolyForm and CC license texts are authoritative in English. The Chinese summary in this
file and in the READMEs is a working translation for convenience; if there is any ambiguity,
the English license text governs licensing, while `docs/TOS.md` (Chinese) governs user
conduct.

## Commercial use in client work

Using Advisers in paid client work is commercial use. It requires a commercial licence even
if you are an individual professional; "personal use" under the public licence requires
**"without any anticipated commercial application"**, which in Chinese means
**不预期产生商业应用**：只要你在使用前能够合理预期该使用会带来商业应用、对价或客户交付，
它就不属于许可证允许的个人用途。营利组织内部的试用、评估与测试同样属于商业使用，需要
商业授权。是否构成商业使用存在疑问时，请先取得运营者的书面确认。

## Compliance and cure period

The public licence allows **32 days** to cure a violation after written notice (LICENSE,
"Violations"). License-compliance notices and commercial-licensing requests:
<https://github.com/PerryLink/advisers/issues> with the title prefix `license-compliance`
or `commercial-license`. Nothing in the TOS shortens this cure period for license
violations.

## Trademarks

The "Advisers" and "PerryLink" names and logos are not licensed with the software or the
documentation. Forks and derivative distributions must not imply endorsement by, or
affiliation with, PerryLink.

## License history (not retroactive)

Releases published before 0.2.0 keep the licenses they were published under; the 0.2.0
change does not reach back into already-published tarballs.

| Published artifacts | License |
| --- | --- |
| advisers 0.0.1 through 0.1.0-preview.4 | MIT |
| advisers 0.2.0-preview.71 | Apache-2.0 |
| advisers 0.2.0 and later | PolyForm-Noncommercial-1.0.0 |
| advisers-core (all earlier releases) | MIT |
| advisers-office 0.1.0-preview.1/.2 and 0.2.0-preview.14 | MIT |
| advisers-policy-strict 0.2.0-preview.12 | MIT |
| dsh-advisers 0.0.1 through 0.1.0-preview.3 | MIT |
| 0.0.0-stage placeholder builds of the six published packages | no license declared (empty placeholders; do not use) |
| documentation/data/design (this repository, 0.2.0 and later) | CC-BY-NC-SA-4.0 |

See [NOTICE](NOTICE) for the same mapping. Already-granted rights are **irrevocable**:
recipients of MIT/Apache-2.0 versions may continue to use and redistribute those versions,
including for commercial purposes, under the licence in force when they received them. Git
snapshots published to the repository before 2026-11-17 remain available to their recipients
under the licence in force at publication. The 0.2.0 change does not reach back into
already-published tarballs or snapshots.

The history above does **not** cover the 0.0.0-stage placeholder packages, which were
published without a license field; they are empty build placeholders and must not be used
(do not publish new stage placeholders under a guessed licence).

## File integrity (sha256)

The root license files are the source of truth; package copies must be byte-identical.
CI verifies this with "node scripts/check-licenses.mjs".

| File | sha256 |
| --- | --- |
| LICENSE | ffcca38841adb694b6f380647e15f17c446a4d1656fed51a1e2041d064c94cc8 |
| NOTICE | 7db877b5058a186168acd2a62eb54ef5934fdf598ace7271c308d9fbd02090bf |
| LICENSE-DOCS | 8dc114eb5ddb78ad708ea4cd726216822df017e032b141262d5654b312cb0410 |

After changing LICENSE, NOTICE or LICENSE-DOCS, regenerate the package copies and update
this table; the gate compares the recorded hashes with the files on disk.

## Third-party components

Dependencies keep their own licenses and are not relicensed by this project; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). jszip is used under its MIT option (it
is offered as MIT OR GPL-3.0-or-later). buffers@0.1.1 publishes no license field; it is
whitelisted as an upstream gap (do not extract or redistribute it) and replacing it is a
P2 follow-up.

## Derived projects

Advisers applies a **limited derivative-project policy (policy A, decision of
2026-11-17)**: only projects that are *direct derivatives* of Advisers adopt the same
two-license model.

- **In scope — direct derivative projects.** A project is a direct derivative if it
  depends on a published Advisers package (`advisers`, `advisers-core`,
  `advisers-office`, `advisers-policy-strict`, `advisers-bridge-hermes`,
  `dsh-advisers`, `advisers-link-*`), if its own source consumes or tracks an Advisers
  interface contract beyond an independent implementation (Pet Brief contract, CLI
  `--json` contract, MCP resources/tools, source schema, copied schemas/test
  vectors/fixtures), or if it copies or adapts Advisers code, templates or
  documentation. Those projects license the Advisers-derived parts under PolyForm
  Noncommercial 1.0.0 (software) and CC BY-NC-SA 4.0 (documentation/data/design).
- **Out of scope — independent DSH plugin compositions.** Plugin projects that run on
  DeepSeek Harness but do not depend on an Advisers package and do not copy or track
  Advisers code/contracts keep their own licences (commonly Apache-2.0). This policy
  does not relicense them and does not ask them to adopt the Advisers licences.
- **Deriving is not the same as implementing an interface.** Independently implementing
  a published interface remains free under boundary rule 3 above; copying the interface
  documentation itself still triggers CC BY-NC-SA 4.0.
- **Not retroactive.** A derived project's releases published before its migration keep
  the licence in force at publication. Upstream files keep the upstream licence; a
  derived project may license its own original additions separately (PolyForm
  Noncommercial is not copyleft), but that does not change the restrictions on the
  upstream parts.

Current direct derivative projects are listed in
[docs/DERIVED-PROJECTS.md](docs/DERIVED-PROJECTS.md). The copy-ready guide, directory
checklist, migration steps and acceptance commands are in
[templates/DERIVED-PROJECT-LICENSING.md](templates/DERIVED-PROJECT-LICENSING.md).
Commercial-licensing requests for Advisers:
<https://github.com/PerryLink/advisers/issues> with the title prefix `commercial-license`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), section "Licensing of contributions". Contributions
are licensed to the project under the licenses above, and contributors additionally grant
the project a relicensing right (including commercial licences) so that commercial licensing
remains possible; sign off with "git commit -s" (DCO 1.1).

## 中文摘要

Advisers 采用**双许可模型**，且**不是开源项目**（非开源、源码可见）：软件采用 **PolyForm Noncommercial
License 1.0.0**（SPDX：PolyForm-Noncommercial-1.0.0，非 OSI 认证的开源许可；全文见
LICENSE，必需声明见 NOTICE）；文档、评测数据与设计材料采用 **CC BY-NC-SA 4.0**
（SPDX：CC-BY-NC-SA-4.0；全文与署名模板见 LICENSE-DOCS）。

- 软件范围：packages/**、scripts/**、.github/**、根 package.json 与 pnpm 配置，以及
  npm tarball 内的 README/NOTICE/THIRD-PARTY-NOTICES。
- 文档/数据/设计范围：根 README*.md、CHANGELOG/CONTRIBUTING/SECURITY/LICENSING、
  docs/**、eval/**（语料/gold/结果等非代码数据）、examples/**（非代码）、templates/**。
  其中 `eval/**`、`examples/**` 下的可执行代码属于软件范围（PolyForm），见下方"可执行代码
  边界"。
- 允许用途：任何非商业目的；个人为研究、实验、测试、学习、私人娱乐、业余爱好、宗教
  活动而使用，且**不预期产生商业应用**（"without any anticipated commercial application"）。
  中文释义：只要你在使用前能够合理预期该使用会带来商业应用、对价或客户交付，它就不属于
  许可证允许的个人用途；**营利组织内部的试用、评估与测试同样属于商业使用**。慈善、教育、
  公共研究、公共安全卫生、环保、政府机构的使用属于允许用途。商业使用需另行取得书面商业
  授权（在 https://github.com/PerryLink/advisers/issues 提出，标题前缀 `commercial-license`）。
- 可执行代码边界：`eval/**` 与 `examples/**` 中的可执行/源代码文件（如 `eval/run-*.mjs`、
  `examples/demo.ts`）属于**软件**，按 PolyForm 授权；纯文档、语料、gold 数据、JSON
  数据与 schema、设计材料按 CC 授权。文件归类有疑问时**以代码为准**（PolyForm）。
- 接口契约：为互操作而实现或复制 JSON Schema/测试向量/CLI/MCP 契约，不附加署名、相同方式
  共享或非商业限制；重新分发文档本身仍须遵守 CC BY-NC-SA 4.0。软件本身及商业使用规则不变。
- 语言效力：许可证英文原文优先；本中文摘要为工作翻译，仅供参考。用户行为规范以
  docs/TOS.md（中文）为准。
- 分发义务：随分发提供许可条款或 URL，并保留 NOTICE 中的 Required Notice 行；
  不得再许可或转让；修改后分发须遵守 PolyForm 的 Notices 条款；违约后有 32 日书面通知
  补救期（PolyForm "Violations"）。
- 文档署名："Advisers documentation (c) 2026 PerryLink contributors, CC BY-NC-SA 4.0,
  https://github.com/PerryLink/advisers (accessed YYYY-MM-DD); changes: 说明"；不得移除
  署名与许可链接；修改后须以 CC BY-NC-SA 4.0（或兼容许可）分发；不得商业使用；不得向
  评测语料加入真实个人信息。用户用模板生成的交付物（DOCX/XLSX/PPTX 等）不因 CC 的
  NC/SA 条件而受限，可含商业用途（见 Boundary rule 6）。
- 不追溯：0.2.0 之前发布的版本保留原许可（MIT；advisers@0.2.0-preview.71 为
  Apache-2.0），详见 NOTICE。已经授予的权利不可撤销：MIT/Apache-2.0 版本的用户可继续按
  原许可使用（含商业使用）与再分发。
- 衍生项目（方案 A，2026-11-17 决定）：仅**直接衍生项目**（依赖 Advisers 发布包 / 在自身
  源码中消费 Pet Brief、CLI `--json`、MCP、source schema 等契约 / 复制或改编 Advisers
  代码与文档）迁移为同样的双许可；**独立 DSH 插件组合保持各自原许可**（常见
  Apache-2.0），本政策不改变其许可。清单见 docs/DERIVED-PROJECTS.md，迁移清单、目录要求
  与验收命令见 templates/DERIVED-PROJECT-LICENSING.md。迁移不追溯；上游文件保持上游
  许可，衍生项目自己新增的部分可另行许可。
- 贡献：见 CONTRIBUTING.md 的 "Licensing of contributions"（DCO 1.1 + 再许可授权）。
