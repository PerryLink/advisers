import type { Id, IsoDate, Secrecy } from './types.ts'

/**
 * Customer/project read model (0.3.0 schema v21): pure, deterministic helpers.
 *
 * `clients`, `projects` and `client_notes` are SQLite-only entities: they never
 * enter the wire LedgerSnapshot (version stays 1). The store exposes the rows,
 * and these functions derive the views the CLI/MCP layer prints: the customer
 * timeline, the mine/waiting split of open commitments and the client counters.
 *
 * Rules frozen for 0.3.0:
 * - the timeline is DERIVED, never stored: there is no event table and no
 *   aggregate column, so it cannot disagree with its sources;
 * - an event's `at` is the moment it happened. A commitment uses its creation
 *   instant; its due date is a field, never the timeline position (a future due
 *   date is not history);
 * - ordering is instant DESC, then the fixed kind order below, then id ASC, so
 *   two runs over the same rows are byte-identical;
 * - a row whose timestamp cannot be parsed is skipped and reported in
 *   `degraded` instead of being silently placed at an invented time;
 * - titles are single-line display strings (max 120 chars), never file paths.
 */

/** One source of a customer timeline entry. */
export const TIMELINE_KIND_ORDER = ['delivery', 'note', 'commitment', 'fact'] as const

export type TimelineKind = (typeof TIMELINE_KIND_ORDER)[number]

/** Default page size of `client timeline` / `client show`. */
export const DEFAULT_TIMELINE_LIMIT = 20
/** Hard cap for one timeline page (a larger --limit is clamped, never errors). */
export const MAX_TIMELINE_LIMIT = 200

/** Stable codes for source rows that could not be placed on the timeline. */
export const TIMELINE_DEGRADED = {
  commitmentMissingCreatedAt: 'commitment:missing-created-at',
  deliveryInvalidCreatedAt: 'delivery:invalid-created-at',
  noteInvalidAt: 'note:invalid-at',
  factInvalidRecordedAt: 'fact:invalid-recorded-at',
} as const

/** The ownership/display fields of a matter that a timeline needs. */
export interface TimelineMatterInput {
  id: Id
  clientId?: Id
  projectId?: Id
  status?: string
  secrecy?: Secrecy
}

/** A commitment as the ledger/store exposes it (createdAt is optional: rows
 * written before v21 have no creation instant). */
export interface TimelineCommitmentInput {
  id: Id
  matterId?: Id
  action: string
  debtor: string
  creditor: string
  dueAt?: IsoDate
  status: string
  doneAt?: IsoDate
  createdAt?: IsoDate
}

/** A delivery row; templateName is the optional template lineage (v21). */
export interface TimelineDeliveryInput {
  id: Id
  matterId?: Id
  clientId?: Id
  projectId?: Id
  title?: string
  tool?: string
  templateName?: string
  createdAt: IsoDate
}

/** A client_notes row (manual timeline source). */
export interface TimelineNoteInput {
  id: Id
  clientId?: Id
  projectId?: Id
  matterId?: Id
  kind?: string
  at: IsoDate
  summary: string
}

/** A fact row (optional timeline source; 0.3.0 derives it when supplied). */
export interface TimelineFactInput {
  id: Id
  matterId?: Id
  subject: string
  predicate: string
  object: string
  recordedAt: IsoDate
}

/** Everything a client timeline is derived from, in one read snapshot. */
export interface TimelineSources {
  matters?: readonly TimelineMatterInput[]
  commitments?: readonly TimelineCommitmentInput[]
  deliveries?: readonly TimelineDeliveryInput[]
  notes?: readonly TimelineNoteInput[]
  facts?: readonly TimelineFactInput[]
}

/** Back-reference of a timeline item to the row it came from. */
export interface TimelineRef {
  kind: TimelineKind
  id: Id
}

/** One derived customer-timeline entry. */
export interface TimelineItem {
  at: IsoDate
  kind: TimelineKind
  title: string
  ref: TimelineRef
  matterId?: Id
  projectId?: Id
  secrecy?: Secrecy
  status?: string
  dueAt?: IsoDate
  doneAt?: IsoDate
  debtor?: string
  creditor?: string
  templateName?: string
}

/** One page of timeline entries (before/after the limit). */
export interface TimelinePage {
  items: TimelineItem[]
  /** Entries matching the filters before the limit was applied. */
  total: number
  truncated: boolean
}

/** A derived timeline plus the honest list of rows that could not be placed. */
export interface TimelineDerivation extends TimelinePage {
  degraded: string[]
}

/** Filters accepted by the timeline view. */
export interface TimelineFilterOptions {
  /** Only entries at or after this instant (ISO string or epoch ms). */
  since?: IsoDate | number
  /** Only these kinds; omitted = every kind, `[]` = none. */
  kinds?: readonly TimelineKind[]
  limit?: number
  defaultLimit?: number
  maxLimit?: number
}

/** Options for {@link deriveClientTimeline}. */
export type DeriveTimelineOptions = TimelineFilterOptions

/** One open commitment in a client view. */
export interface OpenCommitmentRow {
  id: Id
  action: string
  dueAt?: IsoDate
  debtor: string
  creditor: string
  matterId?: Id
  projectId?: Id
  secrecy?: Secrecy
}

/** `mine` = we owe the client (debtor user/agent); `waiting` = the client owes us. */
export interface OpenCommitmentBuckets {
  mine: OpenCommitmentRow[]
  waiting: OpenCommitmentRow[]
}

/** Derived counters for `client show` / `client ls`. */
export interface ClientCounts {
  matters: number
  mattersArchived: number
  deliveries: number
  notes: number
  commitments: number
  openMine: number
  openWaiting: number
  overdue: number
}

const KIND_RANK: Record<TimelineKind, number> = {
  delivery: 0,
  note: 1,
  commitment: 2,
  fact: 3,
}

const TITLE_MAX = 120

/** Parse one ISO/epoch timestamp; null when it cannot be trusted. */
function instantOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/** Single-line display title, never longer than `max` characters. */
export function timelineTitle(value: string | undefined | null, max = TITLE_MAX): string {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  if (!text) return ''
  if (text.length <= max) return text
  return text.slice(0, Math.max(1, max - 1)) + '\u2026'
}

/** The first line of a client note, used as the timeline title. */
export function timelineTitleFromSummary(summary: string | undefined | null, max = TITLE_MAX): string {
  const firstLine = String(summary ?? '').split(/\r?\n/, 1)[0] ?? ''
  const title = timelineTitle(firstLine, max)
  return title || '(note)'
}

/** Resolve a limit to a positive integer inside [0, maxLimit]. */
function resolveLimit(limit: number | undefined, defaultLimit: number | undefined, maxLimit: number | undefined): number {
  const max = Number.isInteger(maxLimit) && (maxLimit as number) > 0 ? (maxLimit as number) : MAX_TIMELINE_LIMIT
  const fallback = Number.isInteger(defaultLimit) && (defaultLimit as number) >= 0 ? (defaultLimit as number) : DEFAULT_TIMELINE_LIMIT
  if (limit === undefined || limit === null) return Math.min(fallback, max)
  const value = Number(limit)
  if (!Number.isFinite(value) || value < 0) throw new TypeError('limit must be a non-negative integer')
  return Math.min(Math.floor(value), max)
}

/** Validate + normalise the `kinds` filter (throws on an unknown kind). */
function resolveKinds(kinds: readonly TimelineKind[] | undefined): Set<TimelineKind> | null {
  if (kinds === undefined) return null
  const set = new Set<TimelineKind>()
  for (const kind of kinds) {
    if (!Object.prototype.hasOwnProperty.call(KIND_RANK, kind)) throw new TypeError(`unknown timeline kind: ${String(kind)}`)
    set.add(kind)
  }
  return set
}

/** Keep the stable public order: instant DESC, kind order, then id ASC. */
function compareTimelineItems(a: TimelineItem, b: TimelineItem): number {
  const byInstant = (instantOf(b.at) ?? 0) - (instantOf(a.at) ?? 0)
  if (byInstant) return byInstant
  const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind]
  if (byKind) return byKind
  return a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0
}

/**
 * Sort + filter + page already-derived timeline entries.
 *
 * The sort is applied defensively so a caller that merged two pages still gets
 * the frozen ordering contract. `total` counts the entries that matched the
 * filters before `limit`; `truncated` is true when the page is smaller.
 */
export function filterTimelineItems(items: readonly TimelineItem[], options: TimelineFilterOptions = {}): TimelinePage {
  const kinds = resolveKinds(options.kinds)
  const sinceMs = options.since === undefined ? null : instantOf(options.since)
  if (options.since !== undefined && sinceMs === null) throw new TypeError('since must be an ISO timestamp or epoch milliseconds')
  const limit = resolveLimit(options.limit, options.defaultLimit, options.maxLimit)
  const filtered: TimelineItem[] = []
  for (const item of items) {
    if (kinds && !kinds.has(item.kind)) continue
    const ms = instantOf(item.at)
    if (ms === null) continue
    if (sinceMs !== null && ms < sinceMs) continue
    filtered.push(item)
  }
  filtered.sort(compareTimelineItems)
  return { items: filtered.slice(0, limit), total: filtered.length, truncated: filtered.length > limit }
}

/**
 * Derive the merged customer timeline from one read snapshot.
 *
 * Sources are merged by the frozen order (see module comment); commitments
 * without a parseable creation instant are skipped and reported in `degraded`
 * (a done/dropped commitment may fall back to its doneAt, which is a real
 * moment). Delivery/note/fact rows with an unparseable timestamp are skipped
 * the same way — never silently placed.
 */
export function deriveClientTimeline(sources: TimelineSources, options: DeriveTimelineOptions = {}): TimelineDerivation {
  const matterById = new Map<Id, TimelineMatterInput>()
  for (const matter of sources.matters ?? []) matterById.set(matter.id, matter)
  const degraded = new Set<string>()
  const items: TimelineItem[] = []

  const projectOf = (matterId: Id | undefined): Id | undefined =>
    matterId === undefined ? undefined : matterById.get(matterId)?.projectId
  const secrecyOf = (matterId: Id | undefined): Secrecy | undefined =>
    matterId === undefined ? undefined : matterById.get(matterId)?.secrecy

  for (const delivery of sources.deliveries ?? []) {
    if (instantOf(delivery.createdAt) === null) { degraded.add(TIMELINE_DEGRADED.deliveryInvalidCreatedAt); continue }
    items.push({
      at: delivery.createdAt,
      kind: 'delivery',
      title: timelineTitle(delivery.title) || timelineTitle(delivery.tool) || delivery.id,
      ref: { kind: 'delivery', id: delivery.id },
      ...(delivery.matterId === undefined ? {} : { matterId: delivery.matterId }),
      ...(delivery.projectId !== undefined ? { projectId: delivery.projectId }
        : projectOf(delivery.matterId) !== undefined ? { projectId: projectOf(delivery.matterId) } : {}),
      ...(secrecyOf(delivery.matterId) === undefined ? {} : { secrecy: secrecyOf(delivery.matterId) as Secrecy }),
      ...(delivery.templateName === undefined ? {} : { templateName: delivery.templateName }),
    })
  }

  for (const note of sources.notes ?? []) {
    if (instantOf(note.at) === null) { degraded.add(TIMELINE_DEGRADED.noteInvalidAt); continue }
    items.push({
      at: note.at,
      kind: 'note',
      title: timelineTitleFromSummary(note.summary),
      ref: { kind: 'note', id: note.id },
      ...(note.matterId === undefined ? {} : { matterId: note.matterId }),
      ...(note.projectId === undefined ? {} : { projectId: note.projectId }),
      ...(secrecyOf(note.matterId) === undefined ? {} : { secrecy: secrecyOf(note.matterId) as Secrecy }),
    })
  }

  for (const commitment of sources.commitments ?? []) {
    const doneish = commitment.status === 'done' || commitment.status === 'dropped'
    let at: IsoDate | null = instantOf(commitment.createdAt) === null ? null : (commitment.createdAt as IsoDate)
    if (at === null && doneish && instantOf(commitment.doneAt) !== null) at = commitment.doneAt as IsoDate
    if (at === null) { degraded.add(TIMELINE_DEGRADED.commitmentMissingCreatedAt); continue }
    const matterId = commitment.matterId
    items.push({
      at,
      kind: 'commitment',
      title: timelineTitle(commitment.action) || commitment.id,
      ref: { kind: 'commitment', id: commitment.id },
      ...(matterId === undefined ? {} : { matterId }),
      ...(projectOf(matterId) !== undefined ? { projectId: projectOf(matterId) } : {}),
      ...(secrecyOf(matterId) === undefined ? {} : { secrecy: secrecyOf(matterId) as Secrecy }),
      ...(commitment.status === undefined ? {} : { status: commitment.status }),
      ...(commitment.dueAt === undefined ? {} : { dueAt: commitment.dueAt }),
      ...(commitment.doneAt === undefined ? {} : { doneAt: commitment.doneAt }),
      ...(commitment.debtor === undefined ? {} : { debtor: commitment.debtor }),
      ...(commitment.creditor === undefined ? {} : { creditor: commitment.creditor }),
    })
  }

  for (const fact of sources.facts ?? []) {
    if (instantOf(fact.recordedAt) === null) { degraded.add(TIMELINE_DEGRADED.factInvalidRecordedAt); continue }
    const matterId = fact.matterId
    items.push({
      at: fact.recordedAt,
      kind: 'fact',
      title: timelineTitle(`${fact.subject} ${fact.predicate}`) || fact.id,
      ref: { kind: 'fact', id: fact.id },
      ...(matterId === undefined ? {} : { matterId }),
      ...(projectOf(matterId) !== undefined ? { projectId: projectOf(matterId) } : {}),
      ...(secrecyOf(matterId) === undefined ? {} : { secrecy: secrecyOf(matterId) as Secrecy }),
    })
  }

  const page = filterTimelineItems(items, options)
  return { ...page, degraded: [...degraded].sort() }
}

/**
 * Split open commitments into `mine` (debtor user/agent: we owe the client) and
 * `waiting` (debtor third:…: the client owes us), ordered by due date then id.
 */
export function splitOpenCommitments(
  commitments: readonly TimelineCommitmentInput[],
  matters: readonly TimelineMatterInput[] = [],
): OpenCommitmentBuckets {
  const matterById = new Map<Id, TimelineMatterInput>()
  for (const matter of matters) matterById.set(matter.id, matter)
  const mine: OpenCommitmentRow[] = []
  const waiting: OpenCommitmentRow[] = []
  for (const commitment of commitments) {
    if (commitment.status !== 'open') continue
    const matter = commitment.matterId === undefined ? undefined : matterById.get(commitment.matterId)
    const row: OpenCommitmentRow = {
      id: commitment.id,
      action: commitment.action,
      debtor: commitment.debtor,
      creditor: commitment.creditor,
      ...(commitment.dueAt === undefined ? {} : { dueAt: commitment.dueAt }),
      ...(commitment.matterId === undefined ? {} : { matterId: commitment.matterId }),
      ...(matter?.projectId === undefined ? {} : { projectId: matter.projectId }),
      ...(matter?.secrecy === undefined ? {} : { secrecy: matter.secrecy }),
    }
    if (commitment.debtor.startsWith('third:')) waiting.push(row)
    else mine.push(row)
  }
  const byDue = (a: OpenCommitmentRow, b: OpenCommitmentRow): number => {
    const aMs = instantOf(a.dueAt)
    const bMs = instantOf(b.dueAt)
    if (aMs === null && bMs === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (aMs === null) return 1
    if (bMs === null) return -1
    if (aMs !== bMs) return aMs - bMs
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
  mine.sort(byDue)
  waiting.sort(byDue)
  return { mine, waiting }
}

/**
 * Derive the client counters a `client show` needs from one read snapshot.
 * `overdue` = open commitments whose due instant is strictly before `now`.
 */
export function summarizeClientCounts(
  sources: TimelineSources,
  options: { now: IsoDate | number },
): ClientCounts {
  const nowMs = instantOf(options.now)
  if (nowMs === null) throw new TypeError('now must be an ISO timestamp or epoch milliseconds')
  const matters = sources.matters ?? []
  const commitments = sources.commitments ?? []
  const { mine, waiting } = splitOpenCommitments(commitments, matters)
  const overdue = [...mine, ...waiting].filter((row) => {
    const ms = instantOf(row.dueAt)
    return ms !== null && ms < nowMs
  }).length
  return {
    matters: matters.length,
    mattersArchived: matters.filter((matter) => matter.status === 'archived').length,
    deliveries: (sources.deliveries ?? []).length,
    notes: (sources.notes ?? []).length,
    commitments: commitments.length,
    openMine: mine.length,
    openWaiting: waiting.length,
    overdue,
  }
}
