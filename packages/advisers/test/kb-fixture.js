/**
 * Shared fixtures for the 0.4.0 KB tests.
 *
 * Every test uses a mktemp ADVISERS_HOME-style temporary directory (state.db
 * inside it); the real ~/.advisers is never touched. If the checked-out
 * lib/sqlite.js already provides the frozen v22 KB schema (schema-v22 task) the
 * ensureKbSchema() helper is a no-op; until that lands it creates exactly the
 * frozen DDL from the 0.4 implementation plan so the KB module tests are not
 * blocked on the schema writer. The duplicated DDL is test-only and safe to
 * delete once v22 is merged (see the final report).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { SqliteStore } from '../lib/sqlite.js'

const KB_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS kb_documents (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
  client_id TEXT, project_id TEXT, matter_id TEXT,
  source_name TEXT, source_sha256 TEXT NOT NULL, mime TEXT,
  size_bytes INTEGER NOT NULL, encoding TEXT, extractor TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', secrecy INTEGER NOT NULL DEFAULT 0,
  needs_ocr INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0,
  text_bytes INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0,
  safety TEXT, created_at TEXT NOT NULL, captured_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT NOT NULL UNIQUE, doc_id TEXT NOT NULL, seq INTEGER NOT NULL,
  text TEXT NOT NULL, char_count INTEGER NOT NULL, PRIMARY KEY(doc_id, seq)
);
CREATE TABLE IF NOT EXISTS kb_fact_links (
  fact_id TEXT NOT NULL, doc_id TEXT NOT NULL, chunk_id TEXT,
  relation TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(fact_id, doc_id, relation)
);
CREATE TABLE IF NOT EXISTS kb_pages (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL, title TEXT NOT NULL,
  markdown TEXT NOT NULL, json TEXT NOT NULL, source_refs TEXT NOT NULL,
  inputs_sha256 TEXT NOT NULL, generated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated', deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_source_unique ON kb_documents(source_sha256) WHERE status='active' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_kb_source_active ON kb_documents(source_sha256) WHERE status='active' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_kb_client_status ON kb_documents(client_id, status);
CREATE INDEX IF NOT EXISTS idx_kb_matter_status ON kb_documents(matter_id, status);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_kb_fact_links_fact ON kb_fact_links(fact_id, doc_id);
CREATE INDEX IF NOT EXISTS idx_kb_pages_kind ON kb_pages(kind, subject_id);
`

function hasObject(store, name, types = ['table']) {
  const placeholders = types.map(() => '?').join(',')
  return Boolean(store.db.prepare('SELECT name FROM sqlite_master WHERE name = ? AND type IN (' + placeholders + ')').get(name, ...types))
}

function createKbFts(store, tokenizer) {
  const trigram = tokenizer === 'trigram' ? ", tokenize='trigram'" : ''
  store.db.exec("CREATE VIRTUAL TABLE kb_fts USING fts5(text, content='kb_chunks', content_rowid='rowid'" + trigram + ')')
  store.db.exec("CREATE VIRTUAL TABLE kb_pages_fts USING fts5(title, markdown, content='kb_pages', content_rowid='rowid'" + trigram + ')')
  const triggers = [
    `CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
      INSERT INTO kb_fts(rowid, text) VALUES (new.rowid, new.text);
    END`,
    `CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
      INSERT INTO kb_fts(kb_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END`,
    `CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
      INSERT INTO kb_fts(kb_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO kb_fts(rowid, text) VALUES (new.rowid, new.text);
    END`,
    `CREATE TRIGGER kb_pages_ai AFTER INSERT ON kb_pages BEGIN
      INSERT INTO kb_pages_fts(rowid, title, markdown) VALUES (new.rowid, new.title, new.markdown);
    END`,
    `CREATE TRIGGER kb_pages_ad AFTER DELETE ON kb_pages BEGIN
      INSERT INTO kb_pages_fts(kb_pages_fts, rowid, title, markdown) VALUES ('delete', old.rowid, old.title, old.markdown);
    END`,
    `CREATE TRIGGER kb_pages_au AFTER UPDATE ON kb_pages BEGIN
      INSERT INTO kb_pages_fts(kb_pages_fts, rowid, title, markdown) VALUES ('delete', old.rowid, old.title, old.markdown);
      INSERT INTO kb_pages_fts(rowid, title, markdown) VALUES (new.rowid, new.title, new.markdown);
    END`,
  ]
  for (const sql of triggers) store.db.exec(sql)
}

/** Ensure the frozen v22 KB objects exist (no-op when lib/sqlite.js owns them). */
export function ensureKbSchema(store) {
  if (!hasObject(store, 'kb_documents')) store.db.exec(KB_TABLES_DDL)
  if (!hasObject(store, 'kb_fts')) {
    try {
      createKbFts(store, 'trigram')
    } catch {
      for (const trigger of ['kb_chunks_ai', 'kb_chunks_ad', 'kb_chunks_au', 'kb_pages_ai', 'kb_pages_ad', 'kb_pages_au']) store.db.exec('DROP TRIGGER IF EXISTS ' + trigger)
      for (const table of ['kb_fts', 'kb_pages_fts']) store.db.exec('DROP TABLE IF EXISTS ' + table)
      createKbFts(store, 'unicode61')
    }
  }
}

/** Open a fresh temporary store with the KB schema present + a cleanup handle. */
export function createKbStore(prefix = 'advisers-kb-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const dbPath = join(root, 'state.db')
  const store = new SqliteStore(dbPath)
  ensureKbSchema(store)
  return {
    root,
    dbPath,
    store,
    writeFile(name, content) {
      const target = join(root, name)
      writeFileSync(target, content)
      return target
    },
    cleanup() {
      try { store.close() } catch {}
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    },
  }
}

import { rmSync } from 'node:fs'

const AT = '2026-01-01T00:00:00.000Z'

/**
 * One small deterministic ledger: ACME client + project + matter, a second
 * (secrecy 2) client/matter, one delivery, one client note and two facts.
 */
export function seedLedger(store) {
  store.mutate(() => {
    store.insertMatter({ id: 'm_acme', title: 'ACME website relaunch', status: 'active', domain: 'work', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: AT, updatedAt: AT })
    store.insertMatter({ id: 'm_secret', title: 'Secret acquisition', status: 'active', domain: 'work', secrecy: 2, participants: [], deadlines: [], openQuestions: [], createdAt: AT, updatedAt: AT })
    store.insertCommitment({ id: 'cm_acme', matterId: 'm_acme', debtor: 'user', creditor: 'ACME', action: 'send the website quote', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none', createdAt: '2026-01-02T00:00:00.000Z', dueAt: '2026-12-01T10:00:00+08:00' })
    store.insertCommitment({ id: 'cm_secret', matterId: 'm_secret', debtor: 'user', creditor: 'Target', action: 'draft the acquisition memo', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none', createdAt: '2026-01-03T00:00:00.000Z' })
    store.insertFact({ id: 'fact_quote', matterId: 'm_acme', subject: 'ACME', predicate: 'quote.total', object: '80000', recordedAt: '2026-01-01T00:00:00.000Z', authority: 'user', confidence: 0.9, evidence: [{ quote: 'budget is 80000', ref: 'conv#1' }], status: 'confirmed', validFrom: '2026-01-01T00:00:00.000Z' })
    store.insertFact({ id: 'fact_secret', matterId: 'm_secret', subject: 'Target', predicate: 'deal.status', object: 'confidential', recordedAt: '2026-01-01T00:00:00.000Z', authority: 'user', confidence: 0.9, evidence: [], status: 'confirmed', validFrom: '2026-01-01T00:00:00.000Z' })
  })
  const acme = store.addClient({ name: 'ACME', aliases: ['ACME Ltd'], tags: ['quote'] })
  const secret = store.addClient({ name: 'Secret Target', secrecyDefault: 2 })
  const project = store.addProject({ clientId: acme.id, name: 'Website relaunch', startedAt: '2026-01-01' })
  store.setMatterClient('m_acme', { clientId: acme.id, projectId: project.id })
  store.setMatterClient('m_secret', { clientId: secret.id })
  store.addDelivery({ matterId: 'm_acme', conversationId: 'conv-1', files: ['quote.pdf'], tool: 'deliver:quote', title: 'quote.pdf' })
  store.addClientNote({ clientId: acme.id, summary: '电话确认预算 8 万', kind: 'call', at: '2026-01-05T00:00:00.000Z' })
  return { acme, secret, project }
}

/** Minimal docx (the extractor only reads word/document.xml). */
export async function buildDocx(paragraphs) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  const body = paragraphs.map((paragraph) => '<w:p><w:r><w:t>' + paragraph.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</w:t></w:r></w:p>').join('')
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '</w:body></w:document>')
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** Minimal text-bearing PDF with one page per entry (no deps, no embedded fonts). */
export function buildPdfPages(texts) {
  const contents = texts.map((text) => 'BT /F1 12 Tf 72 720 Td (' + String(text).replace(/[()\\]/g, '') + ') Tj ET')
  const pageObjectIds = contents.map((_, index) => 3 + index * 2)
  const fontObjectId = 3 + contents.length * 2
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [' + pageObjectIds.map((id) => id + ' 0 R').join(' ') + '] /Count ' + contents.length + ' >>',
  ]
  for (let index = 0; index < contents.length; index += 1) {
    const contentId = pageObjectIds[index] + 1
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ' + fontObjectId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>')
    objects.push('<< /Length ' + contents[index].length + ' >>\nstream\n' + contents[index] + '\nendstream')
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += String(index + 1) + ' 0 obj\n' + object + '\nendobj\n'
  })
  const xref = pdf.length
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n'
  for (let index = 1; index <= objects.length; index += 1) pdf += String(offsets[index]).padStart(10, '0') + ' 00000 n \n'
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'
  return Buffer.from(pdf, 'latin1')
}

/** One-page convenience wrapper. */
export function buildPdf(text) {
  return buildPdfPages([text])
}

/** Minimal RFC 822 message with a UTF-8 quoted-printable-ish body. */
export function buildEml({ subject = 'Quote follow-up', from = 'acme@example.com', body = 'Please send the revised quote by Friday.' } = {}) {
  return ['From: ' + from, 'To: user@example.com', 'Subject: ' + subject, 'Date: Mon, 05 Jan 2026 09:00:00 +0800', 'Message-ID: <kb-test-1@example.com>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', body, ''].join('\r\n')
}

export { AT }
