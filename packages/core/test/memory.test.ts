import assert from 'node:assert/strict'
import test from 'node:test'
import { Ledger } from '../src/index.ts'

test('authority and scope prevent two live truths and cross-matter collapse', () => {
  const ledger = new Ledger()
  const a = ledger.addMatter({ title: 'A' })
  const b = ledger.addMatter({ title: 'B' })
  const sh = ledger.remember({ matterId: a.id, subject: 'user', predicate: 'city', object: '上海' })
  const inferred = ledger.remember({ matterId: a.id, subject: 'user', predicate: 'city', object: '北京', authority: 'inferred' })
  assert.equal(inferred.status, 'candidate')
  assert.equal(inferred.shadowedBy, sh.id)
  assert.deepEqual(ledger.listFacts(a.id).map((f) => f.object), ['上海'])
  const changed = ledger.remember({ matterId: a.id, subject: 'user', predicate: 'city', object: '北京' })
  assert.equal(changed.status, 'confirmed')
  assert.equal(ledger.listFacts(a.id).length, 1)
  assert.deepEqual(ledger.listFacts(a.id).map((f) => f.object), ['北京'])
  assert.equal(ledger.factHistory(changed.id).length, 2)
  ledger.remember({ matterId: b.id, subject: 'user', predicate: 'city', object: '深圳' })
  assert.deepEqual(ledger.listFacts(b.id).map((f) => f.object), ['深圳'])
})

test('import cannot override a user fact and search only returns current facts', () => {
  const ledger = new Ledger()
  ledger.remember({ subject: 'user', predicate: 'city', object: '上海' })
  const imported = ledger.remember({ subject: 'user', predicate: 'city', object: '北京', authority: 'import' })
  assert.equal(imported.status, 'candidate')
  assert.equal(ledger.listFacts()[0].object, '上海')
  assert.equal(ledger.searchFacts('上海').length, 1)
  assert.equal(ledger.searchFacts('北京').length, 0)
})
