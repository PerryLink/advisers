// ---------------------------------------------------------------------------

/**
 * Canonical `--help` usage lines per command path (0.5.0 U1a).
 *
 * Extracted byte-for-byte from the 0.4.3 `bin/advisers.js` `HELP_USAGE_LINES`
 * map so the CLI short-circuit and the tests read one source instead of keeping
 * a second hand-written copy. `setup`/`demo` are the 0.5.0 additions.
 *
 * Human-only: this is not a frozen JSON contract, and the `-h`/`--help`
 * short-circuit runs before the TOS gate and before dispatch, so an entry must
 * never be able to execute a command (it is only written to stdout).
 */
export const HELP_USAGE_LINES = new Map(Object.entries({
  version: 'usage: advisers version',
  status: 'usage: advisers status [--json]',
  doctor: 'usage: advisers doctor [--check-db] [--json] [--report]\n       advisers doctor --repair [--dry-run|--yes] [--only lock,temp,wal,fts] [--json]',
  init: 'usage: advisers init',
  chat: 'usage: advisers chat [--file <path>] [--allow-path <dir>]... <text>',
  history: 'usage: advisers history',
  mcp: 'usage: advisers mcp --stdio',
  deliver: 'usage: advisers deliver [--commit id] [--type confirmation|weekly|statement|ledger] [--format docx|xlsx|pdf] [--out f]',
  timestamp: 'usage: advisers timestamp <file> [--out proof]',
  tui: 'usage: advisers tui [--once] [--json] [--width <40..200>] [--plain|--accessible] [--color auto|always|never]',
  ocr: 'usage: advisers ocr <image> [--out text]',
  evidence: 'usage: advisers evidence show <id> [--json]\n       advisers evidence verify <dir>',
  'evidence show': 'usage: advisers evidence show <id> [--json]',
  'evidence verify': 'usage: advisers evidence verify <dir>',
  receipt: 'usage: advisers receipt',
  deliveries: 'usage: advisers deliveries [--pack|--receipt] [--out dir] [--ids ...] [--all] [--json]',
  commit: 'usage: advisers commit add|edit|ls|done|snooze ...',
  'commit add': 'usage: advisers commit add "<action>" --quote "<原话>" [--due ISO|相对日期] [--debtor user|agent] [--creditor name] [--matter id] [--remind-offsets "-1d,-2h"]',
  'commit edit': 'usage: advisers commit edit <id> [--action text] [--due ISO|相对日期] [--matter id] [--remind-offsets "<list>" | --no-remind]',
  'commit ls': 'usage: advisers commit ls [--json]',
  'commit done': 'usage: advisers commit done <id> --evidence "<证据/原话>"',
  'commit snooze': 'usage: advisers commit snooze <id> <hours>',
  help: 'usage: advisers help [<topic>] [--list]',
  'learn ls': 'usage: advisers learn ls',
  'learn review': 'usage: advisers learn review <run-id>',
  diff: 'usage: advisers diff',
  undo: 'usage: advisers undo [--list] [--force]',
  compact: 'usage: advisers compact ls|rollback <version>',
  search: 'usage: advisers search <text> [--scope turns|kb|pages|facts|all] [--json]',
  nudge: 'usage: advisers nudge list|done|ignore <nudge-id>',
  risks: 'usage: advisers risks',
  'pet-brief': 'usage: advisers pet-brief [--json] [--out [path]] [--check [--strict]] [--display-policy public|private|none]',
  today: 'usage: advisers today [--calendar] [--sources] [--json] [--limit n]',
  tick: 'usage: advisers tick',
  week: 'usage: advisers week [--json]',
  ui: 'usage: advisers ui [--port n]',
  remind: 'usage: advisers remind [--json] [--now ISO] [--ics [path]] [--deliver [--notify]] [--quiet-hours HH:MM-HH:MM] [--force-notify]\n       advisers remind install|uninstall|status [--apply] [--schedule "0 9 * * *"]',
  'remind install': 'usage: advisers remind install [--apply] [--schedule "0 9 * * *"] [--morning [--morning-time 08:30] [--morning-days 1-5]]',
  'remind uninstall': 'usage: advisers remind uninstall [--apply]',
  'remind status': 'usage: advisers remind status',
  calendar: 'usage: advisers calendar import --ics <file>',
  'calendar import': 'usage: advisers calendar import --ics <file>',
  who: 'usage: advisers who [--json]',
  memory: 'usage: advisers memory [--all]\n       advisers memory search <q> | candidates [--json] [--all] | accept <id> | reject <id> [--reason <r>]',
  digest: 'usage: advisers digest day|week|morning',
  prefs: 'usage: advisers prefs [--all]',
  privacy: 'usage: advisers privacy [--json] [--prove [--brief]]\n       advisers privacy --matrix [--json]',
  audit: 'usage: advisers audit [--check-db] [--json]\n       advisers audit --write-anchor [--json] | --expect-count <N> [--expect-head <64 hex>] | --rebuild-fts',
  purge: 'usage: advisers purge <matter-id> [--yes]',
  decay: 'usage: advisers decay',
  correct: 'usage: advisers correct <statement>',
  ls: 'usage: advisers ls',
  why: 'usage: advisers why <pref-id|fact-id>',
  forget: 'usage: advisers forget <pref-id>',
  sync: 'usage: advisers sync push|pull|status --dir <sync-dir> [--force] [--file name] [--device name] [--dry-run] [--json]',
  'sync push': 'usage: advisers sync push --dir <sync-dir> [--force] [--file name] [--device name] [--dry-run] [--json]',
  'sync pull': 'usage: advisers sync pull --dir <sync-dir> [--force] [--file name] [--dry-run] [--json]',
  'sync status': 'usage: advisers sync status [--dir <sync-dir>] [--json]',
  vault: 'usage: advisers vault seal [--out file] [--remove] | unseal [file] | status',
  export: 'usage: advisers export [--all] [--out <file>] [--encrypted]',
  import: 'usage: advisers import <file> [--replace]',
  backup: 'usage: advisers backup [--out <file> | <path.db>] [--tag <name>] [--keep daily=7,weekly=4,monthly=3] [--dry-run|--apply] [--json]',
  backups: 'usage: advisers backups ls|verify [--json] [--limit <n>]',
  'backups ls': 'usage: advisers backups ls [--json] [--limit <n>]',
  'backups verify': 'usage: advisers backups verify [--json] [--limit <n>]',
  restore: 'usage: advisers restore <backup-file> [--dry-run] [--yes] [--allow-anchor-behind] [--allow-broken-audit-chain] [--json]',
  brief: 'usage: advisers brief [--deep] <text>',
  review: 'usage: advisers review <file> --request "..."',
  research: 'usage: advisers research --web|--url <url> [--deep] <query>',
  capture: 'usage: advisers capture [--file <path|->] [--source wechat|meeting|email|note|stdin] [--date ISO] [--matter id] [--rules|--local|--model] [--json] [<text>]\n       advisers capture --from-mail <file|dir> [--limit n]\n       advisers capture --from-transcript <file>\n       advisers capture --from-imap',
  policy: 'usage: advisers policy check <text>',
  'office-read': 'usage: advisers office-read <file>',
  verify: 'usage: advisers verify <file> [--json] [--content] [--template quote|proposal --data <file>]',
  'office-edit': 'usage: advisers office-edit <file> <ops.json> [out]',
  office: 'usage: advisers office <docx|xlsx|pptx|xmind|mermaid|drawio> <spec.json> <out>',
  routine: 'usage: advisers routine ls|add|approve|archive|patches|patch|diff|apply|reject|revert|check|curate|restore ...',
  template: 'usage: advisers template quote|proposal <data.json> <out.docx|out.xlsx> [--json] [--record-delivery] [--matter id]\n       advisers template <weekly|budget|presentation|flow|mindmap|minutes|notice> <data.json> <out>',
  link: 'usage: advisers link ls|add|confirm|suggest|updates|propose-update|apply|diff|reject|rollback ...',
  bridge: 'usage: advisers bridge --dir <BRIDGE_DIR> [--name advisers]',
  soul: 'usage: advisers soul show | set <file> | init',
  'soul show': 'usage: advisers soul show',
  'soul set': 'usage: advisers soul set <file>',
  'soul init': 'usage: advisers soul init',
  tos: 'usage: advisers tos <show|status|accept|revoke>',
  'tos show': 'usage: advisers tos show [--as-version <version>]',
  'tos status': 'usage: advisers tos status [--json]',
  'tos accept': 'usage: advisers tos accept',
  'tos revoke': 'usage: advisers tos revoke [--yes]',
  matter: 'usage: advisers matter <add|ls|show|rename|archive|use> ...',
  agenda: 'usage: advisers agenda [--days 1..31] [--from YYYY-MM-DD] [--matter id] [--no-calendar] [--include-done] [--json] [--now ISO]',
  morning: 'usage: advisers morning [--days 1..31] [--matter id] [--top 1..5] [--out file] [--archive [--keep 1..365]] [--json] [--now ISO]',
  fact: 'usage: advisers fact add <subject> <predicate> <object> --quote "..." [--json]\n       advisers fact show <id> | history <id> | as-of <YYYY-MM-DD|ISO> [--json]',
  consent: 'usage: advisers consent status|grant <surface>|revoke <surface> [--data-class mail|kb] [--yes] [--json]',
  agent: 'usage: advisers agent ...',
  // 0.4.0 command families
  kb: 'usage: advisers kb add <file>... [--title s] [--kind k] [--client id] [--project id] [--matter id] [--secrecy 0-3] [--replace] [--from list.txt] [--json]\n       advisers kb ls|show <id>|rm <id>|purge <id>|reindex [--json] | kb search <q> | kb page ls|show|rebuild|diff',
  'kb add': 'usage: advisers kb add <file>... [--title s] [--kind quote|contract|receipt|delivery|note|other] [--client id] [--project id] [--matter id] [--secrecy 0-3] [--replace] [--from list.txt] [--json]',
  'kb ls': 'usage: advisers kb ls [--client id] [--matter id] [--kind k] [--all] [--limit n] [--clearance 0-3] [--json]',
  'kb show': 'usage: advisers kb show <id> [--chunks 0..20] [--clearance 0-3] [--json]',
  'kb rm': 'usage: advisers kb rm <id> [--json]',
  'kb purge': 'usage: advisers kb purge <id> [--dry-run|--yes] [--json]',
  'kb reindex': 'usage: advisers kb reindex [--rebuild] [--json]',
  'kb search': 'usage: advisers kb search <query> [--scope kb|pages|all] [--limit n] [--clearance 0-3] [--json]',
  'kb page': 'usage: advisers kb page ls|show|rebuild|diff ... [--json]',
  'kb page ls': 'usage: advisers kb page ls [--kind client|project|timeline|facts] [--check] [--limit n] [--json]',
  'kb link': 'usage: advisers kb link <doc-id> --fact <fact-id> [--relation source|mentions] [--chunk id] [--json]',
  'kb unlink': 'usage: advisers kb unlink <doc-id> --fact <fact-id> [--relation source|mentions] [--json]',
  mail: 'usage: advisers mail account add|ls|show|test|rm ...\n       advisers mail sync [<acct>] [--full] [--dry-run] [--json] [--watch [--interval 300s] [--max-runs n]]\n       advisers mail ls|show <id> [--body]|purge|import|extract|link|dismiss ... [--json]',
  'mail account': 'usage: advisers mail account add|ls|show|test|rm ...',
  'mail account add': 'usage: advisers mail account add|ls|show|test|rm ...\n  advisers mail account add --name n --host h [--port 993] [--tls tls|starttls] --user u [--pass-stdin]',
  'mail account ls': 'usage: advisers mail account ls [--json]',
  'mail account show': 'usage: advisers mail account show <acct> [--json]',
  'mail account test': 'usage: advisers mail account test <acct> [--json]',
  'mail account rm': 'usage: advisers mail account rm <acct> [--json]',
  'mail sync': 'usage: advisers mail sync [<account>] [--full] [--dry-run] [--since-days n] [--limit n] [--mailbox INBOX] [--json] [--watch [--interval 300s] [--max-runs n]]',
  'mail ls': 'usage: advisers mail ls [--account a] [--client id] [--status s] [--since 30d] [--limit n] [--json]',
  'mail show': 'usage: advisers mail show <id> [--body] [--json]',
  'mail purge': 'usage: advisers mail purge [--older-than 30d] [--dry-run|--yes] [--account a] [--json]',
  'mail import': 'usage: advisers mail import <file|dir> [--limit n] [--dry-run] [--client id] [--project id] [--json]',
  'mail extract': 'usage: advisers mail extract [<id>...] [--all-new] [--local|--model] [--yes] [--matter id] [--limit n] [--dry-run] [--json]',
  'mail link': 'usage: advisers mail link <message> [--client id] [--project id] [--json]',
  'mail dismiss': 'usage: advisers mail dismiss <message> [--json]',
  receivable: 'usage: advisers receivable add <client-id> "<label>" --amount 8000.00 [--due DATE] [--currency CNY] [--json]\n       advisers receivable ls|show <id>|edit <id>|void <id> [--aging] [--json]\n       advisers receivable export [--out f.csv] [--json]',
  'receivable add': 'usage: advisers receivable add <client-id> "<label>" --amount 8000.00 [--due DATE|相对日期] [--currency CNY] [--client-matter id] [--json]',
  'receivable ls': 'usage: advisers receivable ls [--client id] [--status s] [--aging] [--clearance 0-3] [--json]',
  'receivable show': 'usage: advisers receivable show <id> [--json]',
  'receivable edit': 'usage: advisers receivable edit <id> [--label s] [--amount n] [--due DATE|相对日期] [--json]',
  'receivable void': 'usage: advisers receivable void <id> [--reason s] [--json]',
  'receivable export': 'usage: advisers receivable export [--client id] [--project id] [--currency c] [--status active|all] [--due-within 7d|30d] [--clearance 0-3] [--out f.csv|-] [--bom] [--json]',
  payment: 'usage: advisers payment add <client-id> --amount 4000.00 [--receivable rcv] [--method bank] [--json]\n       advisers payment ls|void <id> [--json]',
  'payment add': 'usage: advisers payment add <client-id> --amount 4000.00 [--receivable rcv] [--currency CNY] [--paid-at ISO] [--method bank|wechat|alipay|cash|other] [--json]',
  'payment ls': 'usage: advisers payment ls [--receivable id] [--json]',
  'payment void': 'usage: advisers payment void <id> [--json]',
  client: 'usage: advisers client <add|list|show|timeline|archive|merge|export|note> ...',
  'client add': 'usage: advisers client add "<name>" [--aliases a,b] [--tags t1,t2] [--secrecy 0-3] [--note text] [--link-matter <id>] [--json]',
  'client list': 'usage: advisers client list [--all] [--limit n] [--json]',
  'client show': 'usage: advisers client show <id> [--timeline-limit n] [--clearance 0-3] [--json]',
  'client timeline': 'usage: advisers client timeline <id> [--since 90d|ISO] [--kind delivery,note,commitment] [--limit n] [--clearance 0-3] [--json]',
  'client archive': 'usage: advisers client archive <id> [--dry-run] [--json]',
  'client merge': 'usage: advisers client merge <from-id> <into-id> [--dry-run] [--json]',
  'client export': 'usage: advisers client export <id> [--format md|docx] [--out <file>] [--redact-names] [--pack] [--json]',
  'client note': 'usage: advisers client note add|list <id> ...',
  'client note add': 'usage: advisers client note add <id> "<summary>" [--kind k] [--at ISO] [--project id] [--matter id] [--json]',
  'client note list': 'usage: advisers client note list <id> [--project <id>] [--limit n] [--json]',
  project: 'usage: advisers project <add|list|show|archive> ...',
  'project add': 'usage: advisers project add <client-id> "<name>" [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--default-matter <id>] [--note text] [--json]',
  'project list': 'usage: advisers project list [--client <id>] [--all] [--limit n] [--json]',
  'project show': 'usage: advisers project show <id> [--timeline-limit n] [--clearance 0-3] [--json]',
  'project archive': 'usage: advisers project archive <id> [--dry-run] [--json]',
  // 0.4.3 additions
  inbox: 'usage: advisers inbox ls [--source capture|mail|all] [--limit n] [--offset n] [--clearance 0-3] [--json]\n       advisers inbox show <candidate-id> [--clearance 0-3] [--json]',
  profile: 'usage: advisers profile show [--json]\n       advisers profile export [--out <file>] [--json]',
  // 0.5.0 (WF5 050-U2): new command surfaces are pure usage requests too.
  setup: 'usage: advisers setup [--yes] [--accept-tos] [--dry-run] [--json] [--no-demo]\n       advisers setup [--mail none|eml:<path|dir>] [--name <称呼>] [--soul-file <file>]',
  demo: 'usage: advisers demo [weekly|quote|receipt] [--out <dir>] [--home <dir>] [--json] [--clean]',
}))

/** Leading non-flag tokens before the first `-h/--help`, capped at 4. */
export function helpRequestTokens(argv) {
  const tokens = []
  for (const token of argv) {
    if (token === '--help' || token === '-h') continue
    if (typeof token !== 'string' || token.startsWith('-')) break
    tokens.push(token)
    if (tokens.length >= 4) break
  }
  return tokens
}

/** Longest known command path in argv; null for the top-level help request. */
export function helpRequestUsage(argv) {
  const tokens = helpRequestTokens(argv)
  if (!tokens.length) return null
  if (tokens[0] === 'help') return HELP_USAGE_LINES.get('help') ?? null
  for (let length = tokens.length; length >= 1; length--) {
    const line = HELP_USAGE_LINES.get(tokens.slice(0, length).join(' '))
    if (line) return line
  }
  // Unknown path: a generic usage keeps `advisers <cmd> --help` a pure read.
  return 'usage: advisers ' + tokens.join(' ') + ' [options]'
}
