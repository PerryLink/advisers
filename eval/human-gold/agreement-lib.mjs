/**
 * Human-gold label sheets: parsing, alignment and Cohen's kappa.
 *
 * Shared by eval/human-gold/compute-agreement.mjs and adjudicate.mjs. Pure
 * functions only: no file IO except the explicit sheet/corpus readers, no
 * network, no model. A label sheet is a TSV with one row per commitment; a case
 * with n commitments repeats its id on n rows (in the order the commitments
 * appear in the case text). A case with no commitment has no row.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const LABEL_HEADER = ['id', 'action', 'debtor', 'creditor', 'due', 'quote', 'modal', 'confidence', 'notes']
export const LABEL_FIELDS = ['action', 'debtor', 'creditor', 'due', 'quote', 'modal']
export const ADJUDICATION_HEADER = ['id', 'agree', 'final_commitments', 'notes']
export const DEFAULT_KAPPA_THRESHOLD = 0.7
export const EMPTY_LABEL = '\u2205'

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** NFKC, collapse whitespace, trim. Used for comparison only, never for output. */
export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
}

const DUE_RE = /^\d{4}-\d{2}-\d{2}$/
const MODALS = new Set(['firm', 'tentative', 'conditional'])
const DEBTORS = new Set(['user', 'third', 'unknown'])

/** Validate + normalize one field value. Throws on malformed enum/date values. */
export function normalizeFieldValue(field, value, where) {
  const raw = String(value ?? '').trim()
  if (field === 'due') {
    if (!raw) return ''
    if (!DUE_RE.test(raw) || Number.isNaN(Date.parse(raw + 'T00:00:00Z'))) throw new Error(where + ': due must be YYYY-MM-DD or empty, got ' + JSON.stringify(raw))
    return raw
  }
  if (field === 'debtor') {
    const lower = raw.toLowerCase()
    if (!lower) return ''
    if (!DEBTORS.has(lower)) throw new Error(where + ': debtor must be user|third|unknown or empty, got ' + JSON.stringify(raw))
    return lower
  }
  if (field === 'modal') {
    const lower = raw.toLowerCase()
    if (!lower) return ''
    if (!MODALS.has(lower)) throw new Error(where + ': modal must be firm|tentative|conditional or empty, got ' + JSON.stringify(raw))
    return lower
  }
  return normalizeText(raw)
}

function splitTsvLine(line) {
  const cells = line.split('\t')
  while (cells.length < LABEL_HEADER.length) cells.push('')
  return cells
}

/**
 * Parse a reviewer label sheet. Returns { rows: Map<id, object[]>, ids, rowCount }.
 * Every id must also appear in `expectedIds` when it is provided.
 */
export function parseLabelSheet(text, { file = '<sheet>', expectedIds = null } = {}) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim() !== '')
  if (!lines.length) throw new Error(file + ': empty label sheet')
  const header = splitTsvLine(lines[0]).map((cell) => cell.trim().toLowerCase())
  const index = new Map()
  for (const field of ['id', ...LABEL_FIELDS]) {
    const at = header.indexOf(field)
    if (at < 0) throw new Error(file + ': header is missing column ' + field + ' (expected ' + LABEL_HEADER.join(', ') + ')')
    index.set(field, at)
  }
  const rows = new Map()
  let rowCount = 0
  for (let lineNumber = 2; lineNumber <= lines.length; lineNumber += 1) {
    const cells = splitTsvLine(lines[lineNumber - 1])
    const id = String(cells[index.get('id')] ?? '').trim()
    if (!id) throw new Error(file + ' line ' + lineNumber + ': missing id')
    const where = file + ' line ' + lineNumber + ' (' + id + ')'
    const fields = {}
    const normalized = {}
    let empty = true
    for (const field of LABEL_FIELDS) {
      const raw = String(cells[index.get(field)] ?? '').trim()
      fields[field] = raw
      normalized[field] = normalizeFieldValue(field, raw, where)
      if (normalized[field]) empty = false
    }
    if (empty) continue // a fully blank row is not a commitment
    rowCount += 1
    if (!rows.has(id)) rows.set(id, [])
    rows.get(id).push({ fields, normalized })
  }
  const ids = [...rows.keys()]
  if (expectedIds) {
    const expected = new Set(expectedIds)
    const unknown = ids.filter((id) => !expected.has(id))
    const missing = [...expected].filter((id) => !rows.has(id))
    if (unknown.length) throw new Error(file + ': ' + unknown.length + ' id(s) are not in the packet (e.g. ' + unknown.slice(0, 3).join(', ') + ')')
    if (missing.length) throw new Error(file + ': ' + missing.length + ' case id(s) are unlabelled (e.g. ' + missing.slice(0, 3).join(', ') + '); both reviewers must label every case, including no-commitment cases')
  }
  if (!rowCount) throw new Error(file + ': no labelled commitments; fill the sheet with one row per commitment (leave a no-commitment case without rows)')
  return { rows, ids, rowCount }
}

/** Parse the adjudication sheet (only disagreements need a row). */
export function parseAdjudicationSheet(text, { file = '<adjudication>' } = {}) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim() !== '')
  if (!lines.length) return new Map()
  const header = splitTsvLine(lines[0]).map((cell) => cell.trim().toLowerCase())
  const index = new Map()
  for (const field of ADJUDICATION_HEADER) {
    const at = header.indexOf(field)
    if (at < 0) {
      if (field === 'final_commitments' && header.includes('final_action')) {
        throw new Error(file + ': legacy adjudication header detected; regenerate the packet with the current make-review-packet.mjs (columns: ' + ADJUDICATION_HEADER.join(', ') + ')')
      }
      throw new Error(file + ': header is missing column ' + field + ' (expected ' + ADJUDICATION_HEADER.join(', ') + ')')
    }
    index.set(field, at)
  }
  const decisions = new Map()
  for (let lineNumber = 2; lineNumber <= lines.length; lineNumber += 1) {
    const cells = splitTsvLine(lines[lineNumber - 1])
    const id = String(cells[index.get('id')] ?? '').trim()
    if (!id) throw new Error(file + ' line ' + lineNumber + ': missing id')
    if (decisions.has(id)) throw new Error(file + ' line ' + lineNumber + ': duplicate adjudication for ' + id)
    const agree = String(cells[index.get('agree')] ?? '').trim().toLowerCase()
    const finalText = String(cells[index.get('final_commitments')] ?? '').trim()
    let final = null
    if (finalText && finalText !== '-') {
      let parsed
      try { parsed = JSON.parse(finalText) } catch (error) { throw new Error(file + ' line ' + lineNumber + ' (' + id + '): final_commitments must be a JSON array or - (' + error.message + ')') }
      if (!Array.isArray(parsed)) throw new Error(file + ' line ' + lineNumber + ' (' + id + '): final_commitments must be a JSON array')
      final = parsed.map((entry, position) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(file + ' line ' + lineNumber + ' (' + id + ') slot ' + position + ': commitment must be an object')
        const fields = {}
        const normalized = {}
        for (const field of LABEL_FIELDS) {
          const raw = String(entry[field] ?? '').trim()
          fields[field] = raw
          normalized[field] = normalizeFieldValue(field, raw, file + ' line ' + lineNumber + ' (' + id + ') slot ' + position)
        }
        if (!normalized.action && !normalized.quote) throw new Error(file + ' line ' + lineNumber + ' (' + id + ') slot ' + position + ': final commitment needs at least action or quote')
        return { fields, normalized }
      })
    }
    if (agree !== 'yes' && agree !== 'no') throw new Error(file + ' line ' + lineNumber + ' (' + id + '): agree must be yes or no')
    if (agree === 'no' && !final) throw new Error(file + ' line ' + lineNumber + ' (' + id + '): agree=no needs final_commitments (JSON array)')
    if (agree === 'yes' && final) throw new Error(file + ' line ' + lineNumber + ' (' + id + '): agree=yes must leave final_commitments as -')
    decisions.set(id, { id, agree, final, notes: String(cells[index.get('notes')] ?? '').trim() })
  }
  return decisions
}

/** Align two reviewers' commitment rows for one case, by annotation order. */
export function alignCase(aRows = [], bRows = []) {
  const slots = []
  const count = Math.max(aRows.length, bRows.length)
  for (let position = 0; position < count; position += 1) slots.push({ a: aRows[position] ?? null, b: bRows[position] ?? null })
  return slots
}

function fieldValue(entry, field) {
  if (!entry) return EMPTY_LABEL
  return entry.normalized[field] || EMPTY_LABEL
}

/** Cohen's kappa for paired nominal labels. `kappa` is null when undefined. */
export function cohenKappa(pairs) {
  const n = pairs.length
  if (!n) return { n: 0, observedAgreement: null, expectedAgreement: null, kappa: null, categories: 0 }
  const countA = new Map()
  const countB = new Map()
  let agree = 0
  for (const [left, right] of pairs) {
    if (left === right) agree += 1
    countA.set(left, (countA.get(left) ?? 0) + 1)
    countB.set(right, (countB.get(right) ?? 0) + 1)
  }
  const observedAgreement = agree / n
  let expectedAgreement = 0
  for (const [value, count] of countA) expectedAgreement += (count / n) * ((countB.get(value) ?? 0) / n)
  const kappa = expectedAgreement >= 1 ? null : (observedAgreement - expectedAgreement) / (1 - expectedAgreement)
  return {
    n,
    observedAgreement: round4(observedAgreement),
    expectedAgreement: round4(expectedAgreement),
    kappa: kappa === null ? null : round4(kappa),
    categories: new Set([...countA.keys(), ...countB.keys()]).size,
  }
}

export function round4(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null
}

function caseStatus(aRows, bRows) {
  const slots = alignCase(aRows, bRows)
  let disagreements = 0
  for (const slot of slots) {
    for (const field of LABEL_FIELDS) {
      if (fieldValue(slot.a, field) !== fieldValue(slot.b, field)) disagreements += 1
    }
  }
  return { exact: disagreements === 0 && (aRows?.length ?? 0) === (bRows?.length ?? 0), disagreements, slots: slots.length }
}

/**
 * Compute reviewer agreement. Returns per-field kappa, the overall kappa (macro
 * mean of the defined per-field kappas), the row-level exact-agreement rate and
 * the κ>=threshold gate. It never echoes raw label values or case text: only
 * counts, κ and ids in errors.
 */
export function computeAgreement({ a, b, ids, threshold = DEFAULT_KAPPA_THRESHOLD }) {
  const fields = LABEL_FIELDS
  const perField = {}
  const allPairs = []
  let slotsTotal = 0
  let exactCases = 0
  let disagreeingCases = 0
  for (const id of ids) {
    const aRows = a.rows.get(id) ?? []
    const bRows = b.rows.get(id) ?? []
    const status = caseStatus(aRows, bRows)
    slotsTotal += status.slots
    if (status.exact) exactCases += 1
    if (status.disagreements > 0) disagreeingCases += 1
    const slots = alignCase(aRows, bRows)
    for (const slot of slots) {
      for (const field of fields) {
        const pair = [fieldValue(slot.a, field), fieldValue(slot.b, field)]
        if (!perField[field]) perField[field] = []
        perField[field].push(pair)
        allPairs.push([field + ':' + pair[0], field + ':' + pair[1]])
      }
    }
  }
  const fieldsOut = {}
  for (const field of fields) fieldsOut[field] = cohenKappa(perField[field] ?? [])
  const defined = fields.filter((field) => fieldsOut[field].kappa !== null)
  const undefinedFields = fields.filter((field) => fieldsOut[field].kappa === null)
  // A heterogeneous annotation task cannot pool every field into one contingency
  // table (the kappa paradox: five perfectly-agreed fields can mask one
  // anti-correlated field). The frozen "overall kappa" is therefore the mean of
  // the per-field kappas that are mathematically defined; undefined fields
  // (single-category labels) are reported, not silently counted as perfect.
  const macroKappa = defined.length ? round4(defined.reduce((sum, field) => sum + fieldsOut[field].kappa, 0) / defined.length) : null
  const micro = cohenKappa(allPairs)
  const kappa = macroKappa
  const passed = kappa === null ? null : kappa >= threshold
  return {
    format: 'advisers-human-gold-agreement',
    version: 1,
    threshold,
    reviewers: {
      a: { file: a.file ?? null, sha256: a.sha256 ?? null, rows: a.rowCount, cases: a.ids.length },
      b: { file: b.file ?? null, sha256: b.sha256 ?? null, rows: b.rowCount, cases: b.ids.length },
    },
    cases: ids.length,
    commitmentSlots: slotsTotal,
    perField: fieldsOut,
    overall: {
      method: 'macro-over-defined-fields',
      kappa: macroKappa,
      definedFields: defined.length,
      undefinedFields,
      micro: { observedAgreement: micro.observedAgreement, expectedAgreement: micro.expectedAgreement, kappa: micro.kappa },
    },
    caseAgreement: { cases: ids.length, exact: exactCases, disagreeing: disagreeingCases, rate: round4(ids.length ? exactCases / ids.length : null) },
    gate: {
      id: 'humanGold.kappa',
      metric: 'overall.kappa',
      threshold,
      actual: kappa,
      passed,
      reason: kappa === null ? 'kappa is undefined (all labels fall in one category)' : passed ? 'meets the frozen threshold' : 'below the frozen threshold: re-label, do not freeze',
    },
    privacy: { containsCaseText: false, containsRawLabelValues: false, output: 'counts-and-kappa-only' },
  }
}

/** Read a JSONL corpus file into a Map keyed by id. */
export function readCorpusJsonl(path) {
  const rows = new Map()
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '')
  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
    let row
    try { row = JSON.parse(lines[lineNumber - 1]) } catch (error) { throw new Error(path + ' line ' + lineNumber + ': invalid JSON (' + error.message + ')') }
    if (!row || typeof row.id !== 'string' || !row.id) throw new Error(path + ' line ' + lineNumber + ': missing id')
    if (rows.has(row.id)) throw new Error(path + ' line ' + lineNumber + ': duplicate id ' + row.id)
    rows.set(row.id, row)
  }
  return rows
}

export default Object.freeze({
  LABEL_HEADER, LABEL_FIELDS, ADJUDICATION_HEADER, DEFAULT_KAPPA_THRESHOLD, EMPTY_LABEL,
  sha256File, normalizeText, normalizeFieldValue, parseLabelSheet, parseAdjudicationSheet,
  alignCase, cohenKappa, round4, computeAgreement, readCorpusJsonl,
})
