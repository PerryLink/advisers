/**
 * Payment channels for quote/proposal schema v2 and notice templates
 * (0.4.3; implementation spec 93 sections 3 and 4).
 *
 * A payment channel is display metadata on a generated document: it tells the
 * client how to pay. This module never creates, validates or fetches a payment
 * link, never contacts a provider, never moves money, never reads or writes a
 * file and has no dependency outside the JavaScript language itself. Links stay
 * plain text in the document; the module only checks their shape.
 *
 * Rules (93:49-51):
 *  - at most MAX_CHANNELS entries; kind is one of CHANNEL_KINDS;
 *  - bank: accountMasked is required and must be masked (`*`, `•` or
 *    尾号NNNN), optional bankName/accountName, url is rejected;
 *  - wechat/alipay: a display name (accountName) or a masked id
 *    (accountMasked), url is rejected;
 *  - stripe_link/wise_link: url is required, https only, host confined to the
 *    provider domain (plus its subdomains), at most 512 characters, no
 *    userinfo, and account fields are rejected;
 *  - every field is a trimmed single line with no control characters and a
 *    per-field length cap; unknown fields are rejected (a typo must not
 *    silently produce a document that ignores user data);
 *  - full-account zero tolerance: 13-19 consecutive digits in an
 *    accountMasked/accountName are rejected, and a mainland mobile number
 *    (11 digits starting 1[3-9]) is rejected in those identity fields. Masked
 *    values such as "****1234", "尾号1234" and "138****8000" are accepted.
 *
 * Errors use the CLI template-data code E_TEMPLATE_INVALID with
 * `details.path` pointing at `payment.channels[i].<field>` and `details.kind`
 * naming the channel kind, so a renderer or `verify --content` can re-check.
 *
 * @module payment-channels
 */

/** Kinds accepted in a v2 `payment.channels[]` entry. */
export const CHANNEL_KINDS = Object.freeze(['bank', 'wechat', 'alipay', 'stripe_link', 'wise_link'])

/** Hard cap on the number of channels one quote/notice may carry. */
export const MAX_CHANNELS = 8

/** Hard cap on a payment link, in characters. */
export const MAX_PAYMENT_URL_LENGTH = 512

/** Provider domain per link kind; a host equals it or ends with `.` + it. */
export const PAYMENT_URL_DOMAINS = Object.freeze({ stripe_link: 'stripe.com', wise_link: 'wise.com' })

/** Chinese display names for the "payment method" column. */
export const CHANNEL_KIND_LABELS = Object.freeze({
  bank: '银行转账',
  wechat: '微信',
  alipay: '支付宝',
  stripe_link: 'Stripe 付款链接',
  wise_link: 'Wise 付款链接',
})

const FIELD_LIMITS = Object.freeze({ label: 40, accountName: 100, bankName: 100, accountMasked: 64, url: MAX_PAYMENT_URL_LENGTH, note: 200 })
/** Fields a channel may carry besides `kind`, by kind. `url` is link-only. */
const KIND_FIELDS = Object.freeze({
  bank: Object.freeze(['label', 'accountName', 'bankName', 'accountMasked', 'note']),
  wechat: Object.freeze(['label', 'accountName', 'accountMasked', 'note']),
  alipay: Object.freeze(['label', 'accountName', 'accountMasked', 'note']),
  stripe_link: Object.freeze(['label', 'url', 'note']),
  wise_link: Object.freeze(['label', 'url', 'note']),
})

// C0/C1 controls plus the Unicode line/paragraph separators: every field must
// stay on one line (a CRLF here would forge extra document rows/headers).
const CONTROL_OR_LINE_BREAK = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/
// Separators tolerated between digit groups for the full-account / mobile scan.
const DIGIT_SEPARATORS = /[ \t\u00A0\u2010-\u2015-]/g
const ACCOUNT_MASK = /[*\u2022]|\u5c3e\u53f7\s*\d{2,6}/

function paymentChannelError(message, path, extra) {
  const error = new Error(message)
  error.code = 'E_TEMPLATE_INVALID'
  error.details = { path: path, ...(extra ?? {}) }
  return error
}

function isPlainChannel(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function textValue(value, path, field, { required = false, extra } = {}) {
  if (value === undefined || value === null) {
    if (required) throw paymentChannelError(path + ' is required', path, extra)
    return undefined
  }
  if (typeof value !== 'string') throw paymentChannelError(path + ' must be a string', path, extra)
  const text = value.trim()
  if (!text) {
    if (required) throw paymentChannelError(path + ' is required', path, extra)
    return undefined
  }
  if (CONTROL_OR_LINE_BREAK.test(text)) throw paymentChannelError(path + ' must be a single line without control characters', path, extra)
  const length = Array.from(text).length
  if (length > FIELD_LIMITS[field]) throw paymentChannelError(path + ' is longer than ' + FIELD_LIMITS[field] + ' characters', path, extra)
  return text
}

/** Digits of `text` with tolerated separators removed when allowSeparators. */
function digitRuns(text, pattern) {
  const out = []
  for (const match of String(text).matchAll(pattern)) out.push(match[0])
  return out
}

/**
 * Find unbroken runs of 13-19 digits (a full bank account number shape).
 *
 * With `allowSeparators: true` spaces, non-breaking spaces and hyphen variants
 * between digit groups are ignored, so "6222 0202 0202 0202 020" is caught
 * too; the default is the literal consecutive-digit reading used for
 * document-text checks.
 *
 * @param {unknown} text
 * @param {{allowSeparators?: boolean}} [options]
 * @returns {string[]} matched digit runs, in order
 */
export function findFullAccountNumbers(text, options = {}) {
  if (text === undefined || text === null) return []
  const source = options.allowSeparators ? String(text).replace(DIGIT_SEPARATORS, '') : String(text)
  return digitRuns(source, /\d{13,19}/g)
}

/**
 * Find mainland mobile numbers (11 digits starting 1[3-9]), optionally with
 * tolerated separators between digit groups.
 *
 * @param {unknown} text
 * @param {{allowSeparators?: boolean}} [options]
 * @returns {string[]} matched 11-digit numbers, in order
 */
export function findMainlandMobileNumbers(text, options = {}) {
  if (text === undefined || text === null) return []
  const source = options.allowSeparators ? String(text).replace(DIGIT_SEPARATORS, '') : String(text)
  return digitRuns(source, /(?<!\d)1[3-9]\d{9}(?!\d)/g)
}

/** Problem with a payment link, or null when the url shape is acceptable. */
function paymentUrlProblem(kind, text) {
  const domain = PAYMENT_URL_DOMAINS[kind]
  if (!domain) return 'unsupported payment link kind: ' + String(kind)
  const length = Array.from(text).length
  if (length === 0) return 'url is required'
  if (length > MAX_PAYMENT_URL_LENGTH) return 'url is longer than ' + MAX_PAYMENT_URL_LENGTH + ' characters'
  if (/[\s\\\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(text)) return 'url must be a single line without whitespace, backslashes or control characters'
  let parsed = null
  try { parsed = new URL(text) } catch { return 'url must be an absolute https URL' }
  if (parsed.protocol !== 'https:') return 'url must use https://'
  if (parsed.username || parsed.password) return 'url must not contain userinfo (user:pass@)'
  const host = parsed.hostname.toLowerCase()
  if (!(host === domain || host.endsWith('.' + domain))) return 'url host must be ' + domain + ' or a subdomain of it'
  return null
}

/**
 * True when `url` is an acceptable payment link for `kind`: https, provider
 * domain/subdomain, <=512 chars, single line, no userinfo. Never fetches it.
 *
 * @param {string} kind
 * @param {unknown} url
 * @returns {boolean}
 */
export function isAllowedPaymentUrl(kind, url) {
  if (typeof url !== 'string') return false
  const text = url.trim()
  if (!text) return false
  return paymentUrlProblem(kind, text) === null
}

function normalizePaymentUrl(kind, value, path, extra) {
  const text = textValue(value, path, 'url', { required: true, extra })
  const problem = paymentUrlProblem(kind, text)
  if (problem) throw paymentChannelError(problem, path, extra)
  return text
}

function assertMaskedIdentity(text, path, kind, index) {
  if (findFullAccountNumbers(text, { allowSeparators: true }).length) {
    throw paymentChannelError(path + ' looks like a full account number (13-19 digits); keep only a mask such as ****1234 or 尾号1234', path, { index, kind })
  }
  if (findMainlandMobileNumbers(text, { allowSeparators: true }).length) {
    throw paymentChannelError(path + ' looks like a full mainland mobile number; use a display name or a masked id such as 138****8000', path, { index, kind })
  }
}

function normalizeChannel(raw, index, basePath) {
  const path = basePath + '[' + index + ']'
  if (!isPlainChannel(raw)) throw paymentChannelError(path + ' must be an object', path)
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
  if (!CHANNEL_KINDS.includes(kind)) {
    throw paymentChannelError(path + '.kind must be one of ' + CHANNEL_KINDS.join('|'), path + '.kind', { index })
  }
  const extra = { index, kind }
  const allowed = new Set(['kind', ...KIND_FIELDS[kind]])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw paymentChannelError(path + '.' + key + ' is not allowed for kind ' + kind, path + '.' + key, extra)
  }
  const fields = {}
  for (const field of ['label', 'accountName', 'bankName', 'accountMasked', 'note']) {
    if (!KIND_FIELDS[kind].includes(field)) continue
    const text = textValue(raw[field], path + '.' + field, field, { extra })
    if (text !== undefined) fields[field] = text
  }
  if (kind === 'bank') {
    if (!fields.accountMasked) throw paymentChannelError(path + '.accountMasked is required for kind bank', path + '.accountMasked', extra)
    if (!ACCOUNT_MASK.test(fields.accountMasked)) {
      throw paymentChannelError(path + '.accountMasked must be masked (use *, • or 尾号NNNN)', path + '.accountMasked', extra)
    }
    for (const field of ['accountMasked', 'accountName']) {
      if (fields[field]) assertMaskedIdentity(fields[field], path + '.' + field, kind, index)
    }
  } else if (kind === 'wechat' || kind === 'alipay') {
    if (!fields.accountMasked && !fields.accountName) {
      throw paymentChannelError(path + ' needs accountName or accountMasked for kind ' + kind, path, extra)
    }
    for (const field of ['accountMasked', 'accountName']) {
      if (fields[field]) assertMaskedIdentity(fields[field], path + '.' + field, kind, index)
    }
  } else {
    fields.url = normalizePaymentUrl(kind, raw.url, path + '.url', extra)
  }
  const channel = { kind }
  for (const field of ['label', 'accountName', 'bankName', 'accountMasked', 'url', 'note']) {
    if (fields[field] !== undefined) channel[field] = fields[field]
  }
  return channel
}

/**
 * Validate and normalize one `payment.channels` value.
 *
 * Pure and deterministic: same input -> same output, input is never mutated.
 * A missing value (undefined/null) means "no channels" and returns []. Any
 * invalid entry throws E_TEMPLATE_INVALID and nothing is partially returned.
 *
 * @param {unknown} value raw `payment.channels` array
 * @param {{path?: string}} [options] error path prefix (default payment.channels)
 * @returns {object[]} normalized channels, input order preserved
 */
export function normalizePaymentChannels(value, options = {}) {
  const basePath = options.path ?? 'payment.channels'
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw paymentChannelError(basePath + ' must be an array', basePath)
  if (value.length > MAX_CHANNELS) throw paymentChannelError(basePath + ' has more than ' + MAX_CHANNELS + ' items', basePath)
  return value.map((entry, index) => normalizeChannel(entry, index, basePath))
}

/** Chinese display label for a channel kind (falls back to the kind itself). */
export function paymentChannelKindLabel(kind) {
  return CHANNEL_KIND_LABELS[kind] ?? String(kind ?? '')
}

/**
 * One-line "payment to" summary for the renderer: bank name / holder / mask,
 * display name + masked id, or the link url. Users see exactly these text
 * fragments; `verify --content` can require them to be present.
 *
 * @param {object} channel normalized channel
 * @returns {string}
 */
export function paymentChannelSummary(channel) {
  if (!isPlainChannel(channel)) return ''
  if (channel.kind === 'bank') {
    return [channel.bankName, channel.accountName, channel.accountMasked].filter(Boolean).join(' ')
  }
  if (channel.kind === 'wechat' || channel.kind === 'alipay') {
    return [channel.accountName, channel.accountMasked].filter(Boolean).join(' ')
  }
  return typeof channel.url === 'string' ? channel.url : ''
}

/**
 * Text fragments the generated document must contain for this channel
 * (blocker `quote.payment_channels`): the mask for bank/wechat/alipay and the
 * url for links.
 *
 * @param {object} channel normalized channel
 * @returns {string[]} non-empty fragments, document order
 */
export function paymentChannelRequiredTexts(channel) {
  if (!isPlainChannel(channel)) return []
  if (channel.kind === 'bank') return channel.accountMasked ? [channel.accountMasked] : []
  if (channel.kind === 'wechat' || channel.kind === 'alipay') {
    return channel.accountMasked ? [channel.accountMasked] : channel.accountName ? [channel.accountName] : []
  }
  return typeof channel.url === 'string' && channel.url ? [channel.url] : []
}

export default Object.freeze({
  CHANNEL_KINDS,
  MAX_CHANNELS,
  MAX_PAYMENT_URL_LENGTH,
  PAYMENT_URL_DOMAINS,
  CHANNEL_KIND_LABELS,
  normalizePaymentChannels,
  isAllowedPaymentUrl,
  paymentChannelKindLabel,
  paymentChannelSummary,
  paymentChannelRequiredTexts,
  findFullAccountNumbers,
  findMainlandMobileNumbers,
})
