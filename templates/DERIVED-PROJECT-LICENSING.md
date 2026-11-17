# Derived Project Licensing Guide (Advisers two-license policy)

This template is for projects that directly derive from Advisers: projects that depend
on an Advisers package, track an Advisers interface contract in their own source, or
copy/adapt Advisers code, templates or documentation. It is a checklist and copy-ready
text, **not legal advice**; have a qualified legal professional (or your own counsel)
review it before publishing. Advisers itself is source-available, **not open source**.

## 0. Scope: policy A (decision of 2026-11-17)

Advisers applies a **limited migration policy**: only projects that are *direct
derivatives* of Advisers move to the Advisers two-license model. Everything else keeps
the licence it already has.

### 0.1 In scope: direct derivative projects

A project is a direct derivative if **any** of the following is true:

1. **Package dependency** — it declares a dependency on a published Advisers package:
   `advisers`, `advisers-core`, `advisers-office`, `advisers-policy-strict`,
   `advisers-bridge-hermes`, `dsh-advisers`, `advisers-link-email` or
   `advisers-link-feishu` (in a package manifest, lockfile, bundle or vendored copy).
2. **Contract consumption** — its own source consumes or tracks an Advisers interface
   contract in a way that goes beyond an independent implementation: the Pet Brief
   contract, the CLI `--json` contract, the MCP resources/tools contract, the source
   schema, or copied schemas/test vectors/fixtures of those contracts.
3. **Code or document copying** — it copies or adapts Advisers source code, scripts,
   templates, documentation, evaluation data or design material into the project.

When a project mixes Advisers-derived parts with unrelated parts, the Advisers-derived
parts follow this guide; the unrelated parts keep their own licences and copyright
holders.

### 0.2 Out of scope: independent DSH plugin compositions

Independent DeepSeek Harness (DSH) plugin projects — plugins that run on DSH but do not
depend on an Advisers package, do not track an Advisers contract in their source, and do
not copy Advisers code or docs — are **not** covered by this policy. They keep their
own licences (commonly Apache-2.0, MIT or another licence chosen by their authors).
Policy A does **not** relicense them and does not ask them to adopt the Advisers
licences. A project can be in the DSH plugin ecosystem and still be independent.

Also out of scope:

- third-party policy packs, DLC and Link providers, which stay under their publisher's
  licence;
- a project that only independently implements a published Advisers interface (see
  LICENSING.md boundary rule 3). Implementing the interface is not by itself a
  derivative work; copying the interface documentation itself still triggers the CC
  BY-NC-SA 4.0 terms.

If you are unsure which side a project is on, record the facts and the decision in the
project's own issue/commit before publishing, and ask at
<https://github.com/PerryLink/advisers/issues>.

### 0.3 What migration does and does not mean

- Upstream files keep their upstream licences. You may licence **your own original
  additions** separately, but that does not change the restrictions that apply to the
  upstream parts. PolyForm Noncommercial is **not** copyleft: it does not force your
  whole project under the same licence.
- Migration is **not retroactive**. Releases published before your migration remain under
  the licence in force when they were published; already-granted rights stay
  irrevocable.
- Migration is a licensing change, not a lawyer-approval claim. Do not describe the
  project as "open source", "OSI", "approved", "cleared" or "compliant" unless that is
  separately true.

## 1. Policy to inherit

Advisers uses a two-license model:

| Scope | License | SPDX |
| --- | --- | --- |
| Software (source, scripts, workflows, package manifests, files shipped in tarballs) | PolyForm Noncommercial License 1.0.0 | PolyForm-Noncommercial-1.0.0 |
| Documentation, evaluation data, design materials (and project art, if any) | CC BY-NC-SA 4.0 | CC-BY-NC-SA-4.0 |

A direct derivative should keep the same split. The noncommercial restriction and the
attribution/share-alike terms of the two licenses are independent and both must be kept:
the software is NC-only, and adaptations of the documentation must be shared under
CC BY-NC-SA 4.0 (or a compatible licence).

## 2. Software files

1. Copy the official PolyForm Noncommercial License 1.0.0 text **verbatim** into
   `LICENSE`: <https://polyformproject.org/licenses/noncommercial/1.0.0> (plain text:
   <https://polyformproject.org/licenses/noncommercial/1.0.0.txt>). If the project is a
   fork of an Advisers release, the upstream `LICENSE` is already the official text.
2. Set `"license": "PolyForm-Noncommercial-1.0.0"` in every package manifest
   (including workspace packages). Use `CC-BY-NC-SA-4.0` only for documentation-only
   packages that are published separately.
3. Create `NOTICE` with the copyright line, the project URL, the PolyForm Required
   Notice line, both licence names, the non-open-source statement, the upstream
   provenance and the non-retroactive history.
4. Ship `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md` in every tarball /
   installer / distribution (files allowlist and installer resources) and list them in
   package metadata where applicable.
5. If you modify upstream code, the PolyForm "Notices" clause requires that whoever
   receives the software also receives the licence terms or URL and the Required Notice
   line. PolyForm does not add an "attribution must not be removed" condition, so state
   the copyright line as a factual notice; keep it as a courtesy, do not present it as an
   extra licence condition. Include a short changelog note that the work is modified.
6. Keep package copies of `LICENSE` and `NOTICE` byte-identical to the root copies.

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

Documentation, evaluation data and design materials: CC BY-NC-SA 4.0
https://creativecommons.org/licenses/by-nc-sa/4.0/ (see LICENSE-DOCS).

Upstream provenance: this project is derived from Advisers
(https://github.com/PerryLink/advisers). Upstream releases published before the licence
change keep their original licenses (MIT; Apache-2.0 for advisers@0.2.0-preview.71);
this project does not relicense them. See the upstream NOTICE.

This is source-available software, not open source: it is not an OSI-approved open
source project. Commercial use requires a separate commercial license:
<commercial contact / issue tracker URL>.
```

## 3. Documentation, data and design files

1. Put the CC BY-NC-SA 4.0 legal code in `LICENSE-DOCS` and state its scope in the file
   header. Canonical text:
   <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.en>.
2. Keep the attribution: author/copyright line, licence name, canonical URL, the project
   URI, a modification note, and the access date.
3. Share adaptations under CC BY-NC-SA 4.0 (or a compatible licence) and add no extra
   restrictions. The licence covers copyright and, where applicable, database rights.
4. Never put real personal information into evaluation corpora or example data.
5. **Output exception**: deliverables you produce *with* the templates (DOCX/XLSX/PPTX
   and similar output documents) remain yours to use and distribute, including
   commercially; the NC/SA conditions of CC BY-NC-SA 4.0 do not apply to your output
   documents. This exception does not allow redistributing the templates themselves as
   templates, and does not change the software licence.
6. Projects that ship original art/setting material may keep the Advisers-style split of
   `LICENSE-ART` (CC BY-NC-SA 4.0 for art and setting text) in addition to
   `LICENSE-DOCS`; if the project has no separate art, say so in the NOTICE.

Attribution template:

```text
<Project> documentation (c) <year> <copyright holder>, CC BY-NC-SA 4.0,
<project URL> (accessed YYYY-MM-DD); changes: <none / describe>.
```

## 4. Required directory and metadata checklist

Every direct derivative project must carry all of the following. Use this table as the
review checklist.

| # | Item | Path / field | Must contain |
| --- | --- | --- | --- |
| 1 | Software licence text | `LICENSE` | Full official PolyForm Noncommercial 1.0.0 text (title, URL, Notices and Noncommercial Organizations sections); no Apache-2.0/MIT text left in it |
| 2 | Documentation licence text | `LICENSE-DOCS` | CC BY-NC-SA 4.0 legal code (title + canonical URL) |
| 3 | Notice | `NOTICE` | Copyright, project URL, `Required Notice:` line, both licence names, "not open source" statement, upstream provenance, non-retroactive history, commercial-licence entry |
| 4 | Third-party notices | `THIRD-PARTY-NOTICES.md` | Generated from the production dependency closure; no GPL/AGPL-only dependency; ships in every tarball |
| 5 | Manifest licence fields | `package.json` `"license"` (every package) | `PolyForm-Noncommercial-1.0.0`; `CC-BY-NC-SA-4.0` only for separate documentation packages |
| 6 | README declaration | `README.md` / `README-zh.md` | Two-licence split, source-available/not open source, historical licence mapping, links to LICENSE, NOTICE, LICENSING/NOTICE, commercial entry |
| 7 | Commercial licensing entry | `LICENSE-COMMERCIAL.md` (or `COMMERCIAL-LICENSING.md`) | Who needs a commercial licence, how to request it, what it does not include (third-party components, trademarks) |
| 8 | Changelog note | `CHANGELOG.md` | Entry for the licence change: effective date/version, not retroactive, commercial-licence channel |
| 9 | Package copies | `packages/*/LICENSE`, `packages/*/NOTICE` | Byte-identical to the root copies; listed in `files` allowlist |
| 10 | Art licence (if art ships) | `LICENSE-ART` | CC BY-NC-SA 4.0 for art/setting material; scope and attribution template |

## 5. Migration steps

1. **Classify the project** against §0.1/§0.2 and record the decision (issue + commit
   message + date) in the project's own history.
2. **Pick an effective version/date.** The migration applies to releases published at or
   after that version; do not relicense already-published releases.
3. **Copy the texts verbatim** into `LICENSE` and `LICENSE-DOCS`; verify their
   sha256 against the upstream table in
   <https://github.com/PerryLink/advisers/blob/main/LICENSING.md>.
4. **Update every manifest** (`license` field, `files` allowlist) and add package-level
   copies of `LICENSE`/`NOTICE` if the project publishes packages.
5. **Write `NOTICE`** from the skeleton above; state the upstream provenance and the
   non-retroactive mapping explicitly.
6. **Update the READMEs** (license matrix, source-available statement, commercial
   channel) and add/refresh `LICENSE-COMMERCIAL.md`.
7. **Add the CHANGELOG entry** for the licence change and the not-retroactive note.
8. **Generate `THIRD-PARTY-NOTICES.md`** from the production dependency closure and
   check for copyleft; audit any dependency without a licence field.
9. **Verify distributions**: every npm tarball, installer and portable bundle ships the
   licence files (and, where the project has art, `LICENSE-ART` and the credits file).
10. **Run the checks in §6 in CI** before publishing, and keep them running for later
    releases.

## 6. Acceptance commands

Portable checks (POSIX shell; adapt paths on Windows). Run them in the project root.

```sh
# 1. Software licence: official PolyForm NC 1.0.0 text.
grep -F 'PolyForm Noncommercial License 1.0.0' LICENSE
grep -F 'https://polyformproject.org/licenses/noncommercial/1.0.0' LICENSE
grep -F 'Required Notice:' NOTICE

# 2. Byte-identical to the upstream Advisers LICENSE (hash from Advisers LICENSING.md).
printf '%s  %s
' 'ffcca38841adb694b6f380647e15f17c446a4d1656fed51a1e2041d064c94cc8' LICENSE | sha256sum -c -

# 3. Documentation licence text.
grep -F 'Attribution-NonCommercial-ShareAlike 4.0 International' LICENSE-DOCS
grep -F 'https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.en' LICENSE-DOCS

# 4. Manifest licence field (run from each published package directory too).
node -e "const p=require('./package.json'); if(p.license!=='PolyForm-Noncommercial-1.0.0'){console.error('bad license: '+p.license);process.exit(1)}; console.log('OK', p.license)"

# 5. README declaration.
grep -Ei 'not open source|非开源' README.md
grep -F 'PolyForm' README.md
grep -F 'CC BY-NC-SA 4.0' README.md

# 6. NO current file claims Apache-2.0/MIT as the project licence (historical NOTICE
#    mapping lines are expected and must stay).
! grep -REn 'this and future versions are Apache-2\.0|Licensed under the Apache License|Apache License, Version 2\.0\.' \
  --include='*.md' --include='*.json' --exclude-dir=node_modules --exclude-dir=.git .

# 7. Tarball ships the required files (npm 10+; adjust for older npm output shapes).
npm pack --dry-run --json > /tmp/pack.json
node -e "const raw=require('/tmp/pack.json');const files=(Array.isArray(raw)?raw:[raw]).flatMap(x=>x.files.map(f=>f.path));for(const r of ['LICENSE','NOTICE','THIRD-PARTY-NOTICES.md']){if(!files.includes(r)){console.error('missing '+r);process.exit(1)}};console.log('OK tarball files')"
```

If the project copies Advisers' Check scripts, adapt the package list first, then run
`node scripts/check-licenses.mjs` and the license assertions in
`node scripts/check-docs.mjs`; they are the same gates Advisers runs in CI.

## 7. What you must not do

- Do not describe the project as open source or imply an OSI-approved licence.
- **Software:** do not sublicense or transfer the PolyForm licence ("No Other Rights");
  use is limited to the permitted purposes. **Documentation:** adaptations must be
  shared under CC BY-NC-SA 4.0 (or a compatible licence) with attribution, and no extra
  restrictions may be added. Do not relicense the upstream parts under different terms;
  fork under the same licence or obtain a commercial licence.
- Do not strip `NOTICE`, the Required Notice line, `LICENSE` or `LICENSE-DOCS` from
  distributions.
- Do not assume an upstream version's licence changed retroactively. The 0.0.0-stage
  placeholder packages published without a licence field remain unusable; do not treat
  them as a licence grant.
- Do not use the "Advisers" or "PerryLink" names, logos or other marks as your own. The
  licences do not grant trademark or endorsement rights; forks must be clearly marked as
  unaffiliated or renamed.
- Do not claim the migration was lawyer-approved unless a qualified legal professional
  reviewed it; if you rely on self-review, say so in your release notes.

## 8. Commercial use

PolyForm NC permits noncommercial purposes only (personal/hobby/research/education/
charity/public research/public safety/health/environmental/government use, as defined in
the licence). Use by or for a for-profit organization is not permitted by the public
licence. If the project needs commercial distribution you must either (a) obtain a
commercial licence from the upstream licensor for the upstream parts, or (b) negotiate
terms with the upstream copyright holder. Your own original parts can be offered by you
under a commercial licence, but the upstream parts keep their upstream terms. Commercial
requests for Advisers: <https://github.com/PerryLink/advisers/issues> with the title
prefix `commercial-license`.

## 9. Pre-release checklist

- [ ] The project was classified as a direct derivative and the decision was recorded.
- [ ] `LICENSE` is the full official PolyForm NC 1.0.0 text (title + URL + Notices
      section present; no Apache/MIT text left in it).
- [ ] `LICENSE` sha256 matches the upstream Advisers `LICENSE` hash recorded in
      Advisers LICENSING.md.
- [ ] `NOTICE` exists, contains `Required Notice:`, both licence names, the
      non-open-source statement, provenance and the not-retroactive note; it ships in
      every tarball.
- [ ] Every `package.json` has `"license": "PolyForm-Noncommercial-1.0.0"`
      (documentation-only packages may use `CC-BY-NC-SA-4.0`).
- [ ] `LICENSE-DOCS` exists and contains the CC BY-NC-SA 4.0 title and canonical URL.
- [ ] README license section states the two-licence split, says not open source, lists
      the historical licence mapping and links LICENSING/NOTICE.
- [ ] Commercial-licensing entry exists and tells users how to request a licence.
- [ ] CHANGELOG has the licence-change entry with the effective version and the
      not-retroactive note.
- [ ] Package `LICENSE`/`NOTICE` files are byte-identical to the root copies.
- [ ] `THIRD-PARTY-NOTICES.md` is generated from the production dependency closure and
      ships in every tarball; no GPL/AGPL-only dependency slipped in.
- [ ] `npm pack --dry-run --json` lists `LICENSE`, `NOTICE` and
      `THIRD-PARTY-NOTICES.md`.
- [ ] Upstream NOTICE and provenance are preserved; modifications are noted.
- [ ] The texts were reviewed by a qualified legal professional or your own counsel; if
      you rely on self-review, the release notes say so.
- [ ] A project that is only an independent DSH plugin composition was **not** migrated
      by mistake (it keeps its own licence).

## 10. Reuse the gates

Advisers ships two gates you can copy and adapt: `scripts/check-licenses.mjs` (SPDX
fields, byte-identical licence files, dependency copyleft audit and generated
third-party notices) and the licence assertions in `scripts/check-docs.mjs` (docs and
README claims). Both are written for Advisers' own package list, so adapt the lists and
hashes before using them. Run them in CI before publishing.

## 中文要点（方案 A）

- **适用范围**：只有 **直接衍生项目**（依赖 Advisers 发布包 / 在自身源码中消费 Pet
  Brief、CLI `--json`、MCP、source schema 等契约 / 复制或改编 Advisers 代码与文档）
  才迁移为 Advisers 的双许可模型；**独立 DSH 插件组合保持各自原许可**（常见
  Apache-2.0），本政策不要求也不触发其迁移。
- **许可拆分**：软件用 **PolyForm Noncommercial License 1.0.0 全文**（LICENSE），
  NOTICE 必须包含 `Required Notice: Copyright <年> <署名方> (<仓库 URL>)` 纯文本行，
  随每个 tarball/安装包分发；文档/数据/设计（及原创建材）用 **CC BY-NC-SA 4.0**
  （LICENSE-DOCS），保留署名、许可链接与修改说明，改编须同许可分享、不得附加额外限制。
- **清单**：LICENSE / LICENSE-DOCS / NOTICE / THIRD-PARTY-NOTICES.md /
  package.json license / README 声明 / 商业授权入口 / CHANGELOG 非追溯说明 八项齐备；
  有独立美术时另加 LICENSE-ART。
- **不追溯**：迁移只对生效版本之后的发布生效；此前的发布保留原许可，已授予权利不可撤销；
  **上游代码文件保持上游许可**，你自己新增的代码可另行选择许可（PolyForm NC 不是
  copyleft），但这不改变上游部分的使用限制。
- **不得**：宣称 OSI 开源；再许可或转让 PolyForm 许可；剥离 NOTICE/Required Notice/
  LICENSE/LICENSE-DOCS；凭"上游版本许可变了"追溯已发布版本；使用 Advisers/PerryLink
  名称与标识暗示背书；把迁移说成已经过律师批准。
- **商业使用**：PolyForm NC 只允许非商业目的；商业化须另行取得上游商业授权（标题前缀
  `commercial-license`），或与你自己的原创部分另行签约——上游部分不因此改变。
- **验收**：先跑第 6 节可移植检查；复制 Advisers 门禁时先改包清单与 hash，再跑
  `node scripts/check-licenses.mjs` 与 check-docs 的许可断言。正式对外前由合格法律
  专业人士或你方律师复核；若自行复核，须在发布说明中如实说明。
