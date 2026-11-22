/**
 * Synthetic data for `advisers demo` (0.5.0 U2b).
 *
 * npm `files` ships only bin/lib/README*, so `examples/` and `docs/` are NOT
 * inside the installed tarball (packages/advisers/package.json). The demo must
 * therefore embed every byte it needs: these frozen JSON documents are written
 * into the demo home under `data/` and consumed by the existing commands
 * (`template quote|proposal|notice`, `receivable add`), never read from the
 * repository.
 *
 * Every value is synthetic: the client, project, company, bank and WeChat
 * account are fictional and marked 示例. There is no URL, no real account
 * number, no customer name and no model/network input. `payment.channels`
 * carries exactly the two non-URL kinds from 0.4.3 schema v2 (a masked bank
 * account and a WeChat display name), so the 7-minute walkthrough exercises
 * quote v2 without a clickable link.
 *
 * Frozen + deep-frozen: a caller cannot mutate the source object and make two
 * demo runs produce different document hashes.
 *
 * @module demo-data
 */

/** Marker file name that identifies a directory as a demo home. */
export const DEMO_MARKER_FILE = '.advisers-demo.json'
/** Marker payload version (read back by --home reuse and --clean). */
export const DEMO_MARKER_VERSION = 1

/** Synthetic customer / project labels (no real person). */
export const DEMO_MATTER_TITLE = '王工（示例）· 官网改版'
export const DEMO_CLIENT_NAME = '王工（示例）'
export const DEMO_CLIENT_COMPANY = '示例科技（合成）'
export const DEMO_ISSUER_NAME = '示例顾问工作室'

/** Quote total and first-payment amounts (CNY strings, 2 decimals). */
export const DEMO_QUOTE_TOTAL = '68000.00'
export const DEMO_FIRST_PAYMENT = '20400.00'

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * Quote data (schema v2): 3 line items = 68,000 CNY, 30% first payment, two
 * masked payment channels. The shape is exactly what bin normalizes for
 * `template quote`; `quoteNo` is fixed so the demo is reproducible.
 */
export const DEMO_QUOTE = deepFreeze({
  schemaVersion: 2,
  quoteNo: 'Q-DEMO-2026-001',
  issuedAt: '2026-11-22',
  validUntil: '2026-12-06',
  currency: 'CNY',
  issuer: { name: DEMO_ISSUER_NAME, contact: '示例顾问' },
  client: { name: DEMO_CLIENT_NAME, company: DEMO_CLIENT_COMPANY },
  project: { name: '官网改版', deliverables: ['信息架构', '视觉稿', '响应式前端'] },
  scope: {
    included: ['需求梳理与信息架构', '视觉稿 2 轮', '响应式前端实现'],
    excluded: ['服务器与域名费用'],
    assumptions: ['客户提供文案与素材'],
  },
  items: [
    { desc: '需求梳理与信息架构', qty: '1', unit: '项', unitPrice: '18000.00' },
    { desc: '视觉稿（2 轮）', qty: '1', unit: '项', unitPrice: '24000.00' },
    { desc: '响应式前端实现', qty: '1', unit: '项', unitPrice: '26000.00' },
  ],
  payment: {
    terms: '首付 30%，验收后 15 日内付清余款',
    milestones: [
      { name: '首付', pct: '30', due: '2026-12-05' },
      { name: '验收', pct: '70' },
    ],
    channels: [
      { kind: 'bank', label: '对公转账', bankName: '示例银行', accountName: DEMO_ISSUER_NAME, accountMasked: '尾号1234' },
      { kind: 'wechat', label: '微信', accountName: '王工（示例）工作室' },
    ],
  },
  signature: { issuerName: '示例顾问', clientName: DEMO_CLIENT_NAME },
})

/** Proposal data: scope.included + deliverables are required by the template. */
export const DEMO_PROPOSAL = deepFreeze({
  schemaVersion: 2,
  quoteNo: 'P-DEMO-2026-001',
  issuedAt: '2026-11-22',
  validUntil: '2026-12-06',
  currency: 'CNY',
  issuer: { name: DEMO_ISSUER_NAME, contact: '示例顾问' },
  client: { name: DEMO_CLIENT_NAME, company: DEMO_CLIENT_COMPANY },
  project: { name: '官网改版', summary: '示例项目：把旧站改版为可维护的响应式官网。', deliverables: ['信息架构', '视觉稿', '响应式前端'] },
  scope: {
    included: ['信息架构', '视觉稿 2 轮', '响应式前端实现'],
    excluded: ['服务器与域名费用'],
    assumptions: ['客户提供文案与素材'],
  },
  payment: { terms: '首付 30%，验收后 15 日内付清余款' },
})

/** Notice data for the legacy `template notice` builder (no --json there). */
export const DEMO_NOTICE = deepFreeze({
  title: '关于「官网改版（示例）」项目启动的通知',
  issuer: DEMO_ISSUER_NAME,
  recipients: [DEMO_CLIENT_NAME],
  body: [
    '本通知全部内容为合成演示数据，不包含任何真实客户信息。',
    '官网改版项目计划于 2026-11-24 启动，首批交付为信息架构与视觉稿。',
  ],
  signer: '示例顾问',
  date: '2026年11月22日',
})

/** Receivable/commitment created in the demo ledger (30% first payment). */
export const DEMO_RECEIVABLE = deepFreeze({
  label: '首款 30%',
  amount: DEMO_FIRST_PAYMENT,
  currency: 'CNY',
  // Due three local days after the run so the exported .ics always contains a
  // VTIMEZONE/VALARM event: reminders only cover a 7-day horizon, and a fixed
  // calendar date would silently produce an empty calendar once it is >7 days
  // away (or be stale once it has passed). Amount/label stay deterministic.
  dueOffsetDays: 3,
})

/** Local (Asia/Shanghai) YYYY-MM-DD for a millisecond instant. */
function shanghaiDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

/**
 * Resolve the demo receivable for one run: fixed label/amount, due = now + 3
 * local days. Deterministic for a given `now` (tests pin the clock).
 * @param {Date|number} [now]
 * @returns {{label: string, amount: string, currency: string, due: string}}
 */
export function demoReceivable(now = new Date()) {
  const ms = now instanceof Date ? now.getTime() : Number(now)
  return {
    label: DEMO_RECEIVABLE.label,
    amount: DEMO_RECEIVABLE.amount,
    currency: DEMO_RECEIVABLE.currency,
    due: shanghaiDay(ms + DEMO_RECEIVABLE.dueOffsetDays * 86400000),
  }
}

/** Relative artifact paths written by the demo (under the demo home/out dir). */
export const DEMO_ARTIFACTS = deepFreeze({
  quote: 'out/quote.docx',
  proposal: 'out/proposal.docx',
  notice: 'out/notice.docx',
  receipt: 'out/receipt',
  calendar: 'out/demo.ics',
})

/**
 * The data files written into the demo home before the steps run.
 * Deterministic (JSON.stringify with two spaces + trailing newline), so two
 * demo runs over the same home produce identical inputs and document hashes.
 * @returns {Array<{path: string, content: string}>}
 */
export function demoDataFiles() {
  return [
    { path: 'data/quote.json', content: JSON.stringify(DEMO_QUOTE, null, 2) + '\n' },
    { path: 'data/proposal.json', content: JSON.stringify(DEMO_PROPOSAL, null, 2) + '\n' },
    { path: 'data/notice.json', content: JSON.stringify(DEMO_NOTICE, null, 2) + '\n' },
  ]
}

/** Marker document written into a demo home (read-only identification). */
export function demoMarker(createdAt = new Date().toISOString()) {
  return {
    kind: 'advisers-demo',
    version: DEMO_MARKER_VERSION,
    synthetic: true,
    createdAt,
    note: '全部数据为合成示例；可随时删除整个目录。',
  }
}
