# dsh-advisers

DSH bundle for **Advisers**. It registers:

- a cordis service `advisers` (an `AdvisersRuntime`);
- a read-only tool `advisers_brief` that turns a request into an `IntentBrief`
  (goal, deliverable, risk, at most one question, two-line readback).

It does **not** send messages, write the ledger, or call a model. The first DSH
slice is deliberately read-only; chat/office/link tools come next.

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

MIT.
