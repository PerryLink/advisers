# TUI and terminal output kernel

> Scope: the output kernel (`packages/advisers/lib/tui/` + `lib/text-safe.js`) and
> the **0.4.0 interactive shell** (`lib/shell.js` + the bin entry). **Status: the
> 0.3.0 kernel is delivered and wired; the 0.4.0 interactive shell is delivered** —
> a TTY with no command enters a readline shell (no new runtime dependencies), a
> non-TTY stdin keeps the 0.3.x "print help, exit 0" path byte for byte, and
> `advisers tui --once/--json` keeps its frozen snapshot bytes. The shell reuses the
> kernel for every human line (width, sanitisation, plain/accessible policy, result/
> status/confirm/error blocks). See §10 for the kernel/shell boundary and §14 for the
> shipped shell contract (state machine, commands, hidden internal lines, non-TTY
> matrix, paste handling, Windows risks).

## 1. Why this exists

Advisers is CLI-first: every operation has a command and a `--json` projection. The
terminal layer is a *projection*, not a second product. Before 0.3.0 the human output
path had four gaps that became release blockers:

1. no display-width code at all - `console.log(reply)` with a long Chinese paragraph
   wraps at the wrong place or not at all, and `.length` is not a column count;
2. no control-character filtering - model output, tool results, IMAP greetings and
   webhook response bodies could carry ANSI/OSC/bidi and rewrite the screen or
   forge log lines;
3. no colour/terminal policy - no `--color`, no `NO_COLOR`, no `TERM=dumb`, and the
   old `tui` command cleared the screen even when stdout was a pipe;
4. no shared block/JSON shape - status lines, results, confirmations and failures were
   ad-hoc `console.log` calls.

The 0.3.0 kernel closes those gaps with small, testable pure functions. It is
deliberately not a TUI framework: no full screen, no alt-screen, no panels, no
React/Ink (see 0.3.0 planning report 26 sections 5.3 and 8).

Release gates this kernel is responsible for (0.3.0 scope report 23, M10/P1-4):
non-TTY output has no ANSI; CJK/emoji width and wrapping are correct; Windows BOM
JSON is readable; `tui </dev/null` does not hang; JSON is pure.

## 2. Module map

| Module | Responsibility | Key exports |
|---|---|---|
| `lib/text-safe.js` | console/log text safety; remote text (webhook/IMAP) before stderr or `reminders.log` | `sanitizeConsoleText`, `stripBom`, `stripTerminalSequences`, `stripBidiControls`, `stripControlChars` |
| `lib/tui/width.js` | display width, grapheme segmentation, wrapping, truncation, padding, column clamp | `strWidth`, `charWidth`, `graphemes`, `wrap`, `truncateToWidth`, `truncateMiddle`, `padToWidth`, `expandTabs`, `clampColumns` |
| `lib/tui/sanitize.js` | display policy: strip escape sequences/bidi; deep JSON display sanitisation | `sanitizeDisplay`, `jsonSafe`, `sanitizeJsonString`, `hasUnsafeDisplayChars`, `isDisplaySafe` |
| `lib/tui/color.js` | colour precedence and the 16-colour SGR whitelist | `resolveColorEnabled`, `parseColorMode`, `readColorArg`, `styleText`, `stripSgr`, `sgrCodes`, `ALLOWED_SGR_CODES` |
| `lib/tui/policy.js` | one decision object for plain/accessible/TTY/cursor refresh | `resolveOutputPolicy`, `envFlag` |
| `lib/tui/render.js` | pure block renderers (append-only lines) | `renderStatus`, `renderResult`, `renderError`, `renderConfirm`, `renderSnapshot`, `formatBytes`, `formatDuration` |
| `lib/tui/json.js` | `--json` purity helpers | `stringifyJson`, `isJsonPure`, `assertJsonPure`, `findJsonImpurity`, `errorEnvelope`, `JsonPurityError` |
| `lib/tui/text-file.js` | BOM-aware reads, BOM-less atomic writes | `readTextFile`, `readJsonFile`, `decodeTextBuffer`, `hasTextBom`, `writeTextFile`, `writeJsonFile` |
| `lib/tui/labels.js` | zh-CN display words for the kernel (single table) | `DEFAULT_LABELS` |
| `lib/tui/index.js` | barrel re-export (no side effects) | everything above plus `sanitizeConsoleText` |

No new runtime dependencies: Node 22.16+ built-ins only (`Intl.Segmenter` for
grapheme clustering, `node:fs` in `text-file.js`, existing `lib/fs-safe.js` for atomic
writes). PTY tooling is not part of the kernel.

0.3.0 human text is Simplified Chinese. The kernel keeps every display word in the
single `lib/tui/labels.js` table and accepts `options.labels`, so a future i18n seam
(`lib/i18n/zh.js` + `t()`) can replace or re-export it without touching
render/sanitize/width logic; machine-facing strings (commands, flags, JSON keys,
error codes) stay English.

## 3. Display width and wrapping

`strWidth(text)` returns terminal columns, never UTF-16 code units:

- East_Asian_Width `W`/`F` code points are 2 columns (`你`, `，`, `Ａ`, `한`, kana);
- combining marks (`Mn`/`Me`), format characters (`Cf`) and variation selectors are 0;
- emoji presentation is 2 columns; emoji ZWJ families (`👨‍👩‍👧‍👦`), flags (`🇨🇳`),
  keycaps (`1️⃣`) and skin-tone sequences count as **one** cluster of width 2;
- `e` + U+0301 is one cluster of width 1;
- East_Asian_Width `A` (ambiguous) defaults to 1 and can be measured as 2 with
  `{ ambiguousWidth: 2 }` for terminals the user configured that way. The kernel
  never uses ambiguous characters for alignment; the table is an approximation and
  is documented as such;
- ANSI/OSC sequences contribute 0 width (they are stripped before measuring).

Segmentation uses `Intl.Segmenter` with grapheme granularity, so wrapping and
truncation never split a cluster. A deterministic fallback exists for runtimes
without `Intl.Segmenter` and is reachable through the `segmenter: null` test hook.

`wrap(text, width, options)` rules:

```js
import { wrap, strWidth } from './lib/tui/index.js'

for (const line of wrap('这是一段中文文本，用来测试折行。', 40)) {
  assert(strWidth(line) <= 40)
}
```

- explicit `\n` is a hard break; CRLF/CR are normalised to `\n`;
- tabs are expanded to spaces (terminals disagree about tab stops);
- a line never starts with closing punctuation (`，。、；：！？）》」』】〕〉”’` etc.);
- a line never ends with opening punctuation (`（《「『【〔〈“‘` etc.);
- ASCII words stay together when possible and are hard-broken only when they do not
  fit alone (paths and URLs are therefore preferred whole but not guaranteed);
- a single grapheme wider than the limit (for example a CJK glyph at `width=1`) is
  emitted on its own line: column overflow is preferable to corrupting the character;
- blank lines and leading indentation of the first line are preserved; a break space
  is consumed (content is otherwise lossless).

Other helpers: `truncateToWidth` (end ellipsis, width-safe), `truncateMiddle` (keeps
head and tail; used for paths), `padToWidth` (left/right/centre padding, never
truncates), `expandTabs`, `clampColumns(columns, { min: 40, max: 200 })`.

Fixture: `test/fixtures/tui-cjk.json` - 31 width cases (CJK, fullwidth, halfwidth
kana, ambiguous, combining, emoji families/flags/keycaps/skin tones, ANSI, OSC 8,
bidi, zero-width) and 17 wrap cases at 1/4/5/8/10/20/40/80 columns. Unit tests add
seeded property tests asserting, at 40/80/200 columns: every line fits (except the
single-grapheme case), no line starts with closing punctuation on a soft break, no
line ends with opening punctuation on a soft break, no content loss or invention.

## 4. Sanitisation: three layers, three jobs

Remote and model-generated text is data. It must never be able to move the cursor,
change colours, set the window title, hide text, reorder a rendered path or inject a
second log line. The layers are intentionally different:

| Layer | Function | Keeps | Strips | Used for |
|---|---|---|---|---|
| console/log | `sanitizeConsoleText` | one line, normal words | all escape sequences, C0/C1, bidi **and all zero-width marks**, CR/LF (folded to spaces), length cap | webhook bodies, IMAP greetings/status, `friendlyError`, `reminders.log` |
| display | `sanitizeDisplay` | newlines, tabs, ZWJ/ZWNJ/ZWSP (emoji and Indic clusters), CJK punctuation | escape sequences, C0/C1, bidi overrides/isolates, U+FEFF | every `render*` field, result blocks, status line, confirmations |
| JSON display | `jsonSafe` / `sanitizeJsonString` | data value, newlines/tabs, emoji clusters | escape sequences, C0/C1, bidi overrides, U+FEFF (CRLF normalised) | human-facing JSON string fields such as `message`/`hint`/remote subject |

Why the difference: the console/log layer must be maximally defensive because a
single line is all it has, so it removes every invisible mark (including ZWJ, a
trade-off accepted for log injection defence). The display layer renders structured
blocks and must preserve emoji ZWJ families, so it only removes characters that can
forge *visual order* (bidi overrides/isolates) or hide text.

```js
import { sanitizeConsoleText } from './lib/text-safe.js'
import { sanitizeDisplay } from './lib/tui/sanitize.js'

// webhook / IMAP: one safe log line, never multi-line, never ANSI
const detail = sanitizeConsoleText(responseBody, { max: 200 })

// result block: newlines allowed, injection removed
const summary = sanitizeDisplay(modelReply, { maxWidth: 80 })
```

Both functions preserve normal Chinese punctuation, accents and emoji. They do not
interpret Markdown, HTML or URLs: external text stays text. Unit tests cover CSI,
OSC (BEL and ST terminated), OSC 8 hyperlinks, DCS/SOS/PM/APC, 8-bit C1 introducers,
raw C0/BEL, CRLF injection, bidi overrides, U+FEFF and a corpus that must never
produce a second line.

## 5. Colour policy and the 16-colour whitelist

`resolveOutputPolicy({ argv, env, stdinIsTTY, stdoutIsTTY, stderrIsTTY })` returns a
frozen object; renderers receive it (spread into options) so one decision covers the
whole invocation:

| Field | Meaning |
|---|---|
| `mode` | `'tty' \| 'plain' \| 'accessible'` |
| `color` | SGR allowed (see precedence below) |
| `plain` | interactive terminal features suppressed: no cursor control, no in-place refresh; colour off unless `--color=always` explicitly forces it |
| `accessible` | `plain` + `[状态]` status lines + no timed refresh |
| `cursorControl` | CR / clear-line / hide-cursor / alt-screen allowed |
| `statusRefresh` | status line may be rewritten in place |
| `interactive` | stdin is a TTY, so a shell may prompt |
| `reason`, `colorReason` | decision trace used by tests and `--debug` output |

Colour precedence (highest first):

1. `--plain` / `--accessible` (`ADVISERS_PLAIN`, `ADVISERS_ACCESSIBLE`): no ANSI at
   all; this wins over every colour flag;
2. explicit `--color=always|never|auto` (both `--color=x` and `--color x` forms);
3. `NO_COLOR` (present and non-empty) disables colour in `auto` mode only;
4. `TERM=dumb` / non-TTY stdout disable colour in `auto` mode;
5. default `auto`: colour when stdout is a TTY, `TERM` is not `dumb` and `NO_COLOR`
   is unset.

`--color=always` keeps its SGR on a non-TTY or `TERM=dumb` stream (explicit user
choice) but cursor control stays off there, so `plain` is still true. `--plain`
remains absolute and overrides every colour flag.

Only this whitelist may be emitted: `1` bold, `2` dim, `22` reset intensity, `31`
red, `32` green, `33` yellow, `39` reset foreground. No 256-colour, truecolour,
background, reverse, blink, underline or OSC. Colour never carries the only meaning:
every line keeps its textual prefix (`*`/`!`/`~`, `没做成`, `需要确认`, ...). Tests
extract every SGR sequence and assert it is a subset of `ALLOWED_SGR_CODES`.

## 6. Output policy: TTY, plain, accessible, JSON

| Situation | Behaviour |
|---|---|
| stdout is a TTY | colour per policy; cursor control allowed; status line may refresh (`statusRefresh`) |
| stdout is not a TTY | `mode: 'plain'`: no SGR, no cursor control, no clear-screen; output is byte-safe for pipes and CI |
| stdin is not a TTY | `interactive: false`; a shell must not enter readline (the current `advisers` no-arg non-TTY behaviour of printing help stays) |
| stdin TTY, stdout pipe | `interactive: true`, `mode: 'plain'`; the shell should print one notice and switch to plain |
| `TERM=dumb` | `mode: 'plain'` |
| `NO_COLOR` | colour off, cursor control kept (TTY only) |
| `--plain` / `ADVISERS_PLAIN` | no SGR, no cursor control |
| `--accessible` / `ADVISERS_ACCESSIBLE` | as `--plain`, plus `[状态] …` status lines and no timed refresh |
| `--json` | stdout is exactly one JSON document; human prose/diagnostics go to stderr; use `assertJsonPure` in tests/CI |

Byte contracts verified by tests: `--plain`/`--accessible` output contains no ESC,
no CR and no clear-screen/alt-screen sequences; every status line is one line and
fits the width; JSON output parses with `JSON.parse` and contains no raw C0/C1/DEL
bytes.

The JSON purity helpers separate *stream purity* from *data fidelity*:

```js
import { stringifyJson, assertJsonPure, isJsonPure } from './lib/tui/json.js'

const stdout = stringifyJson({ ok: true, command: 'status' })
assertJsonPure(stdout) // throws JsonPurityError(E_JSON_IMPURE) on human text/ANSI
stringifyJson({ message: remoteText }, { sanitize: true }) // display fields only
```

`--json` data keeps its value by default (`docs/CLI-JSON.md` is the contract);
`jsonSafe`/`sanitize: true` is for human-facing fields that a terminal may echo.
`errorEnvelope({ code, message, hint, details })` builds the stderr failure envelope
shape without owning the error-code registry (that lives in the contracts work).

## 7. Result, status, confirmation and error blocks

`renderStatus(status, options)` returns one line:

| Kind | Example |
|---|---|
| idle | `* 就绪 · 今天 2 件到期 / 1 件逾期 · deepseek-flash · /help` |
| busy | `~ 工作中 3s · Esc 中断` |
| confirm | `! 待确认 · y 写入 / n 取消（默认 n）` |
| error | `! 上次失败：同步邮件（work） · /retry` |
| offline | `* 就绪 · 模型不可达（上次失败） · /status` |
| accessible | `[状态] 就绪 · …` (no symbol, no colour) |

When the width is too small the kernel drops right-most optional segments (hint,
model, today summary) and truncates with an ellipsis. The offline kind degrades from
the front so the failure signal is never replaced by a healthy-looking `就绪`.

`renderResult(block, options)` returns `string[]` (join with `\n`) with stable
prefixes: `> ` user line, two-space indent for facts, `  - ` items, `  文件：`,
`  校验：`, `  ! ` warnings, `  下一步：`. Caps: summary 20 lines (configurable), items
8, one warning plus `（+N 条）`; overflow is always reported, never silently dropped.
`renderError({ title, reason, kept, next, code })` renders `! 没做成：` + 原因 /
已保留 / 下一步 / 代码. `renderConfirm({ title, reason, write, summary, digest })`
renders `! 需要确认：` and always ends with `y 写入 / n 取消（默认 n）`; the caller
feeds the confirmed digest back to policy (the kernel only renders/echoes it).
`renderSnapshot({ title, sections })` renders the read-only `tui --once` shape with
the same width/safety rules.

All renderers: sanitise every field, wrap to the width (prefix included), never emit
tabs or trailing spaces, do not mutate input, and are deterministic. They never read
the clock, the store, or `process.argv`. `formatBytes` (`23.4 KB`) and
`formatDuration` (`320ms`, `1.2s`, `2m5s`) are the only formatting helpers.

Golden snapshots: `test/fixtures/tui-golden.json` - 22 cases (five status kinds,
degradation at 40 columns, accessible mode, result blocks with artifacts/checks/
warnings/overflow/verbose, error and confirmation blocks at 80 and 40 columns,
snapshot) pinned as exact line arrays and re-checked for width, safety and
determinism by `test/tui-golden.test.js`.

## 8. Windows, BOM and encoding

PowerShell 5.1 writes BOMs: `Out-File -Encoding utf8` emits `EF BB BF`, `>`/`>>`
redirect emits a UTF-16LE BOM (`FF FE`). Node then reads the BOM as a character and
`JSON.parse` fails. `lib/tui/text-file.js` detects and removes a UTF-8, UTF-16LE or
UTF-16BE BOM at the read boundary (`readTextFile`/`readJsonFile`) and writes UTF-8
without a BOM atomically through `lib/fs-safe.js` (`writeTextFile`/`writeJsonFile`,
0600, durable). BOM removal affects parsing only; the original bytes and their
hashes are never rewritten. The output-side wiring is in place on the 0.3.0 tree, but
the **file-read side is still a follow-up**: routing user-editable reads
(import/template/state/office-edit/sync/vault) through these helpers is not part of the
0.3.0 bin wiring yet, so the helpers are exercised by kernel tests but not called from
`bin/advisers.js` today. Kernel tests cover all BOM variants and the no-BOM write
contract.

## 9. Testing and gates

```bash
cd packages/advisers
node --experimental-strip-types --test test/tui-*.test.js
```

| File | Covers |
|---|---|
| `test/tui-width.test.js` | fixture widths/graphemes, wrap goldens + seeded invariants, truncate/pad/tabs, fallback segmenter |
| `test/tui-text-safe.test.js` | console/log sanitizer: webhook/IMAP injection corpora, truncation, purity of one-line output |
| `test/tui-sanitize.test.js` | display sanitizer: CSI/OSC/DCS/APC/8-bit C1, CRLF, bidi, ZWJ preservation, deep `jsonSafe` |
| `test/tui-color-policy.test.js` | colour precedence, SGR whitelist audit, policy matrix, invalid `--color` |
| `test/tui-render.test.js` | status vocabulary/degradation, block prefixes/order/caps, width/safety invariants, custom labels, verbose, formatting |
| `test/tui-json.test.js` | purity checking, `JsonPurityError`, sanitize option, failure envelope |
| `test/tui-text-file.test.js` | UTF-8/UTF-16 BOM reads, BOM-less 0600 atomic writes, error mapping |
| `test/tui-golden.test.js` | the 22 human-output goldens, bounded/safe/deterministic |
| `test/bin-tui-wiring.test.js` | call-site wiring: global `--plain`/`--accessible`/`--color` handling, `resolveOutputPolicy` for `tui`/REPL, `tui </dev/null` plain snapshot, no clear-screen on a pipe |
| `test/bin-json-contracts.test.js` | `tui --json` / `--once` JSON stream purity and the CLI JSON envelopes through the kernel |
| `test/console-safe-wiring.test.js` | webhook detail + IMAP greeting/status are sanitised; bin error/log lines go through `sanitizeConsoleText` |
| `test/bin-receipt-limits.test.js` | receipt-verifier resource limits at the CLI surface (`E_RECEIPT_LIMIT`) |
| `test/shell-shell.test.js` | 0.4.0 shell pure pieces: entry decision, command/text classification and `/`-escapes, bracketed-paste merge/cap, width precedence, confirmation semantics, help/more/completer, fake-stream state transitions |

Launch-time cost: the kernel is plain ESM with no dependency graph beyond Node
built-ins. A cold import of `lib/tui/index.js` measured about 15 ms from a native
Linux filesystem (WSL2 `/mnt/d` is filesystem-bound and slower); a result block
renders in well under 5 ms (1000 renders of a small block measured about 50 ms
total). The 0.3.0 progress report target is a first prompt under 300 ms, so the
kernel must not add a heavy dependency - it adds none.

M10 mapping on the 0.3.0 tree: the *kernel* enforces plain/accessible policy, CJK width
is fixture/property-tested, and BOM JSON reads are covered by text-file tests. The
**call-site** half is now wired: `bin/advisers.js` computes `resolveOutputPolicy` once
from argv/env/TTY state for `tui` and the REPL, `tui`/`tui --once`/`tui --json` render
through the kernel, and a pipe gets one plain snapshot — verified by
`test/bin-tui-wiring.test.js`, `test/bin-json-contracts.test.js` and the `tty` +
opt-in `tui` groups of `pnpm eval:det` (`pnpm eval:det --suite tui`: 2/2). 0.4.0 adds
the interactive shell (§13) through `lib/shell.js` + `test/shell-shell.test.js`; the
remaining follow-ups are routing BOM-prone file reads through `lib/tui/text-file.js`
and PTY/Windows snapshot tooling. Windowing/refresh logic must not be added to the
kernel.

## 10. Kernel vs shell boundary (0.4.0: shell delivered)

The kernel (`lib/tui/**`, `lib/text-safe.js`) remains the **output kernel only**: it
renders data and decides capabilities, but does not read stdin, own readline, keep
history, dispatch slash commands or persist shell history. The **shell** is a separate
module, `lib/shell.js`, first shipped in 0.4.0: it owns readline, the state machine,
the command surface and the turn executor wiring, and it renders every human line
through the kernel. `tui --once/--json` keeps its frozen snapshot bytes.

| Capability | Kernel (0.3.0) | Shell (0.4.0) |
|---|---|---|
| display width / wrap / truncate | yes | reuses |
| sanitisation (display + console/log) | yes | reuses |
| colour / NO_COLOR / plain / accessible policy | yes | reuses |
| status line / result / error / confirm / snapshot renderers | yes | reuses |
| JSON purity + BOM file helpers | yes | reuses for results/JSON paths |
| readline state machine, prompt, queue, Ctrl+C/Esc/EOF | no | yes (`lib/shell.js`) |
| `advisers` no-arg TTY shell entry | no | yes (bin `runShellEntry`, `ADVISERS_NO_SHELL=1` reverts to the old REPL) |
| shell command surface (`/help` … `/evidence`, legacy `/more`) | no | yes (§13) |
| persisted shell history (`shell/history.jsonl`) | no | **no** — 0.4.0 history is in-process only (privacy: no new data plane); persistence is a 0.4.x item |
| `tui` command deprecation / `tui --once` re-wiring | no | `tui --once/--json` frozen; no deprecation warning in 0.4.0 |
| PTY semantic snapshot tooling (dev-only) | no | not shipped in 0.4.0 |

The shell is wired in `bin/advisers.js`: one `resolveOutputPolicy` per process, one
`runShell({ argv, env, stdin, stdout, stderr, store, handlers })` call, and thin
handler adapters that reuse the existing read-only views and one turn executor. The
kernel integration rules still apply: compute the policy once at start; pass `{ width,
...policy }` to renderers; print rendered lines with the stream's line ending; route
diagnostics/errors to stderr; when `policy.interactive` is false do not enter the
shell; when `policy.statusRefresh` is false print `[状态] …` lines instead of
rewriting; gate `--json` stdout with `assertJsonPure` in tests.

## 11. Explicit non-goals (0.3.x and 0.4.0)

Full screen / alt-screen / differential full-screen redraw; mouse; images or sixel;
tool cards, diffs, timelines, side panels, subagent docks; theme engine, gradients,
ASCII art, animated emoji; win32-input-mode or extended keyboard protocols;
token-level streaming or reasoning display; multi-line editor / vim keys / syntax
highlighting; business subcommands as shell slash commands; Web GUI changes;
third-party UI dependencies (Ink/React/pi-tui); telemetry, crash reporting or update
checks; changing ledger/policy/network behaviour from the UI layer.

## 12. Known limitations

- East_Asian_Width coverage is a hand-maintained table (no Unicode data files). W/F
  and common emoji are covered; rare scripts and the full ambiguous set are
  approximated. The kernel never uses ambiguous characters for alignment, and
  `ambiguousWidth: 2` is opt-in.
- Emoji presentation ultimately depends on the user's terminal font; the kernel
  computes columns per UAX #11/emoji rules, which is what terminals in scope do.
- Bidi controls are removed, not rendered; RTL text is displayed in logical order
  (an intentional safety trade-off).
- The console/log sanitiser removes ZWJ/ZWNJ (zero-width) for log-injection
  defence; emoji families appear as separate emoji in log lines. Display blocks
  preserve them.
- Real Windows IME behaviour in raw mode and old-conhost VT behaviour remain
  manual/D-level checks for the shell; `--plain` is the escape hatch (§13.6).
- Shell history is **in-process only** in 0.4.0: no `shell/history.jsonl`, no
  last-turn file, so no new privacy/export/purge surface. Persisted history is a
  0.4.x item and will ship with the PRIVACY/export/purge wiring in the same change.
- Bracketed paste needs a terminal that emits it (Windows Terminal 1.7+, most modern
  terminals). Older conhost/terminals degrade to ordinary input: a multi-line paste
  may execute line by line. There is no reliable workaround in 0.4.0.
- `--plain`/`--accessible` (and `ADVISERS_SHELL_CANONICAL=1`) switch readline to
  `terminal:false`, which delivers the promised zero cursor-control bytes but
  **hands line editing/history/completion to the terminal** and disables Esc
  interruption; use Ctrl+C instead.
- The output-side wiring is done: `bin/advisers.js` uses `resolveOutputPolicy`
  globally, renders `tui`/`tui --once`/`tui --json` and the REPL/shell blocks through
  the kernel, and `lib/notify.js`/`lib/imap.js` route remote text through
  `sanitizeConsoleText`. Remaining follow-ups are routing user-editable file reads
  through the BOM helpers (`lib/tui/text-file.js`) and PTY/Windows TTY snapshot
  tooling; the call-site tests above are the enforcement for the wired paths.

## 13. Interactive shell (0.4.0)

`lib/shell.js` (≈1,400 lines, no new runtime dependencies) is the interactive shell.
`bin/advisers.js` only injects process state: the ledger/store, one turn executor with
an `AbortSignal`, and read-only view adapters. The shell never forks the kernel's
renderers.

### 13.1 Entry and exit

| Situation | Behaviour |
|---|---|
| `advisers` with stdin a TTY (TOS gate already passed) | enters the shell: status line, optional 1–2 line opening, `› ` prompt |
| `advisers` non-TTY stdin | unchanged 0.3.x behaviour: print help, exit 0 (tests freeze this) |
| stdin TTY + stdout a pipe | shell keeps running; prompts/status/confirmations go to **stderr**, results stay on stdout; one stderr notice says so |
| `advisers` + `--json` (shell path) | `E_USAGE` on stderr, exit 1; the machine path is `tui --once --json` or a CLI command |
| `ADVISERS_NO_SHELL=1` | falls back to the pre-0.4 REPL (explicit escape hatch) |
| `/quit`, `/exit`, Ctrl+D, EOF | exit 0 |
| TOS gate blocks | exit 3 (unchanged) |

### 13.2 State machine

```text
IDLE --submit--> WORKING --done/failed--> IDLE (renders a result/error block + status line)
  ^                |--confirm--> CONFIRM --y--> WORKING / --n|Enter|Esc--> IDLE
  |                +--Ctrl+C|Esc--> IDLE (abort signal; renders an interrupted block)
  +-- /quit, /exit, Ctrl+D, EOF --> EXIT(0)
```

- **IDLE Ctrl+C**: first press clears the current line and prints `（再按一次 Ctrl+C 退出；或输入 /quit）`; a second press within 2 s exits 0.
- **WORKING**: input is buffered by readline (state `QUEUED`) and reappears at the next prompt; Ctrl+C/Esc aborts the turn through `AbortSignal` (`CANCELLED_BY_USER`), renders an interrupted block and does **not** count as a failure or exit the shell.
- **CONFIRM**: a modal `y/yes/是` vs anything-else (= no); Enter, EOF and Ctrl+C all mean no. Non-TTY input never confirms; the policy layer decides the fallback.
- **Exit codes**: 0 normal/EOF/quit; 1 usage or shell error; 3 TOS gate.

### 13.3 Command surface

```text
/help /more /status /verbose /history /resume <n|id> /new
/file <path> /files /clear /retry
/today /remind /who /client [list|<id>] /evidence <id>
/quit /exit
```

- `/help` is short (≤10 lines) and points business writes to `advisers --help`; `/more` lists the pre-0.4 slash commands (all still routed and functional: `/deliveries`, `/tick`, `/week`, `/memory`, `/prefs`, `/links`, `/audit`, `/agenda`, `/search`, `/digest`, `/diff`, `/undo`, `/why`, `/forget`, `/correct`, `/decay`, `/matter use`, `/commit ...`, `/done ...`, `/routine save`, `/brief ...`, `/debug`).
- **Business writes stay in the CLI.** The shell returns a result block whose `下一步` names the exact `advisers ...` command (e.g. `client export`, `deliveries --pack`).
- A line starting with `/` is a command; `//text` sends text starting with one `/`; a line whose first character is whitespace but trims to `/...` is sent as text. Unknown `/commands` produce an error block with `/help` — never a model turn.
- `/client` and `/evidence` are read-only adapters over the same functions as the CLI; they do not add a second business implementation.

### 13.4 Hidden internal lines (three levels)

| Level | Contents | Visibility |
|---|---|---|
| **always** | user line, reply summary, artifacts, checks, warnings (≤1 + `（+N 条）`), next step, error block, confirmation block, safety block | every turn, rendered by `renderResult`/`renderError`/`renderConfirm` + one status line |
| **internal** | tool names + ok/fail, attachment extraction names, compaction rounds, model name/latency, learn/routine candidate ids | only with `/verbose` or `ADVISERS_PROGRESS=1`/`ADVISERS_DEBUG=1` |
| **never** | tool arguments/output, context/prompt, raw tool JSON, stack traces, token/cost accounting, safety rule internals, full external text | never rendered in the shell |

`/verbose` toggles the internal level for the session and is equivalent to `ADVISERS_PROGRESS=1`; internal lines are one dim `· …` line each. Every human line is sanitised by the display layer (no ANSI/OSC/bidi/control injection); user-facing result fields are width-wrapped.

### 13.5 Width, plain, accessible

- Width precedence: `--width N`/`--width=N` -> `ADVISERS_SHELL_WIDTH` -> `stdout.columns`, clamped to 40..200; read again on every render, so resizing affects later blocks.
- Plain/accessible: `--plain`/`ADVISERS_PLAIN`, `--accessible`/`ADVISERS_ACCESSIBLE`, `NO_COLOR`, `TERM=dumb` follow the kernel policy (§5–§6). In plain/accessible the shell uses `terminal:false` (zero ESC/CR, `[状态]` lines in accessible mode) and accepts the documented trade-off (§12).
- `ADVISERS_SHELL_CANONICAL=1` forces the canonical input path independent of the output policy (IME escape hatch).
- `ADVISERS_SHELL_NO_OPENING=1` suppresses the opening lines; the prompt is not blocked by opening queries.

### 13.6 Paste and interruption details

- A bracketed paste (`ESC[200~ … ESC[201~`) is merged into **one line**: CR/LF/tabs fold to spaces, terminal sequences are stripped, runs of spaces collapse, and the result is capped at 4,000 characters. A notice `已合并 N 行粘贴为一条输入` (and `已截断` when capped) is rendered; the merged line is then classified as command or text like any other.
- Without bracketed paste the terminal does not mark pasted newlines, so a multi-line paste can execute line by line — a documented limitation (§12), not a bug the shell can fix portably.
- Esc interruption works only in raw terminal mode (`terminal:true`). In `--plain`/canonical mode Esc is unavailable; use Ctrl+C.

### 13.7 Environment variables

| Variable | Effect |
|---|---|
| `ADVISERS_NO_SHELL=1` | do not enter the shell; use the legacy REPL |
| `ADVISERS_SHELL_CANONICAL=1` | force `terminal:false` canonical input (0 ESC) |
| `ADVISERS_SHELL_WIDTH=N` | fixed render width (clamped 40..200) |
| `ADVISERS_SHELL_NO_OPENING=1` | skip the opening lines |
| `ADVISERS_PROGRESS=1` / `ADVISERS_DEBUG=1` | show internal lines (same as `/verbose`) |

### 13.8 Privacy and data

- History is in-process only (bounded ring); the shell writes **no** new file: no history JSONL, no last-turn marker, no log of customer text or tool output. `/history` and `/resume` read the existing session list; `/history` only shows conversation titles.
- The shell does not change policy/egress behaviour: every turn still goes through the same TOS/consent/clearance/policy path as `advisers chat`. `/client` and `/evidence` are read-only and clearance-filtered.
- If persisted history is added later, it must ship with the PRIVACY data-list row plus `export`/`purge` coverage in the same change.

### 13.9 Windows and terminal risks

- The shell only uses line-oriented readline + the kernel; it does not enable win32-input-mode, alt-screen or raw full-screen redraw. `--plain` is the supported escape hatch.
- Bracketed paste requires Windows Terminal 1.7+ (or another VT terminal that emits it); old conhost falls back to ordinary input (§12).
- IME behaviour in raw mode remains a manual, D-level check on real Windows hardware; Windows CI covers the non-TTY smoke paths (`tui --once`, help, JSON purity), not interactive IME.
- `--json` output redirected to a file with PowerShell 5.1 `>` still gets a UTF-16LE BOM; use `--out`/the atomic BOM-less writers where a command offers them, or re-encode the file before parsing.

### 13.10 Tests

- `test/shell-shell.test.js` covers the pure shell pieces (entry decision, line classification/escapes, paste merge/caps, width resolution, confirm answers, help/more/completer, state transitions with fake streams).
- `test/bin-tui-wiring.test.js`, `test/bin-json-contracts.test.js`, `test/console-safe-wiring.test.js` keep the frozen `tui`/pipe/JSON/sanitisation contracts around the shell.
- PTY/xterm-headless semantic snapshots and real Windows TTY runs are not shipped in 0.4.0; they remain the planned hardening for the shell (documented as D-level checks above).

## 14. References

- Unicode UAX #11 East_Asian_Width: https://www.unicode.org/reports/tr11/
- NO_COLOR convention: https://no-color.org/
- clig.dev command-line guidelines: https://clig.dev/
- Node TTY documentation: https://nodejs.org/api/tty.html
- PowerShell character encoding (5.1 BOM behaviour):
  https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding
- Windows console virtual terminal sequences:
  https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences
- 0.3.0 planning: `01-research/advisers-hardening-2026-11-17/04-0.3-research/17-tui-minimal-shell.md`
  and `01-research/advisers-hardening-2026-11-17/05-0.3.0-planning/26-0.3.0-ux-tui.md`
  (outside this repository).

