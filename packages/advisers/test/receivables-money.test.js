import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CURRENCIES,
  MAX_AMOUNT_MINOR,
  RECEIVABLE_KINDS,
  PAYMENT_METHODS,
  formatMinorAmount,
  parseAmountToMinor,
  parseCurrency,
  receivableDueInstant,
} from '../lib/receivables.js'

// Money sidecar (0.4.0, schema v22): decimal-string parsing, integer minor
// units, the four fixed currencies and the due-date instant rules. No store is
// opened here; every function is pure.

const DAY_MS = 86_400_000
const SHANGHAI_OFFSET_MS = 8 * 3600_000

test('parseAmountToMinor accepts plain decimals, pads one decimal and keeps integer precision', () => {
  assert.equal(parseAmountToMinor('8000'), 800000n)
  assert.equal(parseAmountToMinor('8000.00'), 800000n)
  assert.equal(parseAmountToMinor('8000.5'), 800050n)
  assert.equal(parseAmountToMinor('0.01'), 1n)
  assert.equal(parseAmountToMinor(' 1.05 '), 105n)
  assert.equal(parseAmountToMinor(12345n), 12345n)
  assert.equal(formatMinorAmount(800000n), '8000.00')
  assert.equal(formatMinorAmount(1n), '0.01')
  assert.equal(formatMinorAmount(123450789n), '1234507.89')
  assert.equal(formatMinorAmount(0n), '0.00')
  assert.equal(formatMinorAmount(-150n), '-1.50')
  assert.equal(formatMinorAmount(800000), '8000.00')
})

test('parseAmountToMinor rejects signs, commas, exponents, too many decimals, zero and the 1e12 cap', () => {
  for (const bad of ['-1', '+1', '1,000', '1e3', '1.001', '0', '0.00', '.5', '5.', '', '   ', 'CNY 5', 'NaN']) {
    assert.throws(() => parseAmountToMinor(bad), /E_RECEIVABLE_INVALID/, 'should reject ' + JSON.stringify(bad))
  }
  assert.throws(() => parseAmountToMinor(0n), /greater than 0/)
  assert.throws(() => parseAmountToMinor(-5n), /greater than 0/)
  assert.throws(() => parseAmountToMinor(42), /decimal string/)
  assert.equal(MAX_AMOUNT_MINOR, 1_000_000_000_000n)
  assert.equal(parseAmountToMinor('10000000000.00'), MAX_AMOUNT_MINOR)
  assert.throws(() => parseAmountToMinor('10000000000.01'), /out of range/)
  assert.throws(() => parseAmountToMinor('9999999999999999'), /out of range/)
  // A different error code can be requested by a caller (payment = E_PAYMENT_INVALID).
  assert.throws(() => parseAmountToMinor('bad', { code: 'E_PAYMENT_INVALID' }), /E_PAYMENT_INVALID/)
  assert.throws(() => parseAmountToMinor('bad', { field: 'payment amount' }), /payment amount/)
})

test('currencies are exactly CNY/USD/EUR/HKD (uppercased, invalid rejected)', () => {
  assert.deepEqual([...CURRENCIES], ['CNY', 'USD', 'EUR', 'HKD'])
  assert.deepEqual([...RECEIVABLE_KINDS], ['quote', 'milestone', 'retainer', 'other'])
  assert.deepEqual([...PAYMENT_METHODS], ['bank', 'wechat', 'alipay', 'cash', 'other'])
  assert.equal(parseCurrency(undefined), 'CNY')
  assert.equal(parseCurrency(''), 'CNY')
  assert.equal(parseCurrency(' cny '), 'CNY')
  assert.equal(parseCurrency('hkd'), 'HKD')
  assert.throws(() => parseCurrency('JPY'), /E_RECEIVABLE_INVALID/)
  assert.throws(() => parseCurrency('BTC'), /one of CNY, USD, EUR, HKD/)
  assert.throws(() => parseCurrency('JPY', { code: 'E_PAYMENT_INVALID' }), /E_PAYMENT_INVALID/)
})

test('receivableDueInstant: date-only is end of the Shanghai day, local time is +08:00, absolute instants pass through', () => {
  // 2026-11-21 23:59:59.999 Asia/Shanghai == 2026-11-21T15:59:59.999Z
  assert.equal(receivableDueInstant('2026-11-21'), Date.parse('2026-11-21T15:59:59.999Z'))
  assert.equal(receivableDueInstant('2026-11-21T10:30'), Date.parse('2026-11-21T10:30:00+08:00'))
  assert.equal(receivableDueInstant('2026-11-21 10:30:15'), Date.parse('2026-11-21T10:30:15+08:00'))
  assert.equal(receivableDueInstant('2026-11-21T02:30:15.500Z'), Date.parse('2026-11-21T02:30:15.500Z'))
  assert.equal(receivableDueInstant('2026-11-21T10:30:00+08:00'), Date.parse('2026-11-21T02:30:00Z'))
  assert.equal(receivableDueInstant(undefined), null)
  assert.equal(receivableDueInstant(''), null)
  assert.equal(receivableDueInstant('not-a-date'), null)
  assert.equal(receivableDueInstant('2026-13-01'), null)
  // A date-only due date compares as the end of the day, so 10:00 the same day is not overdue yet.
  const due = receivableDueInstant('2026-11-21')
  const sameMorning = Date.parse('2026-11-21T02:00:00Z')
  assert.ok(due > sameMorning)
  assert.ok(due - sameMorning < DAY_MS)
  assert.equal(due, Date.UTC(2026, 10, 21) - SHANGHAI_OFFSET_MS + DAY_MS - 1)
})
