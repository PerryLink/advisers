import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { deriveClientTimeline, summarizeClientCounts, TIMELINE_DEGRADED } from '../../core/dist/index.js'
import {
  DATA_TABLES,
  SCHEMA_VERSION,
  SqliteStore,
  normalizeClientName,
  openReadStore,
} from '../lib/sqlite.js'

// 0.3.0 schema v21: customer/provider entities (clients, projects,
// client_notes), matter ownership and delivery lineage — store CRUD, the
// derived timeline sources and the export data shape.

const NOW = '2026-11-01T00:00:00.000Z'
const SHA = 'ab'.repeat(32)

function setup(prefix = 'advisers-client-entities-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, db: join(root, 'state.db') }
}

function seedMatter(store, id, extra = {}) {
  store.mutate(() => store.insertMatter({
    id, title: id, status: 'active', domain: 'general', secrecy: 0,
    participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW, ...extra,
  }))
}

function seedCommitment(store, row) {
  store.mutate(() => store.insertCommitment({
    timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none', ...row,
  }))
}

test('fresh v21 database exposes the customer tables, ownership columns and partial unique indexes', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      assert.equal(SCHEMA_VERSION, 21)
      assert.equal(store.getMeta('schema_version'), '21')
      const tables = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
      for (const table of ['clients', 'projects', 'client_notes']) assert.ok(tables.has(table), 'missing table ' + table)
      const columns = (table) => store.db.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name)
      assert.ok(columns('clients').includes('name_norm'), 'the duplicate key is stored')
      for (const column of ['client_id', 'project_id']) assert.ok(columns('matters').includes(column))
      for (const column of ['client_id', 'project_id', 'template_name', 'template_version', 'quote_no', 'data_sha256']) {
        assert.ok(columns('deliveries').includes(column))
      }
      const partials = store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name IN ('idx_clients_name_norm_active','idx_projects_client_name_active')").all().map((row) => row.sql)
      assert.equal(partials.length, 2)
      for (const sql of partials) assert.match(sql, /WHERE status = 'active' AND deleted_at IS NULL/)
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('normalizeClientName folds compatibility forms, zero-width chars, whitespace and Latin case', () => {
  assert.equal(normalizeClientName('  Ａ\u200B  B\t C  '), 'a b c')
  assert.equal(normalizeClientName('王工'), '王工', 'CJK is unchanged')
  assert.equal(normalizeClientName('ACME'), normalizeClientName('ａｃｍｅ'))
  assert.equal(normalizeClientName('王 工'), '王 工')
  assert.throws(() => normalizeClientName(42), /name must be a string/)
})

test('client CRUD: add/get/find/list/rename/alias/archive/restore with stable E_* codes', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      const wang = store.addClient({ name: ' 王工 ', aliases: ['王总'], tags: ['报价'], secrecyDefault: 1, notes: '老客户' })
      assert.match(wang.id, /^cl_[0-9a-f]+$/)
      assert.equal(wang.name, '王工')
      assert.equal(wang.nameNorm, '王工')
      assert.deepEqual(wang.aliases, ['王总'])
      assert.deepEqual(wang.tags, ['报价'])
      assert.equal(wang.secrecyDefault, 1)
      assert.equal(wang.notes, '老客户')
      assert.equal('deletedAt' in wang, false)
      assert.deepEqual(store.getClient(wang.id), wang)
      assert.equal(store.getClient('cl_missing'), undefined)

      assert.equal(store.findClientByName('王总').id, wang.id, 'an alias resolves to its client')
      assert.equal(store.findClientByName(' 王工 ').id, wang.id)
      assert.equal(store.findClientByName('李总'), undefined)

      const acme = store.addClient({ name: 'ACME', aliases: ['ACME Ltd'] })
      assert.deepEqual(store.listClients().map((row) => row.name), ['ACME', '王工'], 'deterministic name order')
      assert.throws(() => store.addClient({ name: '王工' }), (error) => error.code === 'E_CLIENT_DUPLICATE')
      assert.throws(() => store.addClient({ name: 'ａｃｍｅ' }), (error) => error.code === 'E_CLIENT_DUPLICATE')
      assert.throws(() => store.addClient({ name: '李总', aliases: ['王工'] }), (error) => error.code === 'E_CLIENT_ALIAS_CONFLICT')
      assert.throws(() => store.addClient({}), (error) => error.code === 'E_CLIENT_INVALID')
      assert.throws(() => store.addClient({ name: 'x', secrecyDefault: 9 }), (error) => error.code === 'E_CLIENT_INVALID')
      assert.throws(() => store.addClient({ name: 'x', status: 'hidden' }), (error) => error.code === 'E_CLIENT_INVALID')

      const renamed = store.updateClient(acme.id, { name: 'ACME 咨询', aliases: ['ACME', '埃斯'], notes: '长期' })
      assert.equal(renamed.name, 'ACME 咨询')
      assert.deepEqual(renamed.aliases, ['ACME', '埃斯'])
      assert.equal(renamed.nameNorm, 'acme 咨询')
      assert.throws(() => store.updateClient(acme.id, { name: '王工' }), (error) => error.code === 'E_CLIENT_DUPLICATE')
      assert.throws(() => store.updateClient(acme.id, { nope: 1 }), /unknown client field: nope/)
      assert.throws(() => store.updateClient('cl_missing', { name: 'x' }), (error) => error.code === 'E_CLIENT_NOT_FOUND')

      assert.throws(() => store.addClientAlias(acme.id, '王工'), (error) => error.code === 'E_CLIENT_ALIAS_CONFLICT')
      const withAlias = store.addClientAlias(acme.id, '埃森哲')
      assert.deepEqual(withAlias.aliases, ['ACME', '埃斯', '埃森哲'])
      const withoutAlias = store.removeClientAlias(acme.id, '埃森哲')
      assert.deepEqual(withoutAlias.aliases, ['ACME', '埃斯'])
      assert.throws(() => store.removeClientAlias(acme.id, 'missing'), (error) => error.code === 'E_CLIENT_ALIAS_NOT_FOUND')

      const archived = store.archiveClient(acme.id)
      assert.equal(archived.status, 'archived')
      assert.ok(archived.deletedAt)
      assert.deepEqual(store.listClients().map((row) => row.name), ['王工'])
      assert.deepEqual(store.listClients({ status: 'archived', includeDeleted: true }).map((row) => row.id), [acme.id])
      assert.deepEqual(store.listClients({ status: 'all', includeDeleted: true }).length, 2)
      // An archived name may be reused (the partial index only covers live rows).
      const acmeAgain = store.addClient({ name: 'ACME 咨询' })
      assert.notEqual(acmeAgain.id, acme.id)
      assert.throws(() => store.restoreClient(acme.id), (error) => error.code === 'E_CLIENT_DUPLICATE', 'the reused name blocks a restore')
      assert.equal(store.addClientAlias(wang.id, '王工本人').aliases.at(-1), '王工本人')
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('mergeClients moves matters/projects/notes/deliveries, archives the source and carries aliases', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      const a = store.addClient({ name: '王工', aliases: ['王总'] })
      const b = store.addClient({ name: '王建国' })
      const projectA = store.addProject({ clientId: a.id, name: '官网改版' })
      const projectB = store.addProject({ clientId: b.id, name: '官网改版' })
      seedMatter(store, 'm_a')
      store.setMatterClient('m_a', { clientId: a.id, projectId: projectA.id })
      store.addClientNote({ clientId: a.id, projectId: projectA.id, summary: '电话确认预算 8 万', at: NOW })
      store.addDelivery({ matterId: 'm_a', conversationId: 'c1', files: ['out/a.docx'], title: '报价单' })
      seedMatter(store, 'm_b')
      store.setMatterClient('m_b', { clientId: b.id, projectId: projectB.id })

      const merged = store.mergeClients(a.id, b.id)
      assert.equal(merged.mergedFrom, a.id)
      assert.equal(merged.movedMatters, 1)
      assert.equal(merged.mergedProjects, 1, 'the same-name project merges onto the target project')
      assert.equal(merged.movedNotes, 1)
      assert.equal(merged.movedDeliveries, 1)
      assert.equal(merged.carriedAliases, 2, 'name + alias become target aliases')
      assert.deepEqual(merged.client.aliases, ['王工', '王总'])
      assert.deepEqual(store.listMattersByClient(b.id).map((matter) => matter.id).sort(), ['m_a', 'm_b'])
      assert.equal(store.listClientNotes({ clientId: b.id }).length, 1)
      assert.equal(store.listClientNotes({ clientId: b.id })[0].projectId, projectB.id, 'the merged project id is remapped')
      assert.equal(store.listDeliveries(5, { clientId: b.id }).length, 1)
      assert.equal(store.getClient(a.id).status, 'archived')
      assert.equal(store.getProject(projectA.id).status, 'archived')
      assert.throws(() => store.mergeClients(b.id, b.id), (error) => error.code === 'E_CLIENT_MERGE_SELF')
      assert.throws(() => store.mergeClients('cl_missing', b.id), (error) => error.code === 'E_CLIENT_NOT_FOUND')
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('project CRUD: per-client duplicate names, default matter validation and archive', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      const a = store.addClient({ name: '王工' })
      const b = store.addClient({ name: '李总' })
      seedMatter(store, 'm1')
      const project = store.addProject({ clientId: a.id, name: '官网改版', startedAt: '2026-11-20', dueAt: '2026-12-31', defaultMatterId: 'm1', notes: '一期' })
      assert.match(project.id, /^prj_/)
      assert.equal(project.clientId, a.id)
      assert.equal(project.startedAt, '2026-11-20')
      assert.equal(project.dueAt, '2026-12-31')
      assert.equal(project.defaultMatterId, 'm1')
      assert.equal(store.findProjectByName(a.id, ' 官网改版 ').id, project.id)
      assert.equal(store.findProjectByName(b.id, '官网改版'), undefined)
      const sameNameOtherClient = store.addProject({ clientId: b.id, name: '官网改版' })
      assert.equal(sameNameOtherClient.clientId, b.id, 'the uniqueness is per client')
      assert.throws(() => store.addProject({ clientId: a.id, name: '官网改版' }), (error) => error.code === 'E_PROJECT_DUPLICATE')
      assert.throws(() => store.addProject({ clientId: 'cl_missing', name: 'x' }), (error) => error.code === 'E_CLIENT_NOT_FOUND')
      assert.throws(() => store.addProject({ clientId: a.id, name: 'x', defaultMatterId: 'm_missing' }), (error) => error.code === 'E_MATTER_NOT_FOUND')
      assert.throws(() => store.addProject({ clientId: a.id, name: 'x', dueAt: 'tomorrow' }), (error) => error.code === 'E_PROJECT_INVALID')

      const updated = store.updateProject(project.id, { name: '官网改版二期', status: 'archived' })
      assert.equal(updated.name, '官网改版二期')
      assert.equal(updated.status, 'archived')
      assert.ok(updated.deletedAt)
      assert.equal(store.listProjects({ clientId: a.id }).length, 0)
      assert.equal(store.listProjects({ clientId: a.id, status: 'archived', includeDeleted: true }).length, 1)
      assert.throws(() => store.updateProject(project.id, { bogus: true }), /unknown project field: bogus/)
      assert.equal(store.archiveProject(sameNameOtherClient.id).status, 'archived')
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('matter ownership: link/unlink with validation, snapshot round-trip and unclassified view', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      const a = store.addClient({ name: '王工' })
      const b = store.addClient({ name: '李总' })
      const project = store.addProject({ clientId: a.id, name: '官网改版' })
      seedMatter(store, 'm1')
      seedMatter(store, 'm2')

      assert.equal('clientId' in store.getMatter('m1'), false, 'an unlinked matter keeps the pre-v21 JSON shape')
      const linked = store.setMatterClient('m1', { clientId: a.id, projectId: project.id })
      assert.equal(linked.clientId, a.id)
      assert.equal(linked.projectId, project.id)
      assert.deepEqual(store.listMattersByClient(a.id).map((matter) => matter.id), ['m1'])
      assert.deepEqual(store.listMattersByProject(project.id).map((matter) => matter.id), ['m1'])
      assert.deepEqual(store.listUnclassifiedMatters().map((matter) => matter.id), ['m2'])

      assert.throws(() => store.setMatterClient('m_missing', { clientId: a.id }), (error) => error.code === 'E_MATTER_NOT_FOUND')
      assert.throws(() => store.setMatterClient('m2', { clientId: 'cl_missing' }), (error) => error.code === 'E_CLIENT_NOT_FOUND')
      assert.throws(() => store.setMatterClient('m2', { clientId: b.id, projectId: project.id }), (error) => error.code === 'E_PROJECT_CLIENT_MISMATCH')
      assert.throws(() => store.setMatterClient('m2', { projectId: project.id }), (error) => error.code === 'E_PROJECT_CLIENT_MISMATCH')
      const archivedProject = store.archiveProject(store.addProject({ clientId: a.id, name: '旧项目' }).id)
      assert.throws(() => store.setMatterClient('m2', { clientId: a.id, projectId: archivedProject.id }), (error) => error.code === 'E_PROJECT_ARCHIVED')

      // A full load+save round-trip must keep the ownership columns (the
      // historical save path writes explicit columns now).
      store.save(store.load())
      assert.equal(store.getMatter('m1').clientId, a.id)
      assert.equal(store.getMatter('m1').projectId, project.id)

      const unlinked = store.setMatterClient('m1', {})
      assert.equal('clientId' in unlinked, false)
      assert.equal('projectId' in unlinked, false)
      assert.equal(store.listMattersByClient(a.id).length, 0)
    } finally { store.close() }
    const reopened = new SqliteStore(db)
    try {
      assert.equal(reopened.getClient('cl_missing'), undefined)
      const clients = reopened.listClients()
      assert.equal(clients.length, 2)
    } finally { reopened.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('client notes CRUD: ISO-normalised time, project derivation, soft delete and validation', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      const a = store.addClient({ name: '王工' })
      const b = store.addClient({ name: '李总' })
      const project = store.addProject({ clientId: a.id, name: '官网改版' })
      const projectB = store.addProject({ clientId: b.id, name: '别的项目' })
      seedMatter(store, 'm1')
      store.setMatterClient('m1', { clientId: a.id, projectId: project.id })

      const note = store.addClientNote({
        clientId: a.id, matterId: 'm1', kind: 'call',
        at: '2026-11-18T09:00:00+08:00',
        summary: '电话确认预算 8 万\n第二行不显示',
        source: { kind: 'delivery', id: 'del_1' },
      })
      assert.match(note.id, /^note_/)
      assert.equal(note.at, '2026-11-18T01:00:00.000Z', 'the event time is normalised to ISO UTC')
      assert.equal(note.projectId, project.id, 'the matter project is inherited')
      assert.equal(note.kind, 'call')
      assert.deepEqual(note.source, { kind: 'delivery', id: 'del_1' })

      const second = store.addClientNote({ clientId: a.id, summary: '第二条', at: '2026-11-19T00:00:00.000Z' })
      assert.deepEqual(store.listClientNotes({ clientId: a.id }).map((row) => row.id), [second.id, note.id], 'newest event first')
      const deleted = store.deleteClientNote(second.id)
      assert.ok(deleted.deletedAt)
      assert.deepEqual(store.listClientNotes({ clientId: a.id }).map((row) => row.id), [note.id])
      assert.equal(store.listClientNotes({ clientId: a.id, includeDeleted: true }).length, 2)
      assert.equal(store.getClientNote(note.id).summary.slice(0, 2), '电话')
      const updated = store.updateClientNote(note.id, { summary: '电话确认预算 9 万', kind: 'meeting' })
      assert.equal(updated.summary, '电话确认预算 9 万')
      assert.equal(updated.kind, 'meeting')

      assert.throws(() => store.addClientNote({ clientId: 'cl_missing', summary: 'x' }), (error) => error.code === 'E_CLIENT_NOT_FOUND')
      assert.throws(() => store.addClientNote({ clientId: a.id, summary: '' }), (error) => error.code === 'E_CLIENT_NOTE_INVALID')
      assert.throws(() => store.addClientNote({ clientId: a.id, summary: 'x', kind: 'fax' }), (error) => error.code === 'E_CLIENT_NOTE_INVALID')
      assert.throws(() => store.addClientNote({ clientId: a.id, summary: 'x', at: 'someday' }), (error) => error.code === 'E_CLIENT_NOTE_INVALID')
      assert.throws(() => store.addClientNote({ clientId: a.id, summary: 'x', projectId: projectB.id }), (error) => error.code === 'E_PROJECT_CLIENT_MISMATCH')
      assert.throws(() => store.addClientNote({ clientId: b.id, summary: 'x', matterId: 'm1' }), (error) => error.code === 'E_MATTER_CLIENT_MISMATCH')
      assert.throws(() => store.addClientNote({ clientId: a.id, summary: 'x', source: { kind: 'delivery' } }), (error) => error.code === 'E_CLIENT_NOTE_INVALID')
      assert.throws(() => store.addClientNote({ clientId: a.id, summary: 'x', source: { kind: 'manual', id: '/home/me/secret.txt' } }), (error) => error.code === 'E_CLIENT_NOTE_INVALID')
      assert.throws(() => store.addClientNote({ clientId: a.id, summary: 'x', source: 'text' }), (error) => error.code === 'E_CLIENT_NOTE_INVALID')
      assert.throws(() => store.deleteClientNote('note_missing'), (error) => error.code === 'E_CLIENT_NOTE_NOT_FOUND')
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('delivery lineage: snapshot columns persist, filter and validate; old rows keep their shape', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      const a = store.addClient({ name: '王工' })
      const b = store.addClient({ name: '李总' })
      const project = store.addProject({ clientId: a.id, name: '官网改版' })
      seedMatter(store, 'm1')
      store.setMatterClient('m1', { clientId: a.id, projectId: project.id })

      // A delivery filed under an unlinked matter has no ownership snapshot, so
      // the pre-v21 call keeps the exact old JSON shape.
      seedMatter(store, 'm_legacy')
      const legacy = store.addDelivery({ matterId: 'm_legacy', conversationId: 'c1', files: ['out/old.docx'], title: '旧交付' })
      assert.ok(legacy.startsWith('del_'))
      const legacyRow = store.listDeliveries(10).find((delivery) => delivery.id === legacy)
      assert.equal(legacyRow.title, '旧交付')
      assert.equal('clientId' in legacyRow, false, 'a pre-lineage call keeps the old JSON shape')
      assert.equal('templateName' in legacyRow, false)

      const id = store.addDelivery({
        matterId: 'm1', conversationId: 'c1', files: ['out/quote.docx'], tool: 'template:quote', title: '报价确认单',
        templateName: 'quote', templateVersion: '1', quoteNo: 'Q-20261119-001', dataSha256: SHA,
      })
      const row = store.listDeliveries(10).find((delivery) => delivery.id === id)
      assert.equal(row.clientId, a.id, 'the matter ownership is snapshotted when the caller omits it')
      assert.equal(row.projectId, project.id)
      assert.equal(row.templateName, 'quote')
      assert.equal(row.templateVersion, '1')
      assert.equal(row.quoteNo, 'Q-20261119-001')
      assert.equal(row.dataSha256, SHA)
      assert.equal(store.listDeliveries(10, { clientId: a.id }).length, 1)
      assert.equal(store.listDeliveries(10, { clientId: b.id }).length, 0)
      assert.equal(store.listDeliveries(10, { matterId: 'm1' }).length, 1)
      assert.equal(store.listDeliveries(10, { matterId: 'm_legacy' }).length, 1)

      assert.throws(() => store.addDelivery({ matterId: 'm1', conversationId: 'c1', files: [], dataSha256: 'xyz' }), (error) => error.code === 'E_DELIVERY_INVALID')
      assert.throws(() => store.addDelivery({ matterId: 'm1', conversationId: 'c1', files: [], clientId: 'cl_missing' }), (error) => error.code === 'E_CLIENT_NOT_FOUND')
      assert.throws(() => store.addDelivery({ matterId: 'm1', conversationId: 'c1', files: [], clientId: b.id, projectId: project.id }), (error) => error.code === 'E_PROJECT_CLIENT_MISMATCH')

      // A full ledger save/load must not lose delivery lineage (it is a
      // SQLite-only table the historical save path never rewrote).
      store.save(store.load())
      const after = store.listDeliveries(10).find((delivery) => delivery.id === id)
      assert.equal(after.dataSha256, SHA)
      assert.equal(after.clientId, a.id)
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('client timeline sources + core derivation: ordering, project inheritance and cross-client isolation', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      const a = store.addClient({ name: '王工' })
      const b = store.addClient({ name: '李总' })
      const projectA = store.addProject({ clientId: a.id, name: '官网改版' })
      seedMatter(store, 'm_a', { secrecy: 1 })
      seedMatter(store, 'm_b')
      store.setMatterClient('m_a', { clientId: a.id, projectId: projectA.id })
      store.setMatterClient('m_b', { clientId: b.id })
      seedCommitment(store, { id: 'cm_a', matterId: 'm_a', debtor: 'agent', creditor: '王工', action: '发修订报价', createdAt: '2026-11-10T01:00:00.000Z' })
      seedCommitment(store, { id: 'cm_legacy', matterId: 'm_a', debtor: 'agent', creditor: '王工', action: '旧承诺没有创建时间' })
      seedCommitment(store, { id: 'cm_b', matterId: 'm_b', debtor: 'agent', creditor: '李总', action: '李总的秘密承诺', createdAt: '2026-11-11T00:00:00.000Z' })
      const deliveryA = store.addDelivery({ matterId: 'm_a', conversationId: 'c1', files: ['out/a.docx'], tool: 'template:quote', title: '报价确认单' })
      store.addDelivery({ matterId: 'm_b', conversationId: 'c2', files: ['out/b.docx'], title: '李总的交付' })
      store.addClientNote({ clientId: a.id, projectId: projectA.id, summary: '电话确认预算 8 万', at: '2026-11-18T09:00:00.000Z' })
      store.addClientNote({ clientId: b.id, summary: '李总的备注', at: '2026-11-18T10:00:00.000Z' })

      const sources = store.clientTimelineSources(a.id)
      assert.equal(sources.client.id, a.id)
      assert.deepEqual(sources.matters.map((matter) => matter.id), ['m_a'])
      assert.deepEqual(sources.commitments.map((row) => row.id).sort(), ['cm_a', 'cm_legacy'])
      assert.deepEqual(sources.deliveries.map((row) => row.id), [deliveryA])
      assert.deepEqual(sources.notes.map((row) => row.summary), ['电话确认预算 8 万'])
      assert.deepEqual(sources.deliveries[0].clientId, a.id)

      const derived = deriveClientTimeline(sources, { limit: 12 })
      assert.deepEqual(derived.degraded, [TIMELINE_DEGRADED.commitmentMissingCreatedAt], 'an old commitment without a creation instant is reported, not placed at its due date')
      // delivered just now > note (2026-11-18) > commitment (2026-11-10).
      assert.deepEqual(derived.items.map((item) => item.kind), ['delivery', 'note', 'commitment'])
      assert.deepEqual(derived.items.map((item) => item.ref.id), [deliveryA, sources.notes[0].id, 'cm_a'])
      assert.equal(derived.items[0].projectId, projectA.id)
      assert.equal(derived.items[0].secrecy, 1)
      assert.equal(derived.items[0].templateName, undefined, 'the store row had no template lineage')
      assert.equal(derived.items[1].projectId, projectA.id)

      const isolated = JSON.stringify(derived)
      for (const secret of [b.id, '李总', '李总的秘密承诺', '李总的交付', '李总的备注']) {
        assert.equal(isolated.includes(secret), false, 'client A timeline must not contain ' + secret)
      }

      const counts = summarizeClientCounts(sources, { now: '2026-11-20T00:00:00.000Z' })
      assert.deepEqual(counts, { matters: 1, mattersArchived: 0, deliveries: 1, notes: 1, commitments: 2, openMine: 2, openWaiting: 0, overdue: 0 })
      assert.throws(() => store.clientTimelineSources('cl_missing'), (error) => error.code === 'E_CLIENT_NOT_FOUND')
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a read-only store reads customer entities and refuses every customer write', () => {
  const { root, db } = setup()
  try {
    const writer = new SqliteStore(db)
    try {
      const client = writer.addClient({ name: '王工' })
      const project = writer.addProject({ clientId: client.id, name: '官网改版' })
      seedMatter(writer, 'm1')
      writer.setMatterClient('m1', { clientId: client.id, projectId: project.id })
      writer.addClientNote({ clientId: client.id, summary: '只读也要能看', at: NOW })
    } finally { writer.close() }
    const reader = openReadStore(db)
    try {
      assert.equal(reader.schemaVersion(), SCHEMA_VERSION)
      assert.equal(reader.listClients().length, 1)
      assert.equal(reader.getProject(reader.listProjects()[0].id).name, '官网改版')
      assert.equal(reader.listClientNotes({ clientId: reader.listClients()[0].id }).length, 1)
      assert.equal(reader.clientTimelineSources(reader.listClients()[0].id).matters.length, 1)
      assert.throws(() => reader.addClient({ name: 'x' }), (error) => error.code === 'E_READ_ONLY')
      assert.throws(() => reader.setMatterClient('m1', {}), (error) => error.code === 'E_READ_ONLY')
    } finally { reader.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('export data shape: DATA_TABLES is the single list and the customer tables export raw rows', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      const client = store.addClient({ name: '王工', aliases: ['王总'], tags: ['报价'], secrecyDefault: 2, notes: '老客户' })
      const project = store.addProject({ clientId: client.id, name: '官网改版', startedAt: '2026-11-20' })
      seedMatter(store, 'm1')
      store.setMatterClient('m1', { clientId: client.id, projectId: project.id })
      store.addClientNote({ clientId: client.id, projectId: project.id, summary: '一次电话', at: NOW })

      assert.deepEqual(Object.keys(store.exportDataTables()), [...DATA_TABLES])
      for (const table of ['sessions', 'turns', 'session_summaries', 'summary_versions', 'deliveries', 'nudges', 'task_runs', 'audit', 'memory_candidates', 'permit_consumed', 'clients', 'projects', 'client_notes']) {
        assert.ok(DATA_TABLES.includes(table), 'DATA_TABLES is missing ' + table)
      }
      const data = store.exportDataTables(['clients', 'projects', 'client_notes'])
      assert.deepEqual(Object.keys(data), ['clients', 'projects', 'client_notes'])
      assert.equal(data.clients.length, 1)
      const rawClient = data.clients[0]
      assert.equal(rawClient.name, '王工')
      assert.equal(rawClient.name_norm, '王工', 'the export keeps the raw snake_case row shape')
      assert.equal(rawClient.secrecy_default, 2)
      assert.equal(rawClient.aliases, '["王总"]')
      assert.equal(rawClient.notes, '老客户')
      assert.equal(data.projects[0].client_id, client.id)
      assert.equal(data.client_notes[0].summary, '一次电话')
      assert.throws(() => store.exportDataTables(['not_a_table']), /unknown export table/)

      // The wire snapshot stays the nine ledger tables; v21 only adds optional
      // ownership/creation fields to their rows.
      const snapshot = store.load()
      assert.deepEqual(Object.keys(snapshot).sort(), ['commitments', 'facts', 'links', 'matters', 'preferences', 'routinePatches', 'routines', 'routes', 'updates', 'version'].sort())
      assert.equal(snapshot.matters[0].clientId, client.id)
      assert.equal(snapshot.matters[0].projectId, project.id)
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('customer entities survive a reopen without a migration row or backup', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    const client = store.addClient({ name: '王工', aliases: ['王总'] })
    const project = store.addProject({ clientId: client.id, name: '官网改版' })
    seedMatter(store, 'm1')
    store.setMatterClient('m1', { clientId: client.id, projectId: project.id })
    store.addClientNote({ clientId: client.id, summary: '记录', at: NOW })
    const migrations = store.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n
    store.close()
    const reopened = new SqliteStore(db)
    try {
      assert.equal(reopened.getMeta('schema_version'), '21')
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, migrations)
      assert.equal(reopened.getClient(client.id).name, '王工')
      assert.deepEqual(reopened.getClient(client.id).aliases, ['王总'])
      assert.equal(reopened.getProject(project.id).name, '官网改版')
      assert.equal(reopened.listMattersByClient(client.id).length, 1)
      assert.equal(reopened.listClientNotes({ clientId: client.id }).length, 1)
    } finally { reopened.close() }
    assert.deepEqual(readdirSync(root).filter((name) => name.includes('before-migrate')), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
