/**
 * KB module (0.4.0, schema v22): local document ingestion plus deterministic
 * full-text retrieval over the already-opened SqliteStore.
 *
 * Product contract (45-kb-design.md, frozen for 0.4.0):
 * - L0 metadata + L1 extracted chunks live only in the local database; the
 *   source file is never copied and an absolute path is never stored or
 *   returned (source_name is the basename only);
 * - ingest is bounded and explicit: 50 MB file, 2 MB text, 2000 chunks, and
 *   every truncation is reported (truncated / truncatedBy / warnings);
 * - search is deterministic and offline: FTS5 trigram MATCH for every token
 *   with at least 3 code points, LIKE fallback for 2-character/short queries
 *   with degraded:['short_query_like'], LIKE when the index degraded to
 *   unicode61 or is unavailable; FTS syntax is never passed through (tokens are
 *   quoted/escaped, a query error falls back to LIKE instead of throwing);
 * - clearance is applied in SQL BEFORE counting/paging: effective secrecy is
 *   max(document.secrecy, client.secrecyDefault, matter.secrecy), an
 *   unresolvable owner fails closed, and hidden rows are only counted in
 *   protectedExcluded;
 * - snippets are at most KB_SNIPPET_CHARS code points and are sanitized
 *   (terminal escapes, C0/C1 controls and bidi marks removed); highlights are
 *   numeric offsets into the returned snippet, never HTML/Markdown markup;
 * - removal is honest: kb rm tombstones the document and really deletes its
 *   chunks (FTS triggers clear the index so MATCH returns 0), kb purge --yes
 *   is the physical delete;
 * - every write path commits exactly one audit row with counts/ids only (never
 *   a title, filename, path or quote).
 *
 * The caller owns the connection lifecycle and the CLI/MCP surface; this module
 * performs no HOME handling, no migration and no console output. It writes only
 * the v22 KB tables (the schema is owned by lib/sqlite.js).
 */
import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { entityError } from './sqlite.js'
import { sha256FileSync } from './backup.js'
import { chunkText, extractForIndex, KB_MAX_FILE_BYTES } from './kb-extract.js'
import { classify, safetyErrorFrom } from './safety/index.js'
import { stripBidiControls, stripControlChars, stripTerminalSequences } from './text-safe.js'

/** Document kinds accepted by kb add (45 section 3.4). */
export const KB_KINDS = Object.freeze(['quote', 'contract', 'receipt', 'delivery', 'note', 'other'])
/** Relations accepted by kb link. */
export const KB_RELATIONS = Object.freeze(['source', 'mentions'])
/** Local CLI default clearance; MCP/DSH callers must pass 0 until KB is exposed. */
export const KB_DEFAULT_CLEARANCE = 3
export const KB_LIST_LIMIT = 50
export const KB_LIST_LIMIT_MAX = 200
export const KB_SEARCH_LIMIT = 20
export const KB_SEARCH_LIMIT_MAX = 200
export const KB_QUERY_MAX_CHARS = 200
export const KB_MAX_BATCH_FILES = 200
/** One document is capped at this many chunks (45 section 3.3). */
export const KB_MAX_CHUNKS = 2000
export const KB_SNIPPET_CHARS = 240
export const KB_CHUNK_PREVIEW_CHARS = 400
/** Hard cap for the JS clearance pass over matched page rows. */
export const KB_PAGE_SCAN_MAX = 2000

const LIKE_CLAUSE = "LIKE ? ESCAPE '\\'"
const INSERT_DOCUMENT_SQL = 'INSERT INTO kb_documents(id,kind,title,client_id,project_id,matter_id,source_name,source_sha256,mime,size_bytes,encoding,extractor,status,secrecy,needs_ocr,truncated,text_bytes,chunk_count,safety,created_at,captured_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
const INSERT_CHUNK_SQL = 'INSERT INTO kb_chunks(id,doc_id,seq,text,char_count) VALUES(?,?,?,?,?)'

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString()
}

function newId(prefix) {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 16)
}

function codePointLength(value) {
  return [...String(value ?? '')].length
}

function clampLimit(value, fallback, max) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) return fallback
  return Math.min(number, max)
}

function normalizeClearance(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.floor(number)
}

function sanitizeLine(value, max = KB_SNIPPET_CHARS) {
  const text = stripControlChars(stripBidiControls(stripTerminalSequences(String(value ?? ''))), { keepNewlines: false, keepTabs: false, replacement: ' ' })
    .replace(/\s+/gu, ' ').trim()
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return chars.slice(0, max).join('')
}

function assertStore(store) {
  if (!store || !store.db || typeof store.db.prepare !== 'function' || typeof store.read !== 'function' || typeof store.mutate !== 'function') {
    throw new TypeError('kb requires an opened SqliteStore (KB tables are SQLite-only)')
  }
}

function hasSqliteObject(store, name, types = ['table']) {
  const placeholders = types.map(() => '?').join(',')
  const row = store.db.prepare('SELECT name FROM sqlite_master WHERE name = ? AND type IN (' + placeholders + ')').get(name, ...types)
  return Boolean(row)
}

/** Throw E_SCHEMA_STALE when the v22 KB tables are absent (pre-0.4 database). */
export function assertKbSchema(store) {
  assertStore(store)
  if (!hasSqliteObject(store, 'kb_documents')) {
    throw entityError('E_SCHEMA_STALE', 'KB tables are missing; open an upgraded database (schema v22)', 'advisers doctor')
  }
}

/** Tokenizer read back from the kb FTS DDL (null when the index is absent). */
export function kbFtsTokenizer(store, table = 'kb_fts') {
  assertStore(store)
  const row = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = ? AND type = 'table'").get(String(table))
  if (!row) return null
  return /tokenize\s*=\s*'?trigram/i.test(String(row.sql ?? '')) ? 'trigram' : 'unicode61'
}

function validateKind(value) {
  if (value === undefined || value === null || value === '') return 'other'
  const kind = String(value)
  if (!KB_KINDS.includes(kind)) throw entityError('E_KB_INVALID', 'unknown document kind: ' + kind, 'use one of ' + KB_KINDS.join(', '))
  return kind
}

function validateSecrecy(value) {
  if (value === undefined || value === null) return 0
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > 3) throw entityError('E_KB_INVALID', 'secrecy must be an integer between 0 and 3')
  return number
}

function validateTitle(value, fallback) {
  const raw = value === undefined || value === null || value === '' ? fallback : String(value)
  const title = sanitizeLine(raw, 200)
  if (!title) throw entityError('E_KB_INVALID', 'title is empty')
  return title
}

function titleFromName(name) {
  const base = basename(String(name ?? ''))
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base) || base
}

/** Resolve client/project/matter ownership against the live customer tables. */
function resolveOwner(store, { clientId, projectId, matterId } = {}) {
  let client = clientId === undefined || clientId === null ? null : String(clientId).trim() || null
  let project = projectId === undefined || projectId === null ? null : String(projectId).trim() || null
  let matter = matterId === undefined || matterId === null ? null : String(matterId).trim() || null
  let projectRow
  let matterRow
  if (project) {
    projectRow = typeof store.getProject === 'function' ? store.getProject(project) : undefined
    if (!projectRow || projectRow.deletedAt) throw entityError('E_PROJECT_NOT_FOUND', 'unknown project: ' + project, 'advisers project ls')
    if (!client) client = projectRow.clientId
    else if (projectRow.clientId !== client) throw entityError('E_PROJECT_CLIENT_MISMATCH', 'project ' + project + ' belongs to client ' + projectRow.clientId)
  }
  if (matter) {
    matterRow = typeof store.getMatter === 'function' ? store.getMatter(matter) : undefined
    if (!matterRow) throw entityError('E_MATTER_NOT_FOUND', 'unknown matter: ' + matter, 'advisers matter ls')
    if (!client && matterRow.clientId) client = matterRow.clientId
    else if (client && matterRow.clientId && matterRow.clientId !== client) throw entityError('E_MATTER_CLIENT_MISMATCH', 'matter ' + matter + ' belongs to client ' + matterRow.clientId)
    if (!project && matterRow.projectId) project = matterRow.projectId
  }
  if (client) {
    const clientRow = typeof store.getClient === 'function' ? store.getClient(client) : undefined
    if (!clientRow || clientRow.deletedAt) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + client, 'advisers client ls')
  }
  return { clientId: client, projectId: project, matterId: matter }
}

function duplicateError(existingId, name) {
  const error = entityError('E_KB_DUPLICATE', 'document already indexed: ' + name, 'use --replace to re-index it')
  error.existingId = existingId
  error.skip = true
  error.file = name
  return error
}

function findActiveBySha(store, sha256) {
  return store.db.prepare("SELECT * FROM kb_documents WHERE source_sha256 = ? AND status = 'active' AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get(String(sha256))
}

function classifyIndexText(text, hmacKey) {
  const safety = classify(String(text ?? '').slice(0, 100_000), { surface: 'attachment', hmacKey })
  if (safety.action === 'block') throw safetyErrorFrom(safety, { surface: 'attachment' })
  return {
    action: safety.action,
    code: safety.code ?? null,
    categories: Array.isArray(safety.categories) ? [...safety.categories] : [],
    ruleIds: Array.isArray(safety.ruleIds) ? [...safety.ruleIds] : [],
    severity: safety.severity,
    crisis: Boolean(safety.crisis),
    downgraded: Boolean(safety.downgraded),
    rulesetVersion: safety.rulesetVersion,
    evidenceHash: safety.evidenceHash ?? null,
  }
}

function safetyJson(safety) {
  try { return safety ? JSON.stringify(safety) : null } catch { return null }
}

/** Public snake_case row -> JSON-ready camelCase document (no paths ever). */
export function mapKbDocumentRow(row) {
  if (!row) return null
  return {
    id: String(row.id),
    kind: String(row.kind),
    title: String(row.title),
    status: String(row.status),
    ...(row.client_id === null || row.client_id === undefined ? {} : { clientId: String(row.client_id) }),
    ...(row.project_id === null || row.project_id === undefined ? {} : { projectId: String(row.project_id) }),
    ...(row.matter_id === null || row.matter_id === undefined ? {} : { matterId: String(row.matter_id) }),
    ...(row.source_name === null || row.source_name === undefined ? {} : { sourceName: String(row.source_name) }),
    sourceSha256: String(row.source_sha256),
    ...(row.mime === null || row.mime === undefined ? {} : { mime: String(row.mime) }),
    sizeBytes: Number(row.size_bytes ?? 0),
    ...(row.encoding === null || row.encoding === undefined ? {} : { encoding: String(row.encoding) }),
    extractor: String(row.extractor),
    secrecy: Number(row.secrecy ?? 0),
    needsOcr: Boolean(row.needs_ocr),
    truncated: Boolean(row.truncated),
    textBytes: Number(row.text_bytes ?? 0),
    chunkCount: Number(row.chunk_count ?? 0),
    createdAt: String(row.created_at),
    capturedAt: String(row.captured_at),
    ...(row.deleted_at === null || row.deleted_at === undefined ? {} : { deletedAt: String(row.deleted_at) }),
  }
}

/* -------------------------------------------------------------------------- */
/* clearance SQL (filter BEFORE counting/paging)                              */
/* -------------------------------------------------------------------------- */

function ownershipValidSql(alias) {
  return '(((' + alias + '.client_id IS NULL) OR EXISTS (SELECT 1 FROM clients c1 WHERE c1.id = ' + alias + '.client_id))'
    + ' AND ((' + alias + '.matter_id IS NULL) OR EXISTS (SELECT 1 FROM matters m1 WHERE m1.id = ' + alias + '.matter_id)))'
}

function effectiveSecrecySql(alias) {
  return 'MAX(COALESCE(' + alias + '.secrecy, 0),'
    + ' COALESCE((SELECT c2.secrecy_default FROM clients c2 WHERE c2.id = ' + alias + '.client_id), 0),'
    + ' COALESCE((SELECT m2.secrecy FROM matters m2 WHERE m2.id = ' + alias + '.matter_id), 0))'
}

function docFiltersSql(alias, filters = {}) {
  const clauses = []
  const params = []
  if (filters.clientId !== undefined && filters.clientId !== null) { clauses.push(alias + '.client_id = ?'); params.push(String(filters.clientId)) }
  if (filters.projectId !== undefined && filters.projectId !== null) { clauses.push(alias + '.project_id = ?'); params.push(String(filters.projectId)) }
  if (filters.matterId !== undefined && filters.matterId !== null) { clauses.push(alias + '.matter_id = ?'); params.push(String(filters.matterId)) }
  if (filters.kind !== undefined && filters.kind !== null) {
    const kind = String(filters.kind)
    if (!KB_KINDS.includes(kind)) throw entityError('E_KB_INVALID', 'unknown document kind: ' + kind)
    clauses.push(alias + '.kind = ?')
    params.push(kind)
  }
  return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params }
}

function scopedDocumentWhere(filters, clearance, { withClearance = true } = {}) {
  const filter = docFiltersSql('d', filters)
  const sql = "d.status = 'active' AND d.deleted_at IS NULL AND " + ownershipValidSql('d')
    + (withClearance ? ' AND ' + effectiveSecrecySql('d') + ' <= ?' : '') + filter.sql
  return { sql, params: withClearance ? [normalizeClearance(clearance), ...filter.params] : [...filter.params] }
}

/* -------------------------------------------------------------------------- */
/* kb add                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Index one local file. Throws typed E_KB_* errors; a duplicate is a skip-level
 * E_KB_DUPLICATE carrying .existingId (the batch helper turns it into skipped).
 *
 * @param {object} store opened writable SqliteStore
 * @param {{file: string, cwd?: string, title?: string, kind?: string, clientId?: string,
 *   projectId?: string, matterId?: string, secrecy?: number, replace?: boolean,
 *   hmacKey?: string|Buffer}} options
 * @returns {Promise<object>} JSON-ready {ok, command, document, counts, ...}
 */
export async function kbAdd(store, options = {}) {
  assertKbSchema(store)
  const { file, cwd = process.cwd(), title, kind, clientId, projectId, matterId, secrecy, replace = false, hmacKey } = options
  if (typeof file !== 'string' || !file.trim()) throw entityError('E_KB_INVALID', 'file path is required')
  const absPath = resolve(cwd, file)
  const name = basename(absPath)
  let info
  try {
    info = lstatSync(absPath)
  } catch (error) {
    throw entityError('E_KB_READ', 'cannot read file ' + name + ' (' + String(error?.code ?? 'ENOENT') + ')', 'check that the path exists and is readable')
  }
  if (info.isSymbolicLink()) throw entityError('E_KB_INVALID', 'symbolic links are not indexed: ' + name)
  if (!info.isFile()) throw entityError('E_KB_INVALID', 'not a regular file: ' + name)
  if (info.size > KB_MAX_FILE_BYTES) throw entityError('E_KB_TOO_LARGE', 'file is larger than the 50 MB KB limit: ' + name)
  const kindValue = validateKind(kind)
  const secrecyValue = validateSecrecy(secrecy)
  const titleValue = validateTitle(title, titleFromName(name))
  const owner = resolveOwner(store, { clientId, projectId, matterId })
  let hashed
  try {
    hashed = sha256FileSync(absPath)
  } catch (error) {
    throw entityError('E_KB_READ', 'cannot hash file ' + name + ' (' + String(error?.code ?? 'EIO') + ')', 'check the file permissions and retry')
  }
  const existing = findActiveBySha(store, hashed.sha256)
  if (existing && !replace) throw duplicateError(existing.id, name)
  let extraction
  try {
    extraction = await extractForIndex(absPath)
  } catch (error) {
    if (error?.code) throw error
    throw entityError('E_KB_INVALID', 'cannot extract text from ' + name + ': ' + failureMessage(error), 'check that the file is not corrupt')
  }
  const safety = extraction.needsOcr && !extraction.text ? null : classifyIndexText(extraction.text, hmacKey)
  const chunked = chunkText(extraction.text, { maxChunks: KB_MAX_CHUNKS })
  const truncated = Boolean(extraction.truncated || chunked.truncated)
  const docId = newId('kb_')
  const capturedAt = nowIso()
  const inserted = store.mutate(() => {
    const duplicate = findActiveBySha(store, hashed.sha256)
    if (duplicate && !replace) throw duplicateError(duplicate.id, name)
    if (duplicate) {
      store.db.prepare("UPDATE kb_documents SET status = 'deleted', deleted_at = ? WHERE id = ?").run(capturedAt, duplicate.id)
      store.db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(duplicate.id)
    }
    store.db.prepare(INSERT_DOCUMENT_SQL).run(
      docId, kindValue, titleValue, owner.clientId, owner.projectId, owner.matterId,
      String(extraction.sourceName), hashed.sha256, extraction.mime, Number(extraction.sizeBytes),
      extraction.encoding, extraction.extractor, 'active', secrecyValue,
      extraction.needsOcr ? 1 : 0, truncated ? 1 : 0, Number(extraction.textBytes),
      chunked.chunks.length, safetyJson(safety), capturedAt, capturedAt, null,
    )
    const insertChunk = store.db.prepare(INSERT_CHUNK_SQL)
    for (const chunk of chunked.chunks) {
      insertChunk.run('chk_' + randomUUID().replace(/-/g, '').slice(0, 16), docId, chunk.seq, chunk.text, chunk.charCount)
    }
    return { replacedId: duplicate ? duplicate.id : null }
  }, {
    actor: 'local',
    action: 'kb.add',
    allowed: true,
    reason: 'doc ' + docId + ', ' + chunked.chunks.length + ' chunks, ' + Number(extraction.textBytes) + ' bytes' + (replace ? ' (replace)' : ''),
  })
  const row = store.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId)
  return {
    ok: true,
    command: 'kb add',
    document: mapKbDocumentRow(row),
    counts: { added: 1, chunks: chunked.chunks.length, textBytes: Number(extraction.textBytes) },
    truncated,
    truncatedBy: [...extraction.truncatedBy, ...(chunked.truncated ? ['chunk_limit'] : [])],
    needsOcr: Boolean(extraction.needsOcr),
    encoding: extraction.encoding,
    extractor: extraction.extractor,
    warnings: [...extraction.warnings],
    ...(inserted.result.replacedId ? { replacedId: inserted.result.replacedId } : {}),
  }
}

function failureMessage(error) {
  const raw = error?.code ? String(error.message ?? '') : String(error?.message ?? error)
  const text = stripControlChars(stripTerminalSequences(raw), { keepNewlines: false, keepTabs: false, replacement: ' ' }).replace(/\s+/gu, ' ').trim()
  return Array.from(text).slice(0, 300).join('')
}

/**
 * Index a batch of files, aggregating per-file outcomes into the CLI JSON shape.
 * A duplicate is skipped (ok:false only when every file failed).
 */
export async function kbAddMany(store, options = {}) {
  const { files, ...rest } = options
  if (!Array.isArray(files) || files.length === 0) throw entityError('E_KB_INVALID', 'at least one file is required')
  if (files.length > KB_MAX_BATCH_FILES) throw entityError('E_KB_LIMIT', 'at most ' + KB_MAX_BATCH_FILES + ' files per batch')
  const added = []
  const skipped = []
  const failed = []
  let chunks = 0
  let textBytes = 0
  for (const file of files) {
    const fileName = basename(String(file))
    try {
      const result = await kbAdd(store, { ...rest, file })
      added.push(result.document)
      chunks += result.counts.chunks
      textBytes += result.counts.textBytes
    } catch (error) {
      if (error?.code === 'E_KB_DUPLICATE') {
        skipped.push({ file: fileName, code: 'E_KB_DUPLICATE', existingId: error.existingId ?? null })
      } else {
        failed.push({ file: fileName, code: error?.code ?? 'E_INTERNAL', message: failureMessage(error) })
      }
    }
  }
  return {
    ok: added.length > 0 || failed.length === 0,
    command: 'kb add',
    counts: { added: added.length, skipped: skipped.length, failed: failed.length, chunks, textBytes },
    added,
    skipped,
    failed,
  }
}

/* -------------------------------------------------------------------------- */
/* kb ls / kb show                                                            */
/* -------------------------------------------------------------------------- */

/**
 * List documents with the clearance filter applied before counting/paging.
 * Default is active documents; all:true includes tombstones.
 */
export function kbList(store, options = {}) {
  assertKbSchema(store)
  const { clientId, projectId, matterId, kind, all = false, limit, clearance } = options
  const level = normalizeClearance(clearance === undefined ? KB_DEFAULT_CLEARANCE : clearance)
  const pageLimit = clampLimit(limit, KB_LIST_LIMIT, KB_LIST_LIMIT_MAX)
  const statusSql = all === true ? '1 = 1' : "d.status = 'active' AND d.deleted_at IS NULL"
  const filter = docFiltersSql('d', { clientId, projectId, matterId, kind })
  const ownership = ownershipValidSql('d')
  const effective = effectiveSecrecySql('d')
  return store.read(() => {
    const visibleWhere = statusSql + ' AND ' + ownership + ' AND ' + effective + ' <= ?' + filter.sql
    const probeWhere = statusSql + ' AND ' + ownership + filter.sql
    const visibleParams = [level, ...filter.params]
    const total = Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_documents d WHERE ' + visibleWhere).get(...visibleParams)?.n ?? 0)
    const probeTotal = Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_documents d WHERE ' + probeWhere).get(...filter.params)?.n ?? 0)
    const rows = store.db.prepare('SELECT d.* FROM kb_documents d WHERE ' + visibleWhere + ' ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?')
      .all(...visibleParams, pageLimit)
    return {
      ok: true,
      command: 'kb ls',
      documents: rows.map(mapKbDocumentRow),
      total,
      truncated: total > rows.length,
      limit: pageLimit,
      clearance: level,
      protectedExcluded: Math.max(0, probeTotal - total),
    }
  })
}

/** One document plus (optionally) a bounded chunk preview. */
export function kbShow(store, id, options = {}) {
  assertKbSchema(store)
  const key = typeof id === 'string' ? id.trim() : ''
  if (!key) throw entityError('E_KB_INVALID', 'document id is required')
  const clearance = normalizeClearance(options.clearance === undefined ? KB_DEFAULT_CLEARANCE : options.clearance)
  const chunkLimit = clampLimit(options.chunks, 0, 20)
  return store.read(() => {
    const row = store.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(key)
    if (!row || row.status !== 'active' || row.deleted_at !== null) throw entityError('E_KB_NOT_FOUND', 'unknown document: ' + key, 'advisers kb ls')
    const level = Number(store.db.prepare('SELECT ' + effectiveSecrecySql('d') + ' AS secrecy FROM kb_documents d WHERE d.id = ?').get(key)?.secrecy ?? Number.POSITIVE_INFINITY)
    if (!Number.isFinite(level) || level > clearance) throw entityError('E_KB_NOT_FOUND', 'unknown document: ' + key)
    const chunks = []
    let chunksTotal = 0
    if (chunkLimit > 0) {
      const rows = store.db.prepare('SELECT id, seq, text, char_count FROM kb_chunks WHERE doc_id = ? ORDER BY seq LIMIT ?').all(key, chunkLimit)
      for (const chunk of rows) {
        const text = Array.from(String(chunk.text ?? ''))
        const preview = text.slice(0, KB_CHUNK_PREVIEW_CHARS).join('')
        chunks.push({ id: String(chunk.id), seq: Number(chunk.seq), charCount: Number(chunk.char_count), text: sanitizeLine(preview, KB_CHUNK_PREVIEW_CHARS), truncated: text.length > KB_CHUNK_PREVIEW_CHARS })
      }
      chunksTotal = Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?').get(key)?.n ?? 0)
    }
    return { ok: true, command: 'kb show', document: mapKbDocumentRow(row), chunks, chunksTotal, clearance }
  })
}
/* -------------------------------------------------------------------------- */
/* kb rm / kb purge                                                           */
/* -------------------------------------------------------------------------- */

/** Tombstone one document and physically delete its chunks (searchable -> 0). */
export function kbRm(store, id) {
  assertKbSchema(store)
  const key = typeof id === 'string' ? id.trim() : ''
  if (!key) throw entityError('E_KB_INVALID', 'document id is required')
  const audit = { actor: 'local', action: 'kb.rm', allowed: true, reason: '' }
  const outcome = store.mutate(() => {
    const row = store.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(key)
    if (!row || row.status !== 'active' || row.deleted_at !== null) throw entityError('E_KB_NOT_FOUND', 'unknown document: ' + key, 'advisers kb ls')
    const chunks = Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?').get(key)?.n ?? 0)
    store.db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(key)
    store.db.prepare("UPDATE kb_documents SET status = 'deleted', deleted_at = ? WHERE id = ?").run(nowIso(), key)
    audit.reason = 'doc ' + key + ', ' + chunks + ' chunks removed'
    return { document: mapKbDocumentRow(store.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(key)), chunks }
  }, audit)
  return { ok: true, command: 'kb rm', removed: true, document: outcome.result.document, counts: { chunks: outcome.result.chunks } }
}

/**
 * purge one document: dry-run by default (yes:false), physical delete with
 * yes:true. Deleting chunks clears the FTS entries through the sync triggers.
 */
export function kbPurge(store, id, options = {}) {
  assertKbSchema(store)
  const key = typeof id === 'string' ? id.trim() : ''
  if (!key) throw entityError('E_KB_INVALID', 'document id is required')
  const yes = options.yes === true
  if (!yes) {
    return store.read(() => {
      const row = store.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(key)
      if (!row) throw entityError('E_KB_NOT_FOUND', 'unknown document: ' + key, 'advisers kb ls')
      const chunks = Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?').get(key)?.n ?? 0)
      const factLinks = Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_fact_links WHERE doc_id = ?').get(key)?.n ?? 0)
      return { ok: true, command: 'kb purge', dryRun: true, purged: false, document: mapKbDocumentRow(row), counts: { chunks, factLinks }, hint: 'pass --yes to delete permanently' }
    })
  }
  const audit = { actor: 'local', action: 'kb.purge', allowed: true, reason: '' }
  const outcome = store.mutate(() => {
    const row = store.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(key)
    if (!row) throw entityError('E_KB_NOT_FOUND', 'unknown document: ' + key, 'advisers kb ls')
    const chunks = Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?').get(key)?.n ?? 0)
    const factLinks = Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_fact_links WHERE doc_id = ?').get(key)?.n ?? 0)
    store.db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(key)
    store.db.prepare('DELETE FROM kb_fact_links WHERE doc_id = ?').run(key)
    store.db.prepare('DELETE FROM kb_documents WHERE id = ?').run(key)
    audit.reason = 'doc ' + key + ', ' + chunks + ' chunks, ' + factLinks + ' links'
    return { counts: { chunks, factLinks }, document: mapKbDocumentRow(row) }
  }, audit)
  return { ok: true, command: 'kb purge', dryRun: false, purged: true, document: outcome.result.document, counts: { chunks: outcome.result.counts.chunks, factLinks: outcome.result.counts.factLinks } }
}

/* -------------------------------------------------------------------------- */
/* kb reindex / verify                                                        */
/* -------------------------------------------------------------------------- */

const KB_FTS_SPECS = Object.freeze([
  { name: 'kb_fts', source: 'kb_chunks', triggers: ['kb_chunks_ai', 'kb_chunks_ad', 'kb_chunks_au'] },
  { name: 'kb_pages_fts', source: 'kb_pages', triggers: ['kb_pages_ai', 'kb_pages_ad', 'kb_pages_au'] },
])

/** External-content FTS integrity: presence, triggers, count parity, byte check. */
export function verifyKbFts(store) {
  assertKbSchema(store)
  const report = { ok: true, tokenizer: kbFtsTokenizer(store), degraded: [], tables: {} }
  for (const spec of KB_FTS_SPECS) {
    const entry = { present: false, ok: false, source: spec.source, triggers: false, count: 0, sourceCount: 0, error: null }
    entry.present = hasSqliteObject(store, spec.name)
    if (!entry.present) {
      entry.error = 'index missing'
      report.ok = false
      report.degraded.push('fts_unavailable')
      report.tables[spec.name] = entry
      continue
    }
    try { entry.sourceCount = Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + spec.source).get()?.n ?? 0) } catch (error) { entry.error = String(error?.message ?? error).slice(0, 200) }
    // The FTS5 shadow table (<name>_docsize) holds one row per indexed row;
    // counting the virtual table itself reads through external content and
    // cannot see a lost index. rank=1 makes integrity-check compare the index
    // against kb_chunks / kb_pages (not just internal consistency).
    try { entry.count = Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + spec.name + '_docsize').get()?.n ?? 0) } catch (error) { entry.error = String(error?.message ?? error).slice(0, 200) }
    entry.triggers = spec.triggers.every((trigger) => hasSqliteObject(store, trigger, ['trigger']))
    entry.ok = entry.error === null && entry.triggers
    if (entry.ok) {
      try {
        store.db.prepare('INSERT INTO ' + spec.name + '(' + spec.name + ", rank) VALUES('integrity-check', 1)").run()
      } catch (error) {
        entry.ok = false
        entry.error = String(error?.message ?? error).slice(0, 200)
      }
    }
    if (entry.ok && entry.count !== entry.sourceCount) {
      entry.ok = false
      entry.error = 'index count ' + entry.count + ' != source count ' + entry.sourceCount
    }
    if (!entry.ok) report.ok = false
    report.tables[spec.name] = entry
  }
  if (report.tokenizer === 'unicode61') report.degraded.push('fts_unicode61')
  report.degraded = [...new Set(report.degraded)].sort()
  return report
}

/**
 * Verify (default) or rebuild the two KB FTS indexes. Rebuilding re-indexes
 * kb_chunks / kb_pages rows only; the source file is never re-read (its path is
 * not stored). Writes exactly one audit row when anything is rebuilt.
 */
export function kbReindex(store, options = {}) {
  assertKbSchema(store)
  const force = options.rebuild === true
  let integrity = verifyKbFts(store)
  const needed = force || !integrity.ok
  const rebuilt = []
  if (needed) {
    const audit = { actor: 'local', action: 'kb.reindex', allowed: true, reason: '' }
    store.mutate(() => {
      for (const spec of KB_FTS_SPECS) {
        if (!hasSqliteObject(store, spec.name)) continue
        store.db.exec("INSERT INTO " + spec.name + '(' + spec.name + ") VALUES('rebuild')")
        rebuilt.push(spec.name)
      }
      audit.reason = 'rebuilt ' + rebuilt.length + ' index(es): ' + rebuilt.join(',')
    }, audit)
    integrity = verifyKbFts(store)
  }
  const counts = {
    documents: Number(store.db.prepare("SELECT COUNT(*) AS n FROM kb_documents WHERE status = 'active' AND deleted_at IS NULL").get()?.n ?? 0),
    chunks: Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_chunks').get()?.n ?? 0),
    pages: Number(store.db.prepare("SELECT COUNT(*) AS n FROM kb_pages WHERE status = 'generated' AND deleted_at IS NULL").get()?.n ?? 0),
  }
  return { ok: integrity.ok, command: 'kb reindex', rebuilt, integrity, counts, degraded: integrity.degraded }
}

/* -------------------------------------------------------------------------- */
/* kb link / unlink (explicit fact <-> document provenance)                    */
/* -------------------------------------------------------------------------- */

function assertActiveDocument(store, docId) {
  const row = store.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(String(docId))
  if (!row || row.status !== 'active' || row.deleted_at !== null) throw entityError('E_KB_NOT_FOUND', 'unknown document: ' + String(docId), 'advisers kb ls')
  return row
}

/** Link one fact to one document (and optionally a chunk). */
export function kbLink(store, { docId, factId, relation = 'source', chunkId = null } = {}) {
  assertKbSchema(store)
  const doc = String(docId ?? '').trim()
  const fact = String(factId ?? '').trim()
  if (!doc) throw entityError('E_KB_INVALID', 'document id is required')
  if (!fact) throw entityError('E_KB_INVALID', 'fact id is required')
  const rel = String(relation)
  if (!KB_RELATIONS.includes(rel)) throw entityError('E_KB_INVALID', 'unknown relation: ' + rel, 'use one of ' + KB_RELATIONS.join(', '))
  const audit = { actor: 'local', action: 'kb.link', allowed: true, reason: '' }
  const outcome = store.mutate(() => {
    assertActiveDocument(store, doc)
    const factRow = typeof store.getFact === 'function' ? store.getFact(fact) : undefined
    if (!factRow) throw entityError('E_FACT_NOT_FOUND', 'unknown fact: ' + fact, 'advisers fact ls')
    let chunk = null
    if (chunkId !== null && chunkId !== undefined && chunkId !== '') {
      const chunkRow = store.db.prepare('SELECT id FROM kb_chunks WHERE id = ? AND doc_id = ?').get(String(chunkId), doc)
      if (!chunkRow) throw entityError('E_KB_INVALID', 'chunk does not belong to the document: ' + String(chunkId))
      chunk = String(chunkId)
    }
    const createdAt = nowIso()
    store.db.prepare('INSERT OR REPLACE INTO kb_fact_links(fact_id, doc_id, chunk_id, relation, created_at) VALUES(?,?,?,?,?)').run(fact, doc, chunk, rel, createdAt)
    audit.reason = 'fact ' + fact + ' -> doc ' + doc + ' (' + rel + ')'
    return { factId: fact, docId: doc, chunkId: chunk, relation: rel, createdAt }
  }, audit)
  return { ok: true, command: 'kb link', link: outcome.result }
}

/** Remove one explicit fact <-> document link (idempotent; returns removed count). */
export function kbUnlink(store, { docId, factId, relation = null } = {}) {
  assertKbSchema(store)
  const doc = String(docId ?? '').trim()
  const fact = String(factId ?? '').trim()
  if (!doc) throw entityError('E_KB_INVALID', 'document id is required')
  if (!fact) throw entityError('E_KB_INVALID', 'fact id is required')
  const audit = { actor: 'local', action: 'kb.unlink', allowed: true, reason: '' }
  const outcome = store.mutate(() => {
    assertActiveDocument(store, doc)
    const removed = relation === null || relation === undefined
      ? Number(store.db.prepare('DELETE FROM kb_fact_links WHERE fact_id = ? AND doc_id = ?').run(fact, doc).changes ?? 0)
      : Number(store.db.prepare('DELETE FROM kb_fact_links WHERE fact_id = ? AND doc_id = ? AND relation = ?').run(fact, doc, String(relation)).changes ?? 0)
    audit.reason = 'fact ' + fact + ' x doc ' + doc + ': ' + removed + ' link(s)'
    return removed
  }, audit)
  return { ok: true, command: 'kb unlink', removed: Number(outcome.result ?? 0) }
}

/* -------------------------------------------------------------------------- */
/* search                                                                     */
/* -------------------------------------------------------------------------- */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

function hasCjk(text) {
  return CJK_RE.test(String(text ?? ''))
}

function likePattern(token) {
  return '%' + String(token).replace(/[\\%_]/g, (char) => '\\' + char) + '%'
}

/**
 * Decide MATCH vs LIKE for one query. Matches 45 section 3.5:
 * trigram + every token >= 3 code points -> MATCH; otherwise LIKE with an
 * explicit degraded reason (never a silent behavioral switch).
 */
export function selectKbSearchPlan(store, tokens, table = 'kb_fts') {
  const tokenizer = kbFtsTokenizer(store, table)
  const degraded = []
  if (!Array.isArray(tokens) || tokens.length === 0) return { mode: 'like', degraded }
  if (tokenizer === null) { degraded.push('fts_unavailable'); return { mode: 'like', degraded } }
  if (tokenizer === 'trigram') {
    if (tokens.some((token) => codePointLength(token) < 3)) { degraded.push('short_query_like'); return { mode: 'like', degraded } }
    const ftsQuery = tokens.map((token) => '"' + String(token).replace(/"/g, ' ') + '"').join(' AND ')
    return { mode: 'match', ftsQuery, degraded }
  }
  if (tokens.some((token) => hasCjk(token))) degraded.push('fts_unicode61')
  if (tokens.some((token) => codePointLength(token) < 3)) degraded.push('short_query_like')
  return { mode: 'like', degraded }
}

/** Sanitize a query: strip C0/C1 controls, collapse whitespace, cap length. */
export function normalizeKbQuery(query) {
  if (typeof query !== 'string') throw entityError('E_KB_INVALID', 'search query is required')
  const cleaned = stripControlChars(query, { keepNewlines: false, keepTabs: false, replacement: ' ' }).replace(/\s+/gu, ' ').trim()
  if (!cleaned) throw entityError('E_USAGE', 'search query is empty')
  if (codePointLength(cleaned) > KB_QUERY_MAX_CHARS) throw entityError('E_QUERY_TOO_LONG', 'search query is longer than ' + KB_QUERY_MAX_CHARS + ' characters')
  const tokens = cleaned.split(' ').filter(Boolean)
  if (tokens.length === 0) throw entityError('E_USAGE', 'search query is empty')
  return { query: cleaned, tokens }
}

/**
 * Build a bounded, sanitized snippet plus numeric highlight ranges.
 * highlights offsets are UTF-16 code-unit indexes into the returned snippet
 * (String.slice semantics); callers render highlights themselves, never as
 * injected HTML/Markdown.
 */
export function makeSnippet(text, tokens) {
  const cleaned = stripControlChars(stripBidiControls(stripTerminalSequences(String(text ?? ''))), { keepNewlines: false, keepTabs: false, replacement: ' ' })
    .replace(/\s+/gu, ' ').trim()
  if (!cleaned) return { snippet: '', highlights: [] }
  const lowered = cleaned.toLowerCase()
  const comparable = lowered.length === cleaned.length ? lowered : cleaned
  const needles = tokens.map((token) => String(token).toLowerCase()).filter(Boolean)
  let anchor = -1
  for (const needle of needles) {
    const index = comparable.indexOf(needle)
    if (index !== -1 && (anchor === -1 || index < anchor)) anchor = index
  }
  const chars = Array.from(cleaned)
  const charIndex = anchor <= 0 ? 0 : Array.from(cleaned.slice(0, anchor)).length
  let start = charIndex > 100 ? charIndex - 80 : 0
  let windowChars = chars.slice(start, start + KB_SNIPPET_CHARS)
  if (windowChars.length < KB_SNIPPET_CHARS && chars.length > KB_SNIPPET_CHARS) {
    start = Math.max(0, chars.length - KB_SNIPPET_CHARS)
    windowChars = chars.slice(start, start + KB_SNIPPET_CHARS)
  }
  const snippet = windowChars.join('')
  const snippetLower = snippet.toLowerCase()
  const haystack = snippetLower.length === snippet.length ? snippetLower : snippet
  const ranges = []
  for (const needle of needles) {
    let from = 0
    for (let count = 0; count < 8; count += 1) {
      const index = haystack.indexOf(needle, from)
      if (index === -1) break
      ranges.push({ start: index, end: index + needle.length })
      from = index + needle.length
    }
  }
  ranges.sort((a, b) => (a.start - b.start) || (a.end - b.end))
  const highlights = []
  for (const range of ranges) {
    const last = highlights[highlights.length - 1]
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else highlights.push({ start: range.start, end: range.end })
  }
  return { snippet, highlights }
}

function countRows(store, sql, params) {
  return Number(store.db.prepare(sql).get(...params)?.n ?? 0)
}

function loadScopeMaps(store) {
  const clients = new Map(store.db.prepare('SELECT id, secrecy_default FROM clients').all().map((row) => [String(row.id), Number(row.secrecy_default ?? 0)]))
  const matters = new Map(store.db.prepare('SELECT id, secrecy, client_id FROM matters').all().map((row) => [String(row.id), { secrecy: Number(row.secrecy ?? 0), clientId: row.client_id === null || row.client_id === undefined ? null : String(row.client_id) }]))
  const projects = new Map(store.db.prepare('SELECT id, client_id FROM projects').all().map((row) => [String(row.id), row.client_id === null || row.client_id === undefined ? null : String(row.client_id)]))
  return { clients, matters, projects }
}

function pageOwner(row, maps) {
  let data = null
  try { data = JSON.parse(String(row.json ?? '')) } catch { data = null }
  if (data && data.owner && typeof data.owner === 'object') {
    return {
      clientId: data.owner.clientId === undefined || data.owner.clientId === null ? null : String(data.owner.clientId),
      matterId: data.owner.matterId === undefined || data.owner.matterId === null ? null : String(data.owner.matterId),
    }
  }
  const kind = String(row.kind)
  if (kind === 'client' || kind === 'timeline') return { clientId: String(row.subject_id), matterId: null }
  if (kind === 'project') {
    const clientId = maps.projects.get(String(row.subject_id))
    return clientId === undefined ? null : { clientId, matterId: null }
  }
  return null
}

function ownerSecrecy(maps, owner) {
  if (!owner) return Number.POSITIVE_INFINITY
  let level = 0
  if (owner.clientId) {
    const value = maps.clients.get(String(owner.clientId))
    if (value === undefined) return Number.POSITIVE_INFINITY
    level = Math.max(level, value)
  }
  if (owner.matterId) {
    const matter = maps.matters.get(String(owner.matterId))
    if (!matter) return Number.POSITIVE_INFINITY
    level = Math.max(level, matter.secrecy)
    if (matter.clientId) {
      const value = maps.clients.get(String(matter.clientId))
      if (value === undefined) return Number.POSITIVE_INFINITY
      level = Math.max(level, value)
    }
  }
  return level
}

function documentHitFromRow(row, tokens, matchPath, score) {
  const hit = {
    kind: 'kb_chunk',
    ref: { kind: 'kb_chunk', id: String(row.chunk_id) },
    docId: String(row.doc_id),
    title: sanitizeLine(row.doc_title, 200),
    snippet: '',
    highlights: [],
    matchPath,
    at: String(row.created_at ?? ''),
  }
  const snippet = makeSnippet(row.chunk_text, tokens)
  hit.snippet = snippet.snippet
  hit.highlights = snippet.highlights
  if (row.client_id !== null && row.client_id !== undefined) hit.clientId = String(row.client_id)
  if (row.project_id !== null && row.project_id !== undefined) hit.projectId = String(row.project_id)
  if (row.matter_id !== null && row.matter_id !== undefined) hit.matterId = String(row.matter_id)
  if (score !== undefined && score !== null && Number.isFinite(Number(score))) hit.score = Number(score)
  return hit
}

function searchDocuments(store, tokens, state, { limit, clearance, filters }) {
  const patterns = tokens.map(likePattern)
  const titleAnd = tokens.map(() => 'd.title ' + LIKE_CLAUSE).join(' AND ')
  const chunkAnd = tokens.map(() => 'c.text ' + LIKE_CLAUSE).join(' AND ')
  const visible = scopedDocumentWhere(filters, clearance)
  const probe = scopedDocumentWhere(filters, clearance, { withClearance: false })

  const titleTotal = countRows(store, 'SELECT COUNT(*) AS n FROM kb_documents d WHERE ' + visible.sql + ' AND (' + titleAnd + ')', [...visible.params, ...patterns])
  const titleProbe = countRows(store, 'SELECT COUNT(*) AS n FROM kb_documents d WHERE ' + probe.sql + ' AND (' + titleAnd + ')', [...probe.params, ...patterns])
  const titleRows = titleTotal > 0
    ? store.db.prepare('SELECT d.* FROM kb_documents d WHERE ' + visible.sql + ' AND (' + titleAnd + ') ORDER BY d.created_at DESC, d.id ASC LIMIT ?').all(...visible.params, ...patterns, limit)
    : []
  const titleHits = titleRows.map((row) => ({
    kind: 'kb_doc',
    ref: { kind: 'kb_doc', id: String(row.id) },
    docId: String(row.id),
    title: sanitizeLine(row.title, 200),
    snippet: '',
    highlights: [],
    matchPath: 'title',
    at: String(row.created_at ?? ''),
    ...(row.client_id === null || row.client_id === undefined ? {} : { clientId: String(row.client_id) }),
    ...(row.project_id === null || row.project_id === undefined ? {} : { projectId: String(row.project_id) }),
    ...(row.matter_id === null || row.matter_id === undefined ? {} : { matterId: String(row.matter_id) }),
  }))

  let chunkTotal = 0
  let chunkProbe = 0
  let chunkHits = []
  if (state.plan.mode === 'match') {
    try {
      const matchParams = [state.plan.ftsQuery]
      chunkTotal = countRows(store, 'SELECT COUNT(*) AS n FROM kb_fts JOIN kb_chunks c ON c.rowid = kb_fts.rowid JOIN kb_documents d ON d.id = c.doc_id WHERE kb_fts MATCH ? AND ' + visible.sql, [...matchParams, ...visible.params])
      chunkProbe = countRows(store, 'SELECT COUNT(*) AS n FROM kb_fts JOIN kb_chunks c ON c.rowid = kb_fts.rowid JOIN kb_documents d ON d.id = c.doc_id WHERE kb_fts MATCH ? AND ' + probe.sql, [...matchParams, ...probe.params])
      chunkHits = store.db.prepare('SELECT c.id AS chunk_id, c.text AS chunk_text, d.id AS doc_id, d.title AS doc_title, d.client_id, d.project_id, d.matter_id, d.created_at, rank AS fts_rank FROM kb_fts JOIN kb_chunks c ON c.rowid = kb_fts.rowid JOIN kb_documents d ON d.id = c.doc_id WHERE kb_fts MATCH ? AND ' + visible.sql + ' ORDER BY rank, c.id LIMIT ?')
        .all(...matchParams, ...visible.params, limit)
        .map((row) => documentHitFromRow(row, tokens, 'match', Number(row.fts_rank) === 0 ? 0 : Number(row.fts_rank)))
    } catch (error) {
      state.degraded.add('fts_query_fallback')
      state.plan = { mode: 'like', degraded: [] }
      chunkTotal = 0
      chunkProbe = 0
      chunkHits = []
    }
  }
  if (state.plan.mode === 'like') {
    chunkTotal = countRows(store, 'SELECT COUNT(*) AS n FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id WHERE ' + visible.sql + ' AND (' + chunkAnd + ')', [...visible.params, ...patterns])
    chunkProbe = countRows(store, 'SELECT COUNT(*) AS n FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id WHERE ' + probe.sql + ' AND (' + chunkAnd + ')', [...probe.params, ...patterns])
    chunkHits = store.db.prepare('SELECT c.id AS chunk_id, c.text AS chunk_text, d.id AS doc_id, d.title AS doc_title, d.client_id, d.project_id, d.matter_id, d.created_at FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id WHERE ' + visible.sql + ' AND (' + chunkAnd + ') ORDER BY c.rowid DESC LIMIT ?')
      .all(...visible.params, ...patterns, limit)
      .map((row) => documentHitFromRow(row, tokens, 'like'))
  }
  return {
    titleHits,
    chunkHits,
    titleTotal,
    chunkTotal,
    protectedExcluded: Math.max(0, titleProbe - titleTotal) + Math.max(0, chunkProbe - chunkTotal),
  }
}

function searchPages(store, tokens, state, { limit, clearance, filters }) {
  const patterns = tokens.map(likePattern)
  const titleAnd = tokens.map(() => 'p.title ' + LIKE_CLAUSE).join(' AND ')
  const bodyAnd = tokens.map(() => 'p.markdown ' + LIKE_CLAUSE).join(' AND ')
  const base = "p.status = 'generated' AND p.deleted_at IS NULL"
  const scanLimit = Math.min(KB_PAGE_SCAN_MAX, Math.max(200, limit * 10))
  let rows = []
  if (state.plan.mode === 'match') {
    try {
      rows = store.db.prepare('SELECT p.* FROM kb_pages_fts JOIN kb_pages p ON p.rowid = kb_pages_fts.rowid WHERE kb_pages_fts MATCH ? AND ' + base + ' LIMIT ?').all(state.plan.ftsQuery, scanLimit)
    } catch (error) {
      state.degraded.add('fts_query_fallback')
      state.plan = { mode: 'like', degraded: [] }
    }
  }
  if (state.plan.mode === 'like') {
    rows = store.db.prepare('SELECT p.* FROM kb_pages p WHERE ' + base + ' AND ((' + titleAnd + ') OR (' + bodyAnd + ')) ORDER BY p.generated_at DESC, p.id ASC LIMIT ?')
      .all(...patterns, ...patterns, scanLimit)
  }
  if (rows.length >= scanLimit) state.degraded.add('page_scan_capped')
  const maps = loadScopeMaps(store)
  const hits = []
  let protectedExcluded = 0
  for (const row of rows) {
    const owner = pageOwner(row, maps)
    const level = ownerSecrecy(maps, owner)
    if (!Number.isFinite(level) || level > clearance) { protectedExcluded += 1; continue }
    if (filters.clientId !== undefined && filters.clientId !== null && (!owner || owner.clientId !== String(filters.clientId))) continue
    if (filters.matterId !== undefined && filters.matterId !== null && (!owner || owner.matterId !== String(filters.matterId))) continue
    const snippet = makeSnippet(row.markdown, tokens)
    hits.push({
      kind: 'kb_page',
      ref: { kind: 'kb_page', id: String(row.id) },
      pageId: String(row.id),
      title: sanitizeLine(row.title, 200),
      snippet: snippet.snippet,
      highlights: snippet.highlights,
      matchPath: 'page',
      generatedAt: String(row.generated_at ?? ''),
      ...(owner && owner.clientId ? { clientId: owner.clientId } : {}),
      ...(owner && owner.matterId ? { matterId: owner.matterId } : {}),
    })
  }
  return { hits: hits.slice(0, limit), total: hits.length, protectedExcluded }
}

/**
 * Unified KB search (scope kb | pages | all).
 *
 * Shape matches 45 section 3.5. counts.turns/facts/preferences stay 0 here:
 * the CLI search command owns those engines and merges the counts.
 */
export function kbSearch(store, query, options = {}) {
  assertKbSchema(store)
  const parsed = normalizeKbQuery(query)
  const scope = options.scope === undefined ? 'kb' : String(options.scope)
  if (!['kb', 'pages', 'all'].includes(scope)) throw entityError('E_KB_INVALID', 'unknown search scope: ' + scope, 'use kb, pages or all')
  const limit = clampLimit(options.limit, KB_SEARCH_LIMIT, KB_SEARCH_LIMIT_MAX)
  const clearance = normalizeClearance(options.clearance === undefined ? KB_DEFAULT_CLEARANCE : options.clearance)
  const filters = { clientId: options.clientId, projectId: options.projectId, matterId: options.matterId, kind: options.kind }
  return store.read(() => {
    const initial = selectKbSearchPlan(store, parsed.tokens)
    const state = { plan: initial, degraded: new Set(initial.degraded) }
    const counts = { kbDocs: 0, kbChunks: 0, kbPages: 0, turns: 0, facts: 0, preferences: 0 }
    let protectedExcluded = 0
    let titleHits = []
    let chunkHits = []
    let pageHits = []
    if (scope === 'kb' || scope === 'all') {
      const documents = searchDocuments(store, parsed.tokens, state, { limit, clearance, filters })
      titleHits = documents.titleHits
      chunkHits = documents.chunkHits
      counts.kbDocs = documents.titleTotal
      counts.kbChunks = documents.chunkTotal
      protectedExcluded += documents.protectedExcluded
    }
    if (scope === 'pages' || scope === 'all') {
      const pages = searchPages(store, parsed.tokens, state, { limit, clearance, filters })
      pageHits = pages.hits
      counts.kbPages = pages.total
      protectedExcluded += pages.protectedExcluded
    }
    const hits = [...titleHits, ...chunkHits, ...pageHits].slice(0, limit)
    const total = counts.kbDocs + counts.kbChunks + counts.kbPages
    return {
      ok: true,
      command: 'search',
      query: parsed.query,
      scope,
      limit,
      clearance,
      degraded: [...state.degraded].sort(),
      counts,
      hits,
      total,
      truncated: total > hits.length,
      protectedExcluded,
    }
  })
}

export default Object.freeze({
  KB_KINDS,
  KB_RELATIONS,
  KB_DEFAULT_CLEARANCE,
  KB_LIST_LIMIT,
  KB_LIST_LIMIT_MAX,
  KB_SEARCH_LIMIT,
  KB_SEARCH_LIMIT_MAX,
  KB_QUERY_MAX_CHARS,
  KB_MAX_BATCH_FILES,
  KB_MAX_CHUNKS,
  KB_SNIPPET_CHARS,
  KB_CHUNK_PREVIEW_CHARS,
  KB_PAGE_SCAN_MAX,
  kbAdd,
  kbAddMany,
  kbList,
  kbShow,
  kbRm,
  kbPurge,
  kbReindex,
  verifyKbFts,
  kbLink,
  kbUnlink,
  kbSearch,
  normalizeKbQuery,
  selectKbSearchPlan,
  makeSnippet,
  kbFtsTokenizer,
  assertKbSchema,
  mapKbDocumentRow,
})

