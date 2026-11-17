# Derived Project Licensing Guide (Advisers two-license policy)

This template is for projects that fork, extend or ship derivations of Advisers.
It is a checklist and copy-ready text, **not legal advice**; have counsel review before
publishing. Advisers itself is source-available, **not open source**.

## Policy to inherit

Advisers uses a two-license model:

| Scope | License | SPDX |
| --- | --- | --- |
| Software (source, scripts, workflows, package manifests, files shipped in tarballs) | PolyForm Noncommercial License 1.0.0 | PolyForm-Noncommercial-1.0.0 |
| Documentation, evaluation data, design materials | CC BY-NC-SA 4.0 | CC-BY-NC-SA-4.0 |

A derived project should keep the same split unless it has its own legal reason and
permission to change it. The noncommercial restriction and the attribution/share-alike
terms of the two licenses are independent and both must be kept.

## 1. Software files

1. Copy the official PolyForm Noncommercial License 1.0.0 text verbatim into LICENSE:
   <https://polyformproject.org/licenses/noncommercial/1.0.0> (plain text:
   <https://polyformproject.org/licenses/noncommercial/1.0.0.txt>).
2. Set "license": "PolyForm-Noncommercial-1.0.0" in every package manifest.
3. Create NOTICE with the copyright line and the PolyForm Required Notice line.
4. Ship LICENSE, NOTICE and THIRD-PARTY-NOTICES.md in every npm tarball (files
   allowlist) and list them in package metadata where applicable.
5. If you modify Advisers code, the PolyForm "Notices" clause requires that whoever
   receives the software also receives the license terms or URL, the Required Notice
   line, and must not have the attribution removed. Include a short changelog note that
   the work is modified.

Required Notice template (plain text, keep the exact prefix):

```text
Required Notice: Copyright <year> <copyright holder> (<project URL>)
```

Example NOTICE skeleton:

```text
<Project name>
Copyright <year> <copyright holder>
<project URL>

Required Notice: Copyright <year> <copyright holder> (<project URL>)

Software: PolyForm Noncommercial License 1.0.0
(SPDX: PolyForm-Noncommercial-1.0.0). Terms: LICENSE in this distribution, or
https://polyformproject.org/licenses/noncommercial/1.0.0

Documentation and data: CC BY-NC-SA 4.0
https://creativecommons.org/licenses/by-nc-sa/4.0/ (see LICENSE-DOCS).

Upstream provenance: this project is derived from Advisers
(https://github.com/PerryLink/advisers). Upstream releases published before 0.2.0 keep
their original licenses (MIT; Apache-2.0 for advisers@0.2.0-preview.71); this project
does not relicense them. See the upstream NOTICE.

This is source-available software, not open source: it is not an OSI-approved open
source project. Commercial use requires a separate commercial license:
<commercial contact / issue tracker URL>.
```

## 2. Documentation, data and design files

1. Put the CC BY-NC-SA 4.0 legal code in LICENSE-DOCS and state its scope in the file
   header. Canonical text:
   <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.en>.
2. Set "license" for documentation-only packages to CC-BY-NC-SA-4.0 when they are
   published separately.
3. Keep the attribution: author/copyright line, license name, canonical URL, the
   project URI, a modification note, and the access date.
4. Share adaptations under CC BY-NC-SA 4.0 (or a compatible license) and add no extra
   restrictions. The license covers copyright and, where applicable, database rights.
5. Never put real personal information into evaluation corpora or example data.

Attribution template:

```text
<Project> documentation (c) <year> <copyright holder>, CC BY-NC-SA 4.0,
<project URL> (accessed YYYY-MM-DD); changes: <none / describe>.
```

## 3. What you must not do

- Do not describe the project as open source or imply an OSI-approved license.
- Do not sublicense or transfer the PolyForm license ("No Other Rights").
- Do not relicense Advisers code or docs under different terms; fork under the same
  license or obtain a commercial license.
- Do not strip NOTICE, Required Notice, LICENSE or LICENSE-DOCS from distributions.
- Do not assume an upstream version's license changed retroactively.

## 4. Commercial use

PolyForm NC permits noncommercial purposes only (personal/hobby/research/education/
charity/public research/public safety/health/environmental/government use). Use by or
for a for-profit organization is not permitted by the public license. If your project
needs commercial distribution you must either (a) obtain a commercial license from the
upstream licensor for upstream parts, or (b) negotiate terms with the upstream
copyright holder. Your own original parts can be offered by you under a commercial
license, but the upstream parts keep their upstream terms.

## 5. Pre-release checklist

- [ ] LICENSE is the full official PolyForm NC 1.0.0 text (title + URL + Notices section
      present; no Apache/MIT text left in it).
- [ ] NOTICE exists, contains "Required Notice:" and the non-open-source statement, and
      ships in every tarball.
- [ ] Every package.json has "license": "PolyForm-Noncommercial-1.0.0".
- [ ] LICENSE-DOCS exists and contains the CC BY-NC-SA 4.0 title and canonical URL.
- [ ] README license section states the two-license split, says not open source, lists
      the historical license mapping and links LICENSING.md / NOTICE.
- [ ] Package LICENSE/NOTICE files are byte-identical to the root copies.
- [ ] THIRD-PARTY-NOTICES.md is generated from the production dependency closure and
      ships in every tarball; no GPL/AGPL-only dependency slipped in.
- [ ] "npm pack --dry-run --json" lists LICENSE, NOTICE and THIRD-PARTY-NOTICES.md.
- [ ] Upstream NOTICE and provenance are preserved; modifications are noted.
- [ ] Texts reviewed by counsel before any public release.

## 6. Reuse the gates

Advisers ships two gates that can be copied and adapted: "scripts/check-licenses.mjs"
(SPDX fields, byte-identical license files, dependency copyleft audit and generated
third-party notices) and the license assertions in "scripts/check-docs.mjs" (docs and
README claims). Run both in CI before publishing.

## 中文要点

- 软件沿用 **PolyForm Noncommercial License 1.0.0 全文**（LICENSE），NOTICE 必须包含
  `Required Notice: Copyright <年> <署名方> (<仓库 URL>)` 纯文本行，随每个 tarball 分发。
- 文档/数据/设计沿用 **CC BY-NC-SA 4.0**（LICENSE-DOCS），保留署名、许可链接与修改说明；
  改编须以相同或兼容许可分享，不得附加额外限制。
- 保留上游 NOTICE、来源说明与"历史版本不追溯"声明；修改上游代码后按 PolyForm
  Notices 条款随分发给出条款/URL 并注明修改。
- 不得宣称 OSI 开源；不得再许可或转让；商业化需自行作为许可人提供商业授权，或就上游
  部分遵守上游条款。
- 发布前按第 5 节清单逐项检查；正式对外前请法务复核。
