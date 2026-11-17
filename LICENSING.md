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
- root package.json, pnpm-lock.yaml, pnpm-workspace.yaml.

Permitted purposes (exact definitions are in the license):

- any noncommercial purpose;
- personal use for research, experiment, testing, study, private entertainment, hobby
  projects, amateur pursuits, or religious observance, without anticipated commercial
  application;
- use by charitable organizations, educational institutions, public research
  organizations, public safety or health organizations, environmental protection
  organizations, or government institutions.

Any other use — including use by or for a for-profit organization — is **not** a
permitted purpose and requires a separate commercial license. To request one, open an
issue at <https://github.com/PerryLink/advisers/issues>. You must not sublicense or transfer the license, and if you
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
- **docs/**;
- **eval/** — corpora, gold data, reviews and results (the license also covers sui
  generis database rights; never add real personal information);
- **examples/**;
- **templates/**.

Attribution requirement (CC BY-NC-SA 4.0 section 3(a)(1)) — use a form like:

> Advisers documentation (c) 2026 PerryLink contributors, CC BY-NC-SA 4.0,
> https://github.com/PerryLink/advisers (accessed YYYY-MM-DD); changes: describe them.

You must keep the attribution and license links, indicate whether you modified the
material, and share adaptations under the same or a compatible license (CC BY-NC-SA 4.0
or later). No commercial use. Do not add real personal information to the evaluation
corpora.

## Boundary rules

1. One primary license per file. If two rules seem to apply, package files and anything
   shipped inside an npm tarball are PolyForm; repository-root docs and docs/** are CC.
2. Code examples inside CC-licensed documentation are licensed with the document (CC),
   unless the block is explicitly marked "SPDX-License-Identifier:
   PolyForm-Noncommercial-1.0.0".
3. Third-party policy packs, DLC and Link providers are licensed by their own
   publisher; this project's LICENSE/NOTICE does not cover them.
4. LICENSE, LICENSE-DOCS and NOTICE are license texts and notices; they are distributed
   as-is and are not themselves relicensed.

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
| documentation/data/design (this repository, 0.2.0 and later) | CC-BY-NC-SA-4.0 |

See [NOTICE](NOTICE) for the same mapping.

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

Projects derived from Advisers may adopt the same policy; a copy-ready guide and Required
Notice template are in [templates/DERIVED-PROJECT-LICENSING.md](templates/DERIVED-PROJECT-LICENSING.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are licensed to the project under
the licenses above; sign off with "git commit -s" (DCO 1.1).

## 中文摘要

Advisers 采用**双许可模型**，且**不是开源项目**（非开源、源码可见）：软件采用 **PolyForm Noncommercial
License 1.0.0**（SPDX：PolyForm-Noncommercial-1.0.0，非 OSI 认证的开源许可；全文见
LICENSE，必需声明见 NOTICE）；文档、评测数据与设计材料采用 **CC BY-NC-SA 4.0**
（SPDX：CC-BY-NC-SA-4.0；全文与署名模板见 LICENSE-DOCS）。

- 软件范围：packages/**、scripts/**、.github/**、根 package.json 与 pnpm 配置，以及
  npm tarball 内的 README/NOTICE/THIRD-PARTY-NOTICES。
- 文档/数据/设计范围：根 README*.md、CHANGELOG/CONTRIBUTING/SECURITY/LICENSING、
  docs/**、eval/**、examples/**、templates/**。
- 允许用途：任何非商业目的；个人研究、实验、测试、学习、业余爱好、宗教活动；慈善、
  教育、公共研究、公共安全卫生、环保、政府机构使用。**营利机构的使用不属于允许用途**，
  需另行取得商业授权（在 https://github.com/PerryLink/advisers/issues 提出申请）。
- 分发义务：随分发提供许可条款或 URL，并保留 NOTICE 中的 Required Notice 行；
  不得再许可或转让；修改后分发须遵守 PolyForm 的 Notices 条款。
- 文档署名："Advisers documentation (c) 2026 PerryLink contributors, CC BY-NC-SA 4.0,
  https://github.com/PerryLink/advisers (accessed YYYY-MM-DD); changes: 说明"；不得移除
  署名与许可链接；修改后须以 CC BY-NC-SA 4.0（或兼容许可）分发；不得商业使用；不得向
  评测语料加入真实个人信息。
- 不追溯：0.2.0 之前发布的版本保留原许可（MIT；advisers@0.2.0-preview.71 为
  Apache-2.0），详见 NOTICE。
