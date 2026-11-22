import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHANNEL_KINDS,
  MAX_CHANNELS,
  MAX_PAYMENT_URL_LENGTH,
  findFullAccountNumbers,
  findMainlandMobileNumbers,
  isAllowedPaymentUrl,
  normalizePaymentChannels,
  paymentChannelKindLabel,
  paymentChannelRequiredTexts,
  paymentChannelSummary,
} from '../lib/payment-channels.js'

// quote/proposal schema v2 + notice templates share one payment-channel
// validator (0.4.3 spec 93 section 3). Full account numbers never enter a
// generated document: bank masks are enforced and 13-19 digit runs / mainland
// mobile numbers are rejected anywhere a channel identifies an account.

function errorOf(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  assert.fail('expected normalizePaymentChannels to reject the value')
}

function assertRejected(fn, expectedPath, options = {}) {
  const error = errorOf(fn)
  assert.equal(error.code, 'E_TEMPLATE_INVALID')
  assert.equal(error.details.path, expectedPath)
  if (options.kind !== undefined) assert.equal(error.details.kind, options.kind)
  if (options.index !== undefined) assert.equal(error.details.index, options.index)
  return error
}

/* ------------------------------------------------------------------ *
 * Five kinds: the happy path normalizes and never mutates the input.
 * ------------------------------------------------------------------ */

test('normalizePaymentChannels: the five kinds normalize in input order', () => {
  const input = [
    { kind: 'bank', bankName: ' 招商银行 ', accountName: ' 王工 ', accountMasked: '**** **** **** 1234', note: ' 对公 ' },
    { kind: 'wechat', accountName: '王工' },
    { kind: 'alipay', accountMasked: 'w***@example.com', label: '支付宝' },
    { kind: 'stripe_link', url: 'https://buy.stripe.com/test_abc123', label: 'Stripe' },
    { kind: 'wise_link', url: 'https://wise.com/pay/me/wang', note: 'Wise' },
  ]
  const channels = normalizePaymentChannels(input)
  assert.deepEqual(channels, [
    { kind: 'bank', accountName: '王工', bankName: '招商银行', accountMasked: '**** **** **** 1234', note: '对公' },
    { kind: 'wechat', accountName: '王工' },
    { kind: 'alipay', label: '支付宝', accountMasked: 'w***@example.com' },
    { kind: 'stripe_link', label: 'Stripe', url: 'https://buy.stripe.com/test_abc123' },
    { kind: 'wise_link', url: 'https://wise.com/pay/me/wang', note: 'Wise' },
  ])
  // deepEqual above is order-insensitive on keys; the object literal built by
  // the normalizer always emits kind first, then the spec field order.
  assert.deepEqual(Object.keys(channels[0]), ['kind', 'accountName', 'bankName', 'accountMasked', 'note'])
  assert.deepEqual(Object.keys(channels[3]), ['kind', 'label', 'url'])
  assert.deepEqual(CHANNEL_KINDS, ['bank', 'wechat', 'alipay', 'stripe_link', 'wise_link'])
})

test('normalizePaymentChannels: missing value means no channels', () => {
  assert.deepEqual(normalizePaymentChannels(undefined), [])
  assert.deepEqual(normalizePaymentChannels(null), [])
  assert.deepEqual(normalizePaymentChannels([]), [])
})

test('normalizePaymentChannels: deterministic and does not mutate the input', () => {
  const input = Object.freeze([
    Object.freeze({ kind: 'bank', accountMasked: '尾号1234' }),
    Object.freeze({ kind: 'wechat', accountName: ' 王工 ' }),
  ])
  const first = normalizePaymentChannels(input)
  const second = normalizePaymentChannels(input)
  assert.deepEqual(first, second)
  assert.equal(input[0].accountMasked, '尾号1234')
  assert.equal(input[1].accountName, ' 王工 ')
})

test('normalizePaymentChannels: bank accepts *, bullet and 尾号 masks', () => {
  for (const accountMasked of ['**** 1234', '•••• 5678', '尾号 1234', '尾号1234', '**** **** **** 1234']) {
    const [channel] = normalizePaymentChannels([{ kind: 'bank', accountMasked }])
    assert.equal(channel.accountMasked, accountMasked)
  }
})

test('normalizePaymentChannels: wechat/alipay accept a display name or a masked id', () => {
  assert.deepEqual(normalizePaymentChannels([{ kind: 'wechat', accountName: '王工' }]), [{ kind: 'wechat', accountName: '王工' }])
  assert.deepEqual(normalizePaymentChannels([{ kind: 'alipay', accountMasked: '王工***' }]), [{ kind: 'alipay', accountMasked: '王工***' }])
  // A phone-shaped account is fine only when masked down to 4 digits.
  assert.deepEqual(normalizePaymentChannels([{ kind: 'alipay', accountMasked: '138****8000' }]), [{ kind: 'alipay', accountMasked: '138****8000' }])
})

test('normalizePaymentChannels: links accept provider domains and subdomains', () => {
  for (const url of ['https://stripe.com/pay/x', 'https://buy.stripe.com/test_1', 'https://pay.stripe.com/x', 'https://wise.com/pay/me/x', 'https://wise.com/pay/x?y=1']) {
    const kind = url.includes('stripe') ? 'stripe_link' : 'wise_link'
    assert.deepEqual(normalizePaymentChannels([{ kind, url }]), [{ kind, url }])
  }
})

test('normalizePaymentChannels: the channel cap is 8', () => {
  assert.equal(MAX_CHANNELS, 8)
  const eight = Array.from({ length: MAX_CHANNELS }, () => ({ kind: 'wechat', accountName: '王工' }))
  assert.equal(normalizePaymentChannels(eight).length, 8)
  assertRejected(() => normalizePaymentChannels([...eight, { kind: 'wechat', accountName: '王工' }]), 'payment.channels')
})

/* ------------------------------------------------------------------ *
 * Renderer / verify helpers.
 * ------------------------------------------------------------------ */

test('paymentChannel helper labels and summaries', () => {
  assert.equal(paymentChannelKindLabel('bank'), '银行转账')
  assert.equal(paymentChannelKindLabel('stripe_link'), 'Stripe 付款链接')
  assert.equal(paymentChannelKindLabel('wechat'), '微信')
  assert.equal(paymentChannelKindLabel('nope'), 'nope')

  assert.equal(paymentChannelSummary({ kind: 'bank', bankName: '招商银行', accountName: '王工', accountMasked: '尾号1234' }), '招商银行 王工 尾号1234')
  assert.equal(paymentChannelSummary({ kind: 'bank', accountMasked: '**** 1234' }), '**** 1234')
  assert.equal(paymentChannelSummary({ kind: 'wechat', accountName: '王工' }), '王工')
  assert.equal(paymentChannelSummary({ kind: 'alipay', accountName: '王工', accountMasked: 'w***' }), '王工 w***')
  assert.equal(paymentChannelSummary({ kind: 'stripe_link', url: 'https://buy.stripe.com/x' }), 'https://buy.stripe.com/x')
  assert.equal(paymentChannelSummary(null), '')

  assert.deepEqual(paymentChannelRequiredTexts({ kind: 'bank', accountMasked: '尾号1234' }), ['尾号1234'])
  assert.deepEqual(paymentChannelRequiredTexts({ kind: 'wechat', accountName: '王工' }), ['王工'])
  assert.deepEqual(paymentChannelRequiredTexts({ kind: 'wechat', accountName: '王工', accountMasked: 'w***' }), ['w***'])
  assert.deepEqual(paymentChannelRequiredTexts({ kind: 'wise_link', url: 'https://wise.com/x' }), ['https://wise.com/x'])
})

test('isAllowedPaymentUrl: shape-only check used by verify --content', () => {
  assert.equal(isAllowedPaymentUrl('stripe_link', 'https://buy.stripe.com/test_1'), true)
  assert.equal(isAllowedPaymentUrl('wise_link', 'https://wise.com/pay/me/x'), true)
  assert.equal(isAllowedPaymentUrl('stripe_link', 'http://stripe.com/x'), false)
  assert.equal(isAllowedPaymentUrl('stripe_link', 'https://evil.com/stripe.com'), false)
  assert.equal(isAllowedPaymentUrl('stripe_link', 'https://stripe.com.evil.com/x'), false)
  assert.equal(isAllowedPaymentUrl('wise_link', 'https://stripe.com/x'), false)
  assert.equal(isAllowedPaymentUrl('stripe_link', 'https://user:pass@stripe.com/x'), false)
  assert.equal(isAllowedPaymentUrl('stripe_link', 'https://stripe.com/' + 'a'.repeat(MAX_PAYMENT_URL_LENGTH)), false)
  assert.equal(isAllowedPaymentUrl('stripe_link', 'javascript:alert(1)'), false)
  assert.equal(isAllowedPaymentUrl('stripe_link', ''), false)
  assert.equal(isAllowedPaymentUrl('stripe_link', null), false)
})

/* ------------------------------------------------------------------ *
 * Full-account / mobile digit scans.
 * ------------------------------------------------------------------ */

test('findFullAccountNumbers: 13-19 digit runs, literal vs separator-tolerant', () => {
  assert.deepEqual(findFullAccountNumbers('6222020202020202'), ['6222020202020202'])
  assert.deepEqual(findFullAccountNumbers('尾号1234'), [])
  assert.deepEqual(findFullAccountNumbers('**** **** **** 1234'), [])
  // Separators are ignored for the account field defense-in-depth reading.
  assert.deepEqual(findFullAccountNumbers('6222 0202 0202 0202 020', { allowSeparators: true }), ['6222020202020202020'])
  assert.deepEqual(findFullAccountNumbers('6222 0202 0202 0202 020'), [])
  assert.deepEqual(findFullAccountNumbers('2026-11-22'), [])
  assert.deepEqual(findFullAccountNumbers(undefined), [])
})

test('findMainlandMobileNumbers: 11 digits starting 1[3-9]', () => {
  assert.deepEqual(findMainlandMobileNumbers('13800138000'), ['13800138000'])
  assert.deepEqual(findMainlandMobileNumbers('138 0013 8000', { allowSeparators: true }), ['13800138000'])
  assert.deepEqual(findMainlandMobileNumbers('138 0013 8000'), [])
  assert.deepEqual(findMainlandMobileNumbers('138****8000'), [])
  assert.deepEqual(findMainlandMobileNumbers('238001380001'), [])
  assert.deepEqual(findMainlandMobileNumbers('订单 2026 11 22'), [])
})

/* ------------------------------------------------------------------ *
 * Negative cases: shape, fields and the privacy rules.
 * ------------------------------------------------------------------ */

test('normalizePaymentChannels rejects malformed container shapes', () => {
  assertRejected(() => normalizePaymentChannels({ kind: 'bank' }), 'payment.channels')
  assertRejected(() => normalizePaymentChannels([null]), 'payment.channels[0]')
  assertRejected(() => normalizePaymentChannels([[]]), 'payment.channels[0]')
  assertRejected(() => normalizePaymentChannels(['bank']), 'payment.channels[0]')
  assertRejected(() => normalizePaymentChannels([{}]), 'payment.channels[0].kind')
  assertRejected(() => normalizePaymentChannels([{ kind: 'paypal' }]), 'payment.channels[0].kind', { index: 0 })
  assertRejected(() => normalizePaymentChannels([{ kind: 1, accountMasked: '尾号1234' }]), 'payment.channels[0].kind', { index: 0 })
})

test('normalizePaymentChannels rejects unknown fields per kind', () => {
  assertRejected(
    () => normalizePaymentChannels([{ kind: 'bank', accountMasked: '尾号1234', iban: 'x' }]),
    'payment.channels[0].iban',
    { index: 0, kind: 'bank' },
  )
  assertRejected(
    () => normalizePaymentChannels([{ kind: 'stripe_link', url: 'https://stripe.com/x', accountMasked: '尾号1234' }]),
    'payment.channels[0].accountMasked',
    { index: 0, kind: 'stripe_link' },
  )
  assertRejected(
    () => normalizePaymentChannels([{ kind: 'wechat', accountName: '王工', url: 'https://stripe.com/x' }]),
    'payment.channels[0].url',
    { index: 0, kind: 'wechat' },
  )
  assertRejected(
    () => normalizePaymentChannels([{ kind: 'bank', accountMasked: '尾号1234', url: 'https://stripe.com/x' }]),
    'payment.channels[0].url',
    { index: 0, kind: 'bank' },
  )
})

test('normalizePaymentChannels rejects a bank account without a mask or with a full number', () => {
  assertRejected(
    () => normalizePaymentChannels([{ kind: 'bank', bankName: '招商银行' }]),
    'payment.channels[0].accountMasked',
    { index: 0, kind: 'bank' },
  )
  assertRejected(
    () => normalizePaymentChannels([{ kind: 'bank', accountMasked: '6222020202020202' }]),
    'payment.channels[0].accountMasked',
    { index: 0, kind: 'bank' },
  )
  assertRejected(
    () => normalizePaymentChannels([{ kind: 'bank', accountMasked: '**** **** **** 6222020202020202' }]),
    'payment.channels[0].accountMasked',
    { index: 0, kind: 'bank' },
  )
  assertRejected(
    () => normalizePaymentChannels([{ kind: 'bank', accountMasked: '6222 0202 0202 0202 020' }]),
    'payment.channels[0].accountMasked',
    { index: 0, kind: 'bank' },
  )
})

test('normalizePaymentChannels rejects full mobile numbers in wechat/alipay identity fields', () => {
  assertRejected(
    () => normalizePaymentChannels([{ kind: 'wechat', accountMasked: '13800138000' }]),
    'payment.channels[0].accountMasked',
    { index: 0, kind: 'wechat' },
  )
  assertRejected(
    () => normalizePaymentChannels([{ kind: 'alipay', accountName: '138 0013 8000' }]),
    'payment.channels[0].accountName',
    { index: 0, kind: 'alipay' },
  )
  assertRejected(
    () => normalizePaymentChannels([{ kind: 'wechat', accountName: '王工' }, { kind: 'alipay', accountMasked: '19900138000' }]),
    'payment.channels[1].accountMasked',
    { index: 1, kind: 'alipay' },
  )
})

test('normalizePaymentChannels rejects a wechat/alipay channel with no account info', () => {
  assertRejected(() => normalizePaymentChannels([{ kind: 'wechat', label: '微信' }]), 'payment.channels[0]', { index: 0, kind: 'wechat' })
  assertRejected(() => normalizePaymentChannels([{ kind: 'alipay', note: '扫码' }]), 'payment.channels[0]', { index: 0, kind: 'alipay' })
})

test('normalizePaymentChannels rejects a link without a valid https provider url', () => {
  const bad = [
    [undefined, 'payment.channels[0].url'],
    ['http://stripe.com/x', 'payment.channels[0].url'],
    ['https://evil.com/stripe.com', 'payment.channels[0].url'],
    ['https://stripe.com.evil.com/x', 'payment.channels[0].url'],
    ['https://notstripe.com/x', 'payment.channels[0].url'],
    ['https://user:pass@stripe.com/x', 'payment.channels[0].url'],
    ['https://stripe.com/a b', 'payment.channels[0].url'],
    ['https://stripe.com\\@evil.example/x', 'payment.channels[0].url'],
    ['https://stripe.com/a\nb', 'payment.channels[0].url'],
    ['https://stripe.com/' + 'a'.repeat(MAX_PAYMENT_URL_LENGTH), 'payment.channels[0].url'],
    [42, 'payment.channels[0].url'],
  ]
  for (const [url, path] of bad) {
    const error = assertRejected(() => normalizePaymentChannels([{ kind: 'stripe_link', url }]), path, { index: 0, kind: 'stripe_link' })
    assert.ok(typeof error.message === 'string' && error.message.length > 0)
  }
  assertRejected(
    () => normalizePaymentChannels([{ kind: 'wise_link', url: 'https://stripe.com/x' }]),
    'payment.channels[0].url',
    { index: 0, kind: 'wise_link' },
  )
})

test('normalizePaymentChannels rejects control characters and over-long fields', () => {
  assertRejected(() => normalizePaymentChannels([{ kind: 'wechat', accountName: '王\u0000工' }]), 'payment.channels[0].accountName')
  assertRejected(() => normalizePaymentChannels([{ kind: 'wechat', accountName: '王工\n微信' }]), 'payment.channels[0].accountName')
  assertRejected(() => normalizePaymentChannels([{ kind: 'wechat', accountName: '王工\t微信' }]), 'payment.channels[0].accountName')
  assertRejected(() => normalizePaymentChannels([{ kind: 'wechat', accountName: 'x'.repeat(101) }]), 'payment.channels[0].accountName')
  assertRejected(() => normalizePaymentChannels([{ kind: 'wechat', accountName: '王工', label: 'x'.repeat(41) }]), 'payment.channels[0].label')
  assertRejected(() => normalizePaymentChannels([{ kind: 'wechat', accountName: '王工', note: 'x'.repeat(201) }]), 'payment.channels[0].note')
  assertRejected(() => normalizePaymentChannels([{ kind: 'wechat', accountName: 123 }]), 'payment.channels[0].accountName')
})
