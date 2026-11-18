import type { Clock, Ids } from './ports.ts'
import type { Commitment, CommitmentEvidence, Fact, IsoDate, UserPreference } from './types.ts'
import type { CommitmentInput, CommitmentUpdate, FactInput, PreferenceInput } from './ledger.ts'

/**
 * Pure ledger operations (0.2.3 persistence v2, phase 1).
 *
 * These functions own the business rules that used to live only inside the
 * in-memory {@link Ledger}: id/timestamp defaults, the commitment evidence
 * rule, the fact authority/supersede/shadow state machine, preference
 * confirmation and the reminder-offset copy semantics. They never touch a
 * store: callers either apply the result to the in-memory Ledger (which is
 * exactly what Ledger.* still does) or write it through SqliteStore's targeted
 * insert/update statements. Both paths therefore share one implementation.
 *
 * 0.3 will fold this file into packages/core/src/persistence/domain.ts; the
 * function names and return shapes are the frozen 0.2.3 contract.
 */

/** The two host ports the pure operations need. */
export interface OpsPorts {
  clock: Clock
  ids: Ids
}

/** Authority ranking used by remember/searchFacts (higher wins). */
export function authorityRank(authority: Fact['authority']): number {
  return authority === 'user' ? 100 : authority === 'import' ? 60 : authority === 'tool' ? 60 : 40
}

function copyReminderOffsets(value: string[] | null | undefined): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new TypeError('reminderOffsets must be an array of strings')
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new TypeError('reminderOffsets must be an array of strings')
    return entry
  })
}

/** Build a commitment (same defaults/evidence rule as Ledger.addCommitment). */
export function createCommitment(ports: OpsPorts, input: CommitmentInput): Commitment {
  if (input.evidence.length === 0) {
    throw new Error('a commitment requires at least one evidence item')
  }
  const reminderOffsets = copyReminderOffsets(input.reminderOffsets)
  return {
    id: ports.ids.next('cm'),
    matterId: input.matterId,
    debtor: input.debtor,
    creditor: input.creditor,
    action: input.action,
    dueAt: input.dueAt,
    timezone: input.timezone ?? 'Asia/Shanghai',
    status: 'open',
    evidence: input.evidence,
    capability: input.capability ?? 'none',
    // Never invent the field for old callers: a missing key keeps snapshots
    // byte-compatible with pre-0.2.0 data.
    ...(reminderOffsets === undefined ? {} : { reminderOffsets }),
  }
}

/**
 * Return a copy of `commitment` with the whitelisted patch fields applied.
 * Completion/drop stay on their dedicated operations so evidence rules cannot
 * be bypassed here (same contract as Ledger.updateCommitment).
 */
export function updateCommitmentFields(commitment: Commitment, patch: CommitmentUpdate): Commitment {
  const next: Commitment = { ...commitment }
  if (patch.action !== undefined) next.action = patch.action
  if (patch.dueAt !== undefined) next.dueAt = patch.dueAt
  if (patch.timezone !== undefined) next.timezone = patch.timezone
  if (patch.capability !== undefined) next.capability = patch.capability
  if (patch.reminderOffsets !== undefined) {
    const reminderOffsets = copyReminderOffsets(patch.reminderOffsets)
    if (reminderOffsets === undefined) delete next.reminderOffsets
    else next.reminderOffsets = reminderOffsets
  }
  return next
}

/** Return a copy marked done with the new evidence appended (never mutates). */
export function completeCommitment(commitment: Commitment, evidence: CommitmentEvidence[], now: IsoDate): Commitment {
  if (evidence.length === 0) throw new Error('done requires external evidence; model self-report is not evidence')
  return {
    ...commitment,
    status: 'done',
    doneAt: now,
    evidence: [...commitment.evidence, ...evidence],
  }
}

/** Build a preference (same defaults as Ledger.addPreference). */
export function createPreference(ports: OpsPorts, input: PreferenceInput): UserPreference {
  return {
    id: ports.ids.next('pref'),
    kind: input.kind,
    statement: input.statement,
    scope: input.scope ?? { level: 'global' },
    source: input.source ?? { type: 'user_explicit' },
    evidence: input.evidence ?? [],
    confidence: input.confidence ?? 0.9,
    status: input.status ?? 'confirmed',
    validFrom: ports.clock.now(),
    expiresAt: input.expiresAt,
    priority: input.priority ?? (input.kind === 'taboo' ? 'hard' : 'soft'),
  }
}

/**
 * Confirm an existing preference (the logic of bin's historical
 * learnPreference): +0.2 confidence, record lastConfirmed, promote to
 * 'confirmed' at >= 0.7. `promoted` mirrors the old receipt flag (true when the
 * resulting status is confirmed, including an already-confirmed preference).
 */
export function confirmPreference(preference: UserPreference, now: IsoDate): { preference: UserPreference; promoted: boolean } {
  const confidence = Math.min(1, preference.confidence + 0.2)
  const next: UserPreference = { ...preference, confidence, lastConfirmed: now }
  if (next.confidence >= 0.7) next.status = 'confirmed'
  return { preference: next, promoted: next.status === 'confirmed' }
}

/** Build a fresh fact from input (no supersede/merge; see applyRemember). */
export function createFact(ports: OpsPorts, input: FactInput): Fact {
  const now = ports.clock.now()
  const authority = input.authority ?? 'user'
  return {
    id: ports.ids.next('fact'),
    matterId: input.matterId,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    recordedAt: now,
    authority,
    confidence: input.confidence ?? 0.9,
    source: input.source,
    evidence: input.evidence ?? (input.source ? [input.source] : []),
    status: authority === 'user' ? 'confirmed' : 'candidate',
    validFrom: input.validFrom ?? now,
    validTo: input.validTo,
  }
}

/** Result of applying a remember input against the current fact (if any). */
export type RememberOutcome =
  | { op: 'update'; row: Fact }
  | { op: 'insert'; row: Fact }
  | { op: 'supersede'; old: Fact; row: Fact }

/**
 * Decide what a remember() call does to the ledger: merge into the current
 * fact, insert a shadow candidate, or supersede the old fact with a new one.
 *
 * `current` is the confirmed, unexpired fact for the same subject/predicate/
 * matter (undefined for predicate 'said', where conversation echoes must not
 * supersede each other). The returned rows are copies: callers persist them.
 */
export function applyRemember(current: Fact | undefined, input: FactInput, ports: OpsPorts): RememberOutcome {
  const now = ports.clock.now()
  const frozen: OpsPorts = { clock: { now: () => now }, ids: ports.ids }
  const incomingRank = authorityRank(input.authority ?? 'user')
  if (current && current.object === input.object) {
    const merged: Fact = {
      ...current,
      evidence: [...(current.evidence ?? []), ...(input.evidence ?? (input.source ? [input.source] : []))],
    }
    if (!merged.source && input.source) merged.source = input.source
    if (incomingRank > authorityRank(current.authority)) merged.authority = input.authority ?? current.authority
    merged.lastSeenAt = now
    return { op: 'update', row: merged }
  }
  if (current && incomingRank < authorityRank(current.authority)) {
    const shadow: Fact = {
      id: ports.ids.next('fact'),
      matterId: input.matterId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      recordedAt: now,
      authority: input.authority ?? 'inferred',
      confidence: input.confidence ?? 0.6,
      source: input.source,
      evidence: input.evidence,
      status: 'candidate',
      shadowedBy: current.id,
      validFrom: input.validFrom,
      validTo: input.validTo,
    }
    return { op: 'insert', row: shadow }
  }
  const row: Fact = createFact(frozen, input)
  // The Ledger historically always carried the key (undefined when there is no
  // predecessor); keep the own-property shape so snapshots stay byte-compatible.
  row.supersedes = current?.id
  if (!current) return { op: 'insert', row }
  const old: Fact = {
    ...current,
    status: 'superseded',
    validTo: input.validFrom ?? now,
    expiredAt: now,
    supersededBy: row.id,
  }
  return { op: 'supersede', old, row }
}
