# Derived projects

Advisers is **source-available, not open source**: software is licensed under the
[PolyForm Noncommercial License 1.0.0](../LICENSE) and documentation, evaluation data and
design material under [CC BY-NC-SA 4.0](../LICENSE-DOCS). This page explains which
projects must adopt the same two-license model, lists the current direct derivative
projects and gives the checklist for adding a new one.

The policy is **policy A (decision of 2026-11-17)**: only projects that *directly derive*
from Advisers migrate to the Advisers licences. Independent DeepSeek Harness (DSH) plugin
compositions keep the licences their authors chose (commonly Apache-2.0); this policy
does not relicense them. The binding policy text is in
[LICENSING.md](../LICENSING.md#derived-projects); the copy-ready guide, directory
checklist, migration steps and acceptance commands are in
[templates/DERIVED-PROJECT-LICENSING.md](../templates/DERIVED-PROJECT-LICENSING.md).

## What counts as a direct derivative

A project is a **direct derivative** if any of the following is true:

1. **Package dependency** — it declares a dependency on a published Advisers package
   (`advisers`, `advisers-core`, `advisers-office`, `advisers-policy-strict`,
   `advisers-bridge-hermes`, `dsh-advisers`, `advisers-link-email`,
   `advisers-link-feishu`), including a vendored or bundled copy.
2. **Contract consumption** — its own source consumes or tracks an Advisers interface
   contract beyond an independent implementation: the Pet Brief contract, the CLI
   `--json` contract, the MCP resources/tools contract or the source schema, including
   copied schemas, test vectors and fixtures.
3. **Code or document copying** — it copies or adapts Advisers source code, scripts,
   templates, documentation, evaluation data or design material.

If a project mixes Advisers-derived parts with unrelated parts, only the
Advisers-derived parts must use the Advisers licences; the unrelated parts keep their own
licences and copyright holders.

**Not covered:** independent DSH plugin projects that merely run on the same host and do
not depend on, track or copy Advisers; third-party policy packs, DLC and Link providers
(their publisher's licence applies); and projects that only **independently implement** a
published Advisers interface — implementing an interface is not by itself a derivative
work (see [LICENSING.md](../LICENSING.md) boundary rule 3). Copying the interface
documentation itself still follows CC BY-NC-SA 4.0.

## Current direct derivative projects

| Project | Maintainer | Relationship | Licensing status | Public distribution |
| --- | --- | --- | --- | --- |
| **Desktop Games (Famling)** | PerryLink | Direct derivative and the reference Pet Brief consumer: its pet integration consumes and tests the Advisers Pet Brief contract and ships the corresponding consumer fixtures/tests. Separate codebase. | Migrated on 2026-11-17 to the Advisers two-license model: software PolyForm Noncommercial 1.0.0 (`LICENSE`; sha256 `ffcca38841adb694b6f380647e15f17c446a4d1656fed51a1e2041d064c94cc8`, byte-identical to the Advisers `LICENSE`), art/setting material CC BY-NC-SA 4.0 (`LICENSE-ART`), with `NOTICE` and a commercial-licensing entry (`LICENSE-COMMERCIAL.md`). The project's own release notes govern its release status; this page only records licensing alignment. | Not publicly distributed at the time of writing. When it is distributed, every package must ship `LICENSE`, `NOTICE`, `LICENSE-ART` and `LICENSE-COMMERCIAL.md`. |

No other direct derivative project is currently known. This list is updated by pull
request when a project is added (see the checklist below).

### How the list was verified

The checks below are run by the project's maintainers (the project's repository is not
public at the time of writing). The public evidence is the licence hash, which is the
same value Advisers publishes in [LICENSING.md](../LICENSING.md#file-integrity-sha256):

```sh
# 1. The derived project's LICENSE is byte-identical to the Advisers LICENSE.
sha256sum LICENSE
# expected: ffcca38841adb694b6f380647e15f17c446a4d1656fed51a1e2041d064c94cc8

# 2. Required Notice and the two licences are declared.
grep -F 'Required Notice:' NOTICE
grep -F 'PolyForm Noncommercial License 1.0.0' LICENSE
grep -F 'CC BY-NC-SA 4.0' LICENSE-ART

# 3. Manifest and distribution declarations are present.
node -e "const p=require('./package.json'); if(p.license!=='PolyForm-Noncommercial-1.0.0'){process.exit(1)}"
test -f LICENSE && test -f NOTICE && test -f LICENSE-ART && test -f LICENSE-COMMERCIAL.md
```

Last verified: 2026-11-17.

## Adding a new direct derivative project

1. **Triage.** Compare the project against the criteria above. Record the decision and
   the date in the project's issue or commit history, with a link to this page.
2. **Pick an effective version/date.** The migration applies to releases published at or
   after that version. Already-published releases keep the licence they had; already
   granted rights are irrevocable.
3. **Copy the license texts verbatim.** `LICENSE` must be the full official PolyForm
   Noncommercial License 1.0.0 text, and `LICENSE-DOCS` the CC BY-NC-SA 4.0 legal code.
   Verify the `LICENSE` sha256 against the value in Advisers LICENSING.md.
4. **Add the declarations.** `NOTICE` with the `Required Notice:` line, upstream
   provenance and non-retroactive history; `"license": "PolyForm-Noncommercial-1.0.0"`
   in every package manifest; a README license section saying the project is
   source-available, not open source; a commercial-licensing entry
   (`LICENSE-COMMERCIAL.md` or equivalent); a `CHANGELOG.md` entry for the licence
   change; and `THIRD-PARTY-NOTICES.md` generated from the production dependency
   closure.
5. **Keep art separate.** If the project ships original art/setting material, license it
   under CC BY-NC-SA 4.0 in `LICENSE-ART` (with credits and attribution guidance) rather
   than folding it into the code licence.
6. **Verify distributions.** Every tarball, installer and portable bundle must ship the
   licence files (`LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md` and, where applicable,
   `LICENSE-ART` and `LICENSE-COMMERCIAL.md`).
7. **Run the checks** from
   [templates/DERIVED-PROJECT-LICENSING.md](../templates/DERIVED-PROJECT-LICENSING.md#6-acceptance-commands)
   in CI, then add a row to the table above by pull request.

If you are not sure whether a project is a direct derivative, open an issue at
<https://github.com/PerryLink/advisers/issues> before publishing and describe the
dependency, the contracts consumed and any copied material.

## What this policy does not do

- It does **not** relicense independent DSH plugin compositions or unrelated projects;
  they keep their own licences.
- It is **not retroactive**: earlier releases of a derived project stay under the licence
  they were published with.
- It grants **no trademark or endorsement rights** in the "Advisers" or "PerryLink"
  names and logos; derived projects must be clearly marked as unaffiliated.
- It is **not a lawyer-approval claim** for the derived project. Each project is
  responsible for its own release review; if a project relies on self-review, its release
  notes must say so.

## Contact

- Licence-compliance notices and commercial-licensing requests for Advisers:
  <https://github.com/PerryLink/advisers/issues> with the title prefix
  `license-compliance` or `commercial-license`.
- Licence terms: [LICENSING.md](../LICENSING.md) · [LICENSE](../LICENSE) ·
  [LICENSE-DOCS](../LICENSE-DOCS) · [NOTICE](../NOTICE).

## 中文摘要

- **方案 A（2026-11-17 决定）**：仅**直接衍生项目**迁移为 Advisers 双许可（软件
  PolyForm NC 1.0.0 + 文档/数据/设计 CC BY-NC-SA 4.0）。直接衍生的判据：依赖
  Advisers 发布包、在自身源码中消费/跟踪 Pet Brief、CLI `--json`、MCP、source schema
  等契约，或复制/改编 Advisers 代码与文档。**独立 DSH 插件组合保持各自原许可**
  （常见 Apache-2.0），本政策不改变其许可。
- **当前清单**：Desktop Games（Famling）已于 2026-11-17 迁移；其 `LICENSE` 与
  Advisers `LICENSE` 字节一致（sha256 `ffcca388…`），并具备 NOTICE、
  LICENSE-ART（CC BY-NC-SA 4.0）与 LICENSE-COMMERCIAL.md；当前未公开分发，公开分发时
  须随包携带上述许可文件。
- **新项目接入**：先判定是否直接衍生并记录决定 → 选定生效版本/日期（不追溯）→ 逐字复制
  LICENSE/LICENSE-DOCS → 补 NOTICE、package.json license、README 声明、商业授权入口、
  CHANGELOG 非追溯说明、THIRD-PARTY-NOTICES → 跑
  templates/DERIVED-PROJECT-LICENSING.md 第 6 节验收命令 → 在本页表格加一行（PR）。
- **边界**：本政策不改变独立 DSH 插件的许可；不授予商标/背书权；不构成对衍生项目已完成
  律师审查的声明。
