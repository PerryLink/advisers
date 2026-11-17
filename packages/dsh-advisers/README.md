# dsh-advisers

DSH bundle for **Advisers**. It registers:

- a cordis service `advisers` (an `AdvisersRuntime`);
- `advisers_brief` — turns a request into an `IntentBrief` (goal, deliverable, risk, at most one question, two-line readback);
- `advisers_office` — builds a DOCX/XLSX/PPTX/XMind/Mermaid/draw.io artifact **inside** the configured workspace.

It does **not** send messages or write the ledger. `advisers_office` writes files only under `config.workspace` (path-confined). The DSH adapter is a thin channel, not the full product.

## Install

```sh
dsh plugin --profile main add dsh-advisers advisers-core
dsh --profile main --dump-config   # should show a "# == dsh-advisers" layer
```

`advisers-core` must be resolvable next to the bundle in the profile. For a
local checkout:

```sh
dsh plugin --profile smoke add /path/to/advisers/packages/core /path/to/advisers/packages/dsh-advisers
```

## Manifest

- `dsh.bundle.patch = ./cordis.patch.yml`
- `engines.dsh = >=0.2.1-rc.5 <0.3.0`
- peer deps: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `advisers-core`

## Smoke

```sh
TMP=$(mktemp -d)
DSH_HOME="$TMP" dsh plugin --profile smoke add \
  ./packages/core ./packages/dsh-advisers
DSH_HOME="$TMP" dsh --profile smoke --dump-config | grep -A4 dsh-advisers
```

The bundle installs and composes. A full boot starts the Web UI and needs a
model key; it is not part of CI.

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
