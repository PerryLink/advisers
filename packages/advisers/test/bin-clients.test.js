/**
 * 0.3.0 customer entities — CLI wiring (task-119).
 *
 * Covers the product-facing contract, not the store internals:
 * - client/project CRUD + matter ownership and the derived timeline;
 * - cross-client isolation and the opt-in --clearance secrecy gate;
 * - delivery lineage snapshot at generation time;
 * - export --all / import --replace parity (restore + atomic refusal);
 * - status --json additive counts and the TOS gate on the new commands.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DATA_TABLES } from '../lib/sqlite.js'
import { isJsonPure } from '../lib/tui/json.js'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function setup(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-client-cli-' + prefix + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { root, home, work }
}
function env(home, extra = {}) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra })
}
function run(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8', input: '', timeout: 60000 })
}
function okRun(home, args, extra = {}) {
  const result = run(home, args, extra)
  assert.equal(result.status, 0, args.join(' ') + ' failed: ' + result.stderr)
  return result
}
function okJson(home, args, extra = {}) {
  const result = okRun(home, args, extra)
  assert.ok(isJsonPure(result.stdout), 'stdout is not one pure JSON document: ' + args.join(' '))
  return JSON.parse(result.stdout)
}
function fail(home, args, extra = {}) {
  const result = run(home, args, extra)
  assert.equal(result.status, 1, args.join(' ') + ' should exit 1, got ' + result.status + ': ' + result.stderr)
  return result
}
function addClient(home, name, extra = []) {
  return okJson(home, ['client', 'add', name, '--json', ...extra]).client
}
function addProject(home, clientId, name) {
  return okJson(home, ['project', 'add', clientId, name, '--json']).project
}
function addMatter(home, title, extra = []) {
  return okJson(home, ['matter', 'add', title, '--json', ...extra]).matter
}

test('client/project CRUD + matter ownership: list/show/timeline/note/archive contract', () => {
  const s = setup('crud')
  try {
    const wang = addClient(s.home, '王工', ['--aliases', '王总,王建国', '--tags', '报价', '--secrecy', '0', '--note', '老客户'])
    assert.match(wang.id, /^cl_[0-9a-f]+$/)
    assert.deepEqual(wang.aliases, ['王总', '王建国'])
    assert.deepEqual(wang.tags, ['报价'])
    assert.equal(wang.notes, '老客户')

    const dup = fail(s.home, ['client', 'add', '王工', '--json'])
    assert.match(dup.stderr, /E_CLIENT_DUPLICATE/)
    assert.equal(dup.stdout, '', '--json failure keeps stdout empty (errors on stderr)')

    let list = okJson(s.home, ['client', 'list', '--json'])
    assert.equal(list.length, 1)
    assert.deepEqual(list[0].counts, { matters: 0, mattersArchived: 0, deliveries: 0, notes: 0, commitments: 0, openMine: 0, openWaiting: 0, overdue: 0 })

    const project = addProject(s.home, wang.id, '官网改版')
    assert.match(project.id, /^prj_[0-9a-f]+$/)
    assert.equal(project.clientId, wang.id)
    assert.match(fail(s.home, ['project', 'add', wang.id, '官网改版', '--json']).stderr, /E_PROJECT_DUPLICATE/)

    const matter = addMatter(s.home, '报价单', ['--client', wang.id, '--project', project.id])
    assert.equal(matter.clientId, wang.id)
    assert.equal(matter.projectId, project.id)
    // Unclassified (no ownership) matters stay visible by default and through the filter.
    const free = addMatter(s.home, '临时事项')
    const filtered = okJson(s.home, ['matter', 'ls', '--client', wang.id, '--json'])
    assert.deepEqual(filtered.map((row) => row.id), [matter.id])
    assert.deepEqual(okJson(s.home, ['matter', 'ls', '--unclassified', '--json']).map((row) => row.id), [free.id])
    const shown = okJson(s.home, ['matter', 'show', matter.id, '--json'])
    assert.equal(shown.client.id, wang.id)
    assert.equal(shown.project.id, project.id)
    assert.match(fail(s.home, ['matter', 'ls', '--client', 'cl_missing', '--json']).stderr, /E_CLIENT_NOT_FOUND/)

    okRun(s.home, ['commit', 'add', '发修订报价', '--quote', '周五前发', '--due', '2026-12-01T09:00:00+08:00', '--matter', matter.id])
    const note = okJson(s.home, ['client', 'note', 'add', wang.id, '电话确认预算 8 万', '--project', project.id, '--kind', 'call', '--at', '2026-11-01T00:00:00Z', '--json']).note
    assert.equal(note.kind, 'call')
    assert.equal(note.projectId, project.id)
    const notes = okJson(s.home, ['client', 'note', 'list', wang.id, '--json'])
    assert.deepEqual(notes.map((row) => row.id), [note.id])

    const clientShow = okJson(s.home, ['client', 'show', wang.id, '--json'])
    assert.equal(clientShow.ok, true)
    assert.equal(clientShow.counts.matters, 1)
    assert.equal(clientShow.counts.commitments, 1)
    assert.equal(clientShow.counts.openMine, 1)
    assert.equal(clientShow.counts.notes, 1)
    assert.equal(clientShow.projects[0].id, project.id)
    assert.equal(clientShow.projects[0].counts.matters, 1)
    assert.ok(clientShow.nextDueAt)
    // The note is older than the commitment, so the derived timeline puts it last.
    assert.deepEqual(clientShow.timeline.map((item) => item.kind), ['commitment', 'note'])
    assert.equal(clientShow.timeline[0].secrecy, 0)

    const timeline = okJson(s.home, ['client', 'timeline', wang.id, '--since', '90d', '--kind', 'note', '--json'])
    assert.deepEqual(timeline.items.map((item) => item.kind), ['note'])
    assert.equal(timeline.nextCursor, null)
    assert.match(fail(s.home, ['client', 'timeline', wang.id, '--kind', 'bogus', '--json']).stderr, /E_USAGE/)

    const projectShow = okJson(s.home, ['project', 'show', project.id, '--json'])
    assert.equal(projectShow.client.id, wang.id)
    assert.deepEqual(projectShow.matters.map((row) => row.id), [matter.id])
    assert.equal(projectShow.counts.commitments, 1)
    assert.deepEqual(okJson(s.home, ['project', 'list', '--client', wang.id, '--json']).map((row) => row.id), [project.id])

    // Archiving is blocked while a project is active; the dry-run only reports it.
    assert.match(fail(s.home, ['client', 'archive', wang.id, '--json']).stderr, /E_CLIENT_HAS_ACTIVE_PROJECTS/)
    const dry = okJson(s.home, ['client', 'archive', wang.id, '--dry-run', '--json'])
    assert.equal(dry.dryRun, true)
    assert.equal(dry.wouldBlock, true)
    okJson(s.home, ['project', 'archive', project.id, '--json'])
    const archived = okJson(s.home, ['client', 'archive', wang.id, '--json'])
    assert.equal(archived.client.status, 'archived')
    assert.deepEqual(okJson(s.home, ['client', 'list', '--json']), [])
    assert.equal(okJson(s.home, ['client', 'list', '--all', '--json'])[0].status, 'archived')
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('cross-client isolation: one client view never contains another client data', () => {
  const s = setup('isolation')
  try {
    const a = addClient(s.home, '王工')
    const b = addClient(s.home, '李总')
    const projectA = addProject(s.home, a.id, '官网改版')
    const matterA = addMatter(s.home, '王工报价', ['--client', a.id, '--project', projectA.id])
    const matterB = addMatter(s.home, '李总事项', ['--client', b.id])
    okRun(s.home, ['commit', 'add', '王工的承诺', '--quote', 'q', '--matter', matterA.id])
    okRun(s.home, ['commit', 'add', '李总的秘密', '--quote', 'q', '--matter', matterB.id])
    okJson(s.home, ['client', 'note', 'add', a.id, '王工电话', '--project', projectA.id, '--json'])
    okJson(s.home, ['client', 'note', 'add', b.id, '李总的备注', '--json'])

    const showA = run(s.home, ['client', 'show', a.id, '--json'])
    assert.equal(showA.status, 0, showA.stderr)
    const text = showA.stdout
    for (const secret of [b.id, '李总', '李总事项', '李总的秘密', '李总的备注']) {
      assert.equal(text.includes(secret), false, 'client A output leaked ' + secret)
    }
    const showB = run(s.home, ['client', 'show', b.id, '--json'])
    assert.equal(showB.status, 0, showB.stderr)
    assert.equal(showB.stdout.includes('王工的承诺'), false)
    assert.equal(showB.stdout.includes(a.id), false)
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('--clearance is a per-item gate: withheld matters expose only a count, never content', () => {
  const s = setup('clearance')
  try {
    const client = addClient(s.home, '赵总')
    const project = addProject(s.home, client.id, '保密项目')
    const publicMatter = addMatter(s.home, '公开事项', ['--secrecy', '0', '--client', client.id, '--project', project.id])
    const secretMatter = addMatter(s.home, '机密事项', ['--secrecy', '2', '--client', client.id, '--project', project.id])
    okRun(s.home, ['commit', 'add', '公开承诺', '--quote', 'q', '--matter', publicMatter.id])
    okRun(s.home, ['commit', 'add', '机密承诺', '--quote', 'q', '--matter', secretMatter.id])

    const hidden = okJson(s.home, ['client', 'show', client.id, '--clearance', '0', '--json'])
    assert.equal(hidden.clearance, 0)
    assert.ok(hidden.protectedExcluded >= 1)
    assert.equal(hidden.counts.matters, 1)
    assert.equal(hidden.counts.commitments, 1)
    assert.equal(JSON.stringify(hidden).includes('机密'), false, 'withheld matter content must not appear, not even a title')
    assert.deepEqual(hidden.timeline.map((item) => item.title), ['公开承诺'])

    const visible = okJson(s.home, ['client', 'show', client.id, '--clearance', '2', '--json'])
    assert.equal(visible.protectedExcluded, 0)
    assert.equal(visible.counts.matters, 2)
    assert.deepEqual(visible.timeline.map((item) => [item.title, item.secrecy]), [['机密承诺', 2], ['公开承诺', 0]])
    // The local default (3) shows everything the user owns, with truthful labels.
    const local = okJson(s.home, ['client', 'timeline', client.id, '--json'])
    assert.equal(local.protectedExcluded, 0)
    assert.equal(local.items.some((item) => item.secrecy == null), false)
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('client merge moves matters/notes, merges same-name projects and archives the source', () => {
  const s = setup('merge')
  try {
    const a = addClient(s.home, '王工')
    const b = addClient(s.home, '王建国')
    const projectA = addProject(s.home, a.id, '官网改版')
    const projectB = addProject(s.home, b.id, '官网改版')
    addMatter(s.home, 'A 事项', ['--client', a.id, '--project', projectA.id])
    const movedMatter = addMatter(s.home, 'B 事项', ['--client', b.id, '--project', projectB.id])
    okJson(s.home, ['client', 'note', 'add', b.id, 'B 的备注', '--json'])

    const dry = okJson(s.home, ['client', 'merge', b.id, a.id, '--dry-run', '--json'])
    assert.equal(dry.dryRun, true)
    assert.equal(dry.plan.movedMatters, 1)
    assert.equal(dry.plan.movedProjects, 0)
    assert.equal(dry.plan.mergedProjects, 1)
    assert.equal(dry.plan.movedNotes, 1)

    const merged = okJson(s.home, ['client', 'merge', b.id, a.id, '--json'])
    assert.equal(merged.mergedFrom, b.id)
    assert.equal(merged.movedMatters, 1)
    assert.equal(merged.mergedProjects, 1)
    assert.ok(merged.client.aliases.includes('王建国'), 'the source name becomes an alias')
    const names = okJson(s.home, ['client', 'list', '--json']).map((row) => row.name)
    assert.deepEqual(names, ['王工'])
    assert.equal(okJson(s.home, ['client', 'list', '--all', '--json']).length, 2)
    assert.equal(okJson(s.home, ['matter', 'show', movedMatter.id, '--json']).client.id, a.id)
    assert.deepEqual(fail(s.home, ['client', 'merge', a.id, a.id, '--json']).stderr.match(/E_CLIENT_MERGE_SELF/)[0], 'E_CLIENT_MERGE_SELF')
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('delivery lineage: template generation snapshots client/project/template/quote/dataSha256', () => {
  const s = setup('lineage')
  try {
    const client = addClient(s.home, '王工')
    const project = addProject(s.home, client.id, '官网改版')
    const matter = addMatter(s.home, '报价单', ['--client', client.id, '--project', project.id])
    const quote = {
      issuedAt: '2026-11-18', validUntil: '2026-12-02', currency: 'CNY',
      issuer: { name: 'PerryLink' }, client: { name: '王工' }, project: { name: '官网改版' },
      items: [{ desc: '需求调研', qty: '1', unit: '项', unitPrice: '8000.00' }],
    }
    const dataFile = join(s.work, 'quote.json')
    writeFileSync(dataFile, JSON.stringify(quote))
    const generated = okJson(s.home, ['template', 'quote', dataFile, join(s.work, 'quote.docx'), '--record-delivery', '--matter', matter.id, '--json'])
    assert.match(generated.deliveryId, /^del_/)
    const rows = okJson(s.home, ['deliveries', '--json'])
    const row = rows.find((entry) => entry.id === generated.deliveryId)
    assert.equal(row.clientId, client.id)
    assert.equal(row.projectId, project.id)
    assert.equal(row.templateName, 'quote')
    assert.equal(row.templateVersion, '1')
    assert.equal(row.quoteNo, generated.quoteNo)
    assert.equal(row.dataSha256, generated.dataSha256)
    const timeline = okJson(s.home, ['client', 'timeline', client.id, '--json'])
    const delivery = timeline.items.find((item) => item.kind === 'delivery')
    assert.equal(delivery.templateName, 'quote')
    assert.equal(delivery.projectId, project.id)
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('export --all carries every data table and import --replace restores the customer tables atomically', () => {
  const a = setup('export-a')
  const b = setup('export-b')
  try {
    const client = addClient(a.home, '王工', ['--aliases', '王总'])
    const project = addProject(a.home, client.id, '官网改版')
    const matter = addMatter(a.home, '报价单', ['--client', client.id, '--project', project.id])
    okRun(a.home, ['commit', 'add', '发修订报价', '--quote', 'q', '--matter', matter.id])
    okJson(a.home, ['client', 'note', 'add', client.id, '电话确认预算', '--project', project.id, '--json'])
    const exported = join(a.work, 'all.json')
    const result = run(a.home, ['export', '--all', '--out', exported])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(readFileSync(exported, 'utf8'))
    assert.equal(payload.schemaVersion, 21)
    assert.deepEqual(Object.keys(payload.data), [...DATA_TABLES], 'export must carry the single DATA_TABLES list, no hand-maintained subset')
    assert.equal(payload.data.clients.length, 1)
    assert.equal(payload.data.projects.length, 1)
    assert.equal(payload.data.client_notes.length, 1)

    const imported = run(b.home, ['import', exported, '--replace'])
    assert.equal(imported.status, 0, imported.stderr)
    assert.match(imported.stdout, /restored clients=1 projects=1 client_notes=1/)
    const restored = okJson(b.home, ['client', 'show', client.id, '--json'])
    assert.equal(restored.client.name, '王工')
    assert.deepEqual(restored.client.aliases, ['王总'])
    assert.equal(restored.counts.matters, 1)
    assert.equal(restored.counts.notes, 1)
    assert.equal(restored.timeline.length, 2)
    const restoredMatter = okJson(b.home, ['matter', 'ls', '--json']).find((row) => row.id === matter.id)
    assert.equal(restoredMatter.clientId, client.id, 'matter ownership survives the round-trip')
    assert.equal(restoredMatter.projectId, project.id)
    assert.deepEqual(okJson(b.home, ['project', 'list', '--client', client.id, '--json']).map((row) => row.id), [project.id])

    // A dangling reference makes the whole import fail and leaves the target untouched.
    const tampered = JSON.parse(readFileSync(exported, 'utf8'))
    tampered.data.projects[0].client_id = 'cl_missing'
    const badRef = join(a.work, 'bad-ref.json')
    writeFileSync(badRef, JSON.stringify(tampered))
    const refused = fail(b.home, ['import', badRef, '--replace'])
    assert.match(refused.stderr, /E_JSON_INVALID/)
    assert.equal(okJson(b.home, ['client', 'list', '--json']).length, 1, 'a failed import must not change the database')

    // An export written by a newer schema is refused before any write.
    const newer = JSON.parse(readFileSync(exported, 'utf8'))
    newer.schemaVersion = 999
    const newerFile = join(a.work, 'newer.json')
    writeFileSync(newerFile, JSON.stringify(newer))
    const older = fail(b.home, ['import', newerFile, '--replace'])
    assert.match(older.stderr, /E_SCHEMA_NEWER/)
    assert.equal(okJson(b.home, ['client', 'list', '--json']).length, 1)
  } finally {
    rmSync(a.root, { recursive: true, force: true })
    rmSync(b.root, { recursive: true, force: true })
  }
})

test('status --json exposes additive client/project counts and customer commands are TOS-gated', () => {
  const s = setup('status')
  try {
    addClient(s.home, '王工')
    addClient(s.home, '李总')
    const status = okJson(s.home, ['status', '--json'])
    assert.equal(status.clients, 2)
    assert.equal(status.projects, 0)
    // status stays TOS-exempt on a fresh home (documented invariant).
    const fresh = setup('tos')
    try {
      const gateEnv = { ...process.env, ADVISERS_HOME: fresh.home, ADVISERS_CORE_LOCAL: '1', ADVISERS_STORE: 'sqlite' }
      delete gateEnv.ADVISERS_ACCEPT_TOS
      const blocked = spawnSync(process.execPath, [bin, 'client', 'add', '王工'], { env: gateEnv, encoding: 'utf8', input: '' })
      assert.equal(blocked.status, 3)
      assert.match(blocked.stderr, /E_TOS_REQUIRED/)
      // The block decision is audited (which may create the DB); no customer row
      // may have been written by the refused command.
      const after = spawnSync(process.execPath, [bin, 'status', '--json'], { env: gateEnv, encoding: 'utf8', input: '' })
      if (after.status === 0) assert.equal(JSON.parse(after.stdout).clients, 0, 'the gated command must not write a client')
    } finally { rmSync(fresh.root, { recursive: true, force: true }) }
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})
