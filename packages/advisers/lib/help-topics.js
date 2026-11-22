/**
 * Task-oriented help topics for `advisers help <topic>` (0.5.0 U1a).
 *
 * The 0.4.3 CLI already had `-h/--help` short-circuiting every command path
 * (see lib/help-usage.js). This module adds the human-facing half: ten curated
 * topics with Chinese aliases, each a short, copy-pasteable page. One source
 * feeds `help <topic>`, `help --list` and the `setup` "next steps" cards, so
 * the same wording cannot drift across three surfaces.
 *
 * Invariants enforced by test/help-topics.test.js:
 *  - every topic page is <= 20 lines and carries no ANSI/control characters;
 *  - a topic and its Chinese alias render byte-identical bytes;
 *  - unknown topics resolve to null (the CLI keeps stdout empty and exits 1);
 *  - the pages are plain text: nothing here reads HOME, executes a command or
 *    depends on process state, so `advisers help <topic>` works before TOS
 *    acceptance and on a byte-empty fresh home.
 *
 * @module help-topics
 */

import { HELP_USAGE_LINES } from './help-usage.js'

/** Canonical topic order for `help --list` and the setup cards. */
export const HELP_TOPIC_IDS = Object.freeze([
  'start',
  'quote',
  'remind',
  'deliver',
  'receipt',
  'mail',
  'kb',
  'privacy',
  'reach',
  'errors',
])

/** Chinese alias -> canonical topic id (the alias pages are byte-identical). */
export const HELP_TOPIC_ALIASES = Object.freeze({
  上手: 'start',
  报价: 'quote',
  提醒: 'remind',
  交付: 'deliver',
  回执: 'receipt',
  收件箱: 'mail',
  知识库: 'kb',
  隐私: 'privacy',
  可达性: 'reach',
  排错: 'errors',
})

const DOC_NOTE = '仓库 docs/（安装包不含 docs）'

/**
 * Topic bodies. Format per page (<= 20 lines): one-line promise, three
 * copy-pasteable commands, one next step, one documentation pointer.
 * `lines: null` means "use the canonical body below".
 */
const TOPICS = Object.freeze({
  start: {
    title: '上手',
    summary: '三步开始：建好本地工作台、跑一条合成演示、知道下一步敲什么。',
    lines: [
      '主题：上手（start）',
      '一句话：三步开始——建好本地工作台、跑一条全合成演示、知道下一步敲什么。',
      '命令：',
      '  advisers setup --json --yes --accept-tos',
      '  advisers demo --json',
      '  advisers help --list',
      '下一步：advisers help quote',
      '文档：仓库 docs/QUICKSTART.md §0（安装包不含 docs）',
    ],
  },
  quote: {
    title: '报价',
    summary: '用确定性模板生成报价 docx/xlsx，留下数据哈希并用回执包证明交付。',
    lines: [
      '主题：报价（quote）',
      '一句话：报价是确定性模板——同样的 data.json 生成同样的文档和 dataSha256。',
      '命令：',
      '  advisers template quote <data.json> out/quote.docx --json',
      '  advisers verify out/quote.docx --content --template quote --data <data.json>',
      '  advisers deliveries --receipt --client <client-id> --out out/receipt --json',
      '下一步：advisers help receipt',
      '文档：仓库 docs/QUICKSTART.md、docs/DELIVERY-RECEIPT.md（安装包不含 docs）',
    ],
  },
  remind: {
    title: '提醒',
    summary: '给承诺设截止日期，导出 .ics（含 VALARM），不自动发送任何东西。',
    lines: [
      '主题：提醒（remind）',
      '一句话：承诺带截止日期，提醒只在本地生成；.ics 导入任何日历，软件自己不发送。',
      '命令：',
      '  advisers commit add "周五前发报价" --quote "周五前发报价" --due 2026-12-05',
      '  advisers remind --json',
      '  advisers remind --ics out/reminders.ics',
      '下一步：advisers help deliver',
      '文档：仓库 docs/REMINDERS.md（安装包不含 docs）',
    ],
  },
  deliver: {
    title: '交付',
    summary: '生成提案/交付物，记录交付血缘，再走回执包。',
    lines: [
      '主题：交付（deliver）',
      '一句话：每份交付物先校验结构，再记录交付血缘；对外只认回执包。',
      '命令：',
      '  advisers template proposal <data.json> out/proposal.docx --record-delivery --json',
      '  advisers verify out/proposal.docx --content --json',
      '  advisers deliveries [--json]',
      '下一步：advisers help receipt',
      '文档：仓库 docs/DELIVERY-RECEIPT.md（安装包不含 docs）',
    ],
  },
  receipt: {
    title: '回执',
    summary: '生成可离线校验的交付回执包（manifest + SHA256SUMS + receipt.docx）。',
    lines: [
      '主题：回执（receipt）',
      '一句话：回执包按客户/项目限定范围，manifest 记字段与摘要，离线可校验。',
      '命令：',
      '  advisers deliveries --receipt --client <client-id> --out out/receipt --json',
      '  advisers evidence verify out/receipt --json',
      '  advisers deliveries --receipt --project <project-id> --out out/receipt-p --json',
      '下一步：advisers help mail',
      '文档：仓库 docs/DELIVERY-RECEIPT.md（安装包不含 docs）',
    ],
  },
  mail: {
    title: '收件箱',
    summary: '只读导入 .eml/.mbox，本地规则抽承诺，模型路径必须显式 opt-in。',
    lines: [
      '主题：收件箱（mail）',
      '一句话：邮件只读导入本机；默认本地规则抽承诺，模型抽取得你显式同意并单独 opt-in。',
      '命令：',
      '  advisers mail import <file|dir> --json',
      '  advisers mail ls --limit 20 --json',
      '  advisers mail extract --local --json',
      '下一步：advisers help kb',
      '文档：仓库 docs/QUICKSTART.md、docs/MCP.md（安装包不含 docs）',
    ],
  },
  kb: {
    title: '知识库',
    summary: '把本地文档加入知识库，按客户/事项检索；页与事实可确定复现。',
    lines: [
      '主题：知识库（kb）',
      '一句话：知识库只读本地文件，检索在本机；确定性编译页与事实可复现。',
      '命令：',
      '  advisers kb add <file> --title <标题> --json',
      '  advisers kb search "<关键词>" --json',
      '  advisers kb page ls --json',
      '下一步：advisers help privacy',
      '文档：仓库 docs/KB.md（安装包不含 docs）',
    ],
  },
  privacy: {
    title: '隐私',
    summary: '查看本机数据边界与出网矩阵，导出备份或删除属于你的数据。',
    lines: [
      '主题：隐私（privacy）',
      '一句话：数据默认留在本机；出网面逐条登记，导出/删除永远可用（不受 TOS 门控）。',
      '命令：',
      '  advisers privacy --prove --brief',
      '  advisers privacy --matrix --json',
      '  advisers export --all --out backup.json',
      '下一步：advisers help reach',
      '文档：仓库 docs/PRIVACY.md（安装包不含 docs）',
    ],
  },
  reach: {
    title: '可达性',
    summary: '被宿主/编辑器调用：MCP、DSH 插件、bridge 文件网关都是只读面。',
    lines: [
      '主题：可达性（reach）',
      '一句话：软件不做云服务；MCP、DSH 插件与 bridge 网关都是本地只读入口。',
      '命令：',
      '  advisers mcp --stdio',
      '  advisers bridge --dir <BRIDGE_DIR>',
      '  advisers status --json',
      '下一步：advisers help errors',
      '文档：仓库 docs/MCP.md、docs/WINDOWS.md、docs/REACH.md（安装包不含 docs）',
    ],
  },
  errors: {
    title: '排错',
    summary: '先跑 doctor；错误码、审计链与备份都指向可恢复的下一步。',
    lines: [
      '主题：排错（errors）',
      '一句话：先看 doctor 的检查与错误码；每条错误都带下一步命令，别手改数据库。',
      '命令：',
      '  advisers doctor --check-db --json',
      '  advisers audit --json',
      '  advisers backups ls --json',
      '下一步：advisers help start',
      '文档：仓库 docs/ERROR-CODES.md、docs/QUICKSTART.md（安装包不含 docs）',
    ],
  },
})

/** Strip one leading BOM and normalise CRLF (defensive; pages are authored LF). */
function cleanToken(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim()
}

/**
 * Resolve one help-topic token to its canonical id.
 * @param {string} token canonical id or Chinese alias
 * @returns {{id: string, alias: boolean} | null}
 */
export function resolveHelpTopic(token) {
  const value = cleanToken(token)
  if (!value) return null
  if (Object.prototype.hasOwnProperty.call(TOPICS, value)) return { id: value, alias: false }
  if (Object.prototype.hasOwnProperty.call(HELP_TOPIC_ALIASES, value)) return { id: HELP_TOPIC_ALIASES[value], alias: true }
  return null
}

/**
 * Return the canonical lines of one topic (callers append the trailing newline).
 * @param {string} id canonical topic id
 * @returns {string[]}
 */
export function helpTopicLines(id) {
  const topic = TOPICS[id]
  if (!topic) throw new RangeError('unknown help topic: ' + String(id))
  return topic.lines.slice()
}

/**
 * Render one topic page as text (trailing newline included), resolving a
 * Chinese alias to the same canonical bytes as the English id.
 * @param {string} token canonical id or Chinese alias
 * @returns {string | null}
 */
export function renderHelpTopic(token) {
  const resolved = resolveHelpTopic(token)
  if (!resolved) return null
  return helpTopicLines(resolved.id).join('\n') + '\n'
}

/**
 * Topic metadata for `help --list` and the setup "next steps" cards.
 * Aliases are returned in canonical alias-table order.
 * @returns {Array<{id: string, title: string, summary: string, aliases: string[]}>}
 */
export function listHelpTopics() {
  return HELP_TOPIC_IDS.map((id) => ({
    id,
    title: TOPICS[id].title,
    summary: TOPICS[id].summary,
    aliases: Object.keys(HELP_TOPIC_ALIASES).filter((alias) => HELP_TOPIC_ALIASES[alias] === id),
  }))
}

/** Lines for `advisers help --list` (plain text, no ANSI). */
export function helpListLines() {
  const lines = ['advisers help topics（主题 / 中文别名）：']
  for (const topic of listHelpTopics()) {
    lines.push('  ' + topic.id.padEnd(10) + topic.title + '  ' + topic.summary)
  }
  lines.push('用法：advisers help <topic>；advisers help --list；advisers --help 查看全部命令。')
  return lines
}

/**
 * Resolve a `help <args...>` request the way the CLI dispatch needs it.
 *
 * Order (124 §4): a topic / Chinese alias first, then the longest known command
 * path (its 0.4.3 usage line), then unknown.
 *
 * @param {string[]} tokens args after the `help` command (flags included)
 * @returns {{kind: 'topic' | 'usage' | 'unknown', text?: string, topicId?: string}}
 */
export function resolveHelpRequest(tokens) {
  const args = Array.isArray(tokens) ? tokens.filter((token) => typeof token === 'string' && token !== '') : []
  const first = args.find((token) => !token.startsWith('-'))
  if (!first) return { kind: 'unknown' }
  const topic = resolveHelpTopic(first)
  if (topic) return { kind: 'topic', text: renderHelpTopic(topic.id) ?? undefined, topicId: topic.id }
  const commandTokens = args.filter((token) => token !== '--help' && token !== '-h' && !token.startsWith('-'))
  for (let length = Math.min(commandTokens.length, 4); length >= 1; length--) {
    const line = HELP_USAGE_LINES.get(commandTokens.slice(0, length).join(' '))
    if (line) return { kind: 'usage', text: line }
  }
  return { kind: 'unknown' }
}
