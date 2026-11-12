import type { HostPorts } from './ports.ts'
import { systemPorts } from './ports.ts'
import type {
  Commitment,
  CommitmentEvidence,
  Fact,
  Id,
  Matter,
  MatterLink,
  MatterLinkType,
  Routine,
  RoutinePatch,
  SourceRef,
  PreferenceKind,
  PreferenceScope,
  UpdateProposal,
  UserPreference,
} from './types.ts'

export interface MatterInput {
  title: string
  domain?: string
  secrecy?: Matter['secrecy']
  summary?: string
  participants?: string[]
  deadlines?: string[]
  openQuestions?: string[]
}

export interface FactInput {
  subject: string
  predicate: string
  object: string
  matterId?: Id
  authority?: Fact['authority']
  confidence?: number
  source?: Fact['source']
  evidence?: SourceRef[]
  validFrom?: string
  validTo?: string
}

export interface PreferenceInput {
  kind: PreferenceKind
  statement: string
  scope?: PreferenceScope
  source?: UserPreference['source']
  confidence?: number
  status?: UserPreference['status']
  priority?: UserPreference['priority']
  expiresAt?: string
}

export interface CommitmentInput {
  matterId: Id
  debtor: Commitment['debtor']
  creditor: string
  action: string
  dueAt?: string
  timezone?: string
  capability?: Commitment['capability']
  evidence: CommitmentEvidence[]
}

/**
 * In-memory ledger used by the skeleton and tests.
 * Production storage will be SQLite + FTS5, with this interface.
 */
export class Ledger {
  private readonly clock: HostPorts['clock']
  private readonly ids: HostPorts['ids']
  private readonly matters = new Map<Id, Matter>()
  private readonly facts = new Map<Id, Fact>()
  private readonly commitments = new Map<Id, Commitment>()
  private readonly preferences = new Map<Id, UserPreference>()
  private readonly links = new Map<Id, MatterLink>()
  private readonly updates = new Map<Id, UpdateProposal>()
  private readonly routes = new Map<string, Id>()
  private readonly routines = new Map<Id, Routine>()
  private readonly routinePatches = new Map<Id, RoutinePatch>()

  constructor(ports: HostPorts = systemPorts()) {
    this.clock = ports.clock
    this.ids = ports.ids
  }

  addMatter(input: MatterInput): Matter {
    const now = this.clock.now()
    const matter: Matter = {
      id: this.ids.next('matter'),
      title: input.title,
      status: 'active',
      domain: input.domain ?? 'general',
      secrecy: input.secrecy ?? 0,
      summary: input.summary,
      participants: input.participants ?? [],
      deadlines: input.deadlines ?? [],
      openQuestions: input.openQuestions ?? [],
      createdAt: now,
      updatedAt: now,
    }
    this.matters.set(matter.id, matter)
    return matter
  }

  getMatter(id: Id): Matter | undefined {
    return this.matters.get(id)
  }

  listMatters(status: Matter['status'] = 'active'): Matter[] {
    return [...this.matters.values()].filter((m) => m.status === status)
  }

  private authorityRank(authority: Fact['authority']): number {
    return authority === 'user' ? 100 : authority === 'import' ? 60 : authority === 'tool' ? 60 : 40
  }

  remember(input: FactInput): Fact {
    const key = (f: Fact): boolean =>
      f.status === 'confirmed' &&
      !f.expiredAt &&
      f.subject === input.subject &&
      f.predicate === input.predicate &&
      (f.matterId ?? '') === (input.matterId ?? '')
    const current = [...this.facts.values()].find(key)
    const incomingRank = this.authorityRank(input.authority ?? 'user')
    const now = this.clock.now()
    if (current && current.object === input.object) {
      current.evidence = [...(current.evidence ?? []), ...(input.evidence ?? (input.source ? [input.source] : []))]
      if (!current.source && input.source) current.source = input.source
      if (incomingRank > this.authorityRank(current.authority)) current.authority = input.authority ?? current.authority
      current.lastSeenAt = now
      return current
    }
    if (current && incomingRank < this.authorityRank(current.authority)) {
      const shadow: Fact = {
        id: this.ids.next('fact'), matterId: input.matterId, subject: input.subject, predicate: input.predicate,
        object: input.object, recordedAt: now, authority: input.authority ?? 'inferred',
        confidence: input.confidence ?? 0.6, source: input.source, evidence: input.evidence,
        status: 'candidate', shadowedBy: current.id, validFrom: input.validFrom, validTo: input.validTo,
      }
      this.facts.set(shadow.id, shadow)
      return shadow
    }
    if (current) {
      current.status = 'superseded'
      current.validTo = input.validFrom ?? now
      current.expiredAt = now
    }
    const fact: Fact = {
      id: this.ids.next('fact'), matterId: input.matterId, subject: input.subject, predicate: input.predicate,
      object: input.object, recordedAt: now, authority: input.authority ?? 'user',
      confidence: input.confidence ?? 0.9, source: input.source, evidence: input.evidence ?? (input.source ? [input.source] : []),
      status: (input.authority ?? 'user') === 'user' ? 'confirmed' : 'candidate',
      validFrom: input.validFrom ?? now, validTo: input.validTo,
      supersedes: current?.id,
    }
    if (current) current.supersededBy = fact.id
    this.facts.set(fact.id, fact)
    return fact
  }

  listFacts(matterId?: Id, includeHistory = false): Fact[] {
    return [...this.facts.values()].filter(
      (f) =>
        (includeHistory || (f.status === 'confirmed' && !f.expiredAt && !f.deletedAt)) &&
        (matterId ? f.matterId === matterId : true),
    )
  }

  factHistory(id: Id): Fact[] {
    const chain: Fact[] = []
    let current = this.facts.get(id)
    while (current) {
      chain.unshift(current)
      current = current.supersedes ? this.facts.get(current.supersedes) : undefined
    }
    return chain
  }

  searchFacts(query: string, { matterId, limit = 3 }: { matterId?: Id; limit?: number } = {}): Fact[] {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean)
    return this.listFacts(matterId).filter((f) => {
      const text = `${f.subject} ${f.predicate} ${f.object}`.toLowerCase()
      return terms.every((t) => text.includes(t))
    }).sort((a, b) => this.authorityRank(b.authority) - this.authorityRank(a.authority) || b.recordedAt.localeCompare(a.recordedAt)).slice(0, limit)
  }

  addPreference(input: PreferenceInput): UserPreference {
    const pref: UserPreference = {
      id: this.ids.next('pref'),
      kind: input.kind,
      statement: input.statement,
      scope: input.scope ?? { level: 'global' },
      source: input.source ?? { type: 'user_explicit' },
      evidence: [],
      confidence: input.confidence ?? 0.9,
      status: input.status ?? 'confirmed',
      validFrom: this.clock.now(),
      expiresAt: input.expiresAt,
      priority: input.priority ?? (input.kind === 'taboo' ? 'hard' : 'soft'),
    }
    this.preferences.set(pref.id, pref)
    return pref
  }

  listPreferences(filter: { matterId?: Id; audience?: string; includeCandidates?: boolean } = {}): UserPreference[] {
    return [...this.preferences.values()].filter((p) => {
      if (p.status === 'deprecated') return false
      if (!filter.includeCandidates && p.status !== 'confirmed') return false
      if (p.scope.level === 'global') return true
      if (p.scope.level === 'matter') return p.scope.value === filter.matterId
      if (p.scope.level === 'audience') return !!filter.audience && p.scope.value === filter.audience
      return false
    })
  }

  addCommitment(input: CommitmentInput): Commitment {
    if (input.evidence.length === 0) {
      throw new Error('a commitment requires at least one evidence item')
    }
    const commitment: Commitment = {
      id: this.ids.next('cm'),
      matterId: input.matterId,
      debtor: input.debtor,
      creditor: input.creditor,
      action: input.action,
      dueAt: input.dueAt,
      timezone: input.timezone ?? 'Asia/Shanghai',
      status: 'open',
      evidence: input.evidence,
      capability: input.capability ?? 'none',
    }
    this.commitments.set(commitment.id, commitment)
    return commitment
  }

  openCommitments(matterId?: Id): Commitment[] {
    return [...this.commitments.values()].filter(
      (c) => c.status === 'open' && (matterId ? c.matterId === matterId : true),
    )
  }

  listCommitments(matterId?: Id): Commitment[] {
    return [...this.commitments.values()].filter((c) => (matterId ? c.matterId === matterId : true))
  }

  completeCommitment(id: Id, evidence: CommitmentEvidence[]): Commitment {
    if (evidence.length === 0) throw new Error('done requires external evidence; model self-report is not evidence')
    const commitment = this.commitments.get(id)
    if (!commitment) throw new Error(`unknown commitment: ${id}`)
    commitment.status = 'done'
    commitment.doneAt = this.clock.now()
    commitment.evidence.push(...evidence)
    return commitment
  }

  /** Soft delete with a tombstone; never hard-delete user data. */
  forget(kind: 'fact' | 'preference', id: Id): boolean {
    if (kind === 'fact') {
      const fact = this.facts.get(id)
      if (!fact) return false
      fact.status = 'deleted'
      fact.deletedAt = this.clock.now()
      return true
    }
    const pref = this.preferences.get(id)
    if (!pref) return false
    pref.status = 'deprecated'
    return true
  }

  /** Privacy deletion: tombstone evidence, revoke links/updates, clear summary. */
  purgeMatter(id: Id): { facts: number; links: number; updates: number; commitments: number; preferences: number; routes: number } {
    const matter = this.matters.get(id)
    if (!matter) throw new Error(`unknown matter: ${id}`)
    let facts = 0
    for (const fact of this.facts.values()) {
      if (fact.matterId === id && fact.status !== 'deleted') {
        fact.status = 'deleted'
        fact.object = '[purged]'
        fact.source = undefined
        fact.evidence = undefined
        fact.deletedAt = this.clock.now()
        fact.deletedReason = 'matter_purged'
        facts++
      }
    }
    let links = 0
    for (const link of this.links.values()) {
      if ((link.fromMatter === id || link.toMatter === id) && link.status !== 'rejected') { link.status = 'rejected'; links++ }
    }
    let updates = 0
    for (const update of this.updates.values()) {
      if ((update.sourceMatter === id || update.targetMatter === id) && update.status === 'pending') { update.status = 'rejected'; updates++ }
    }
    let commitments = 0
    for (const commitment of this.commitments.values()) {
      if (commitment.matterId === id && commitment.status === 'open') { commitment.status = 'dropped'; commitments++ }
    }
    let preferences = 0
    for (const pref of this.preferences.values()) {
      if (pref.scope.level === 'matter' && pref.scope.value === id && pref.status !== 'deprecated') { pref.status = 'deprecated'; preferences++ }
    }
    let routes = 0
    for (const [key, matterId] of this.routes.entries()) {
      if (matterId === id) { this.routes.delete(key); routes++ }
    }
    matter.status = 'archived'
    matter.title = '[purged]'
    matter.summary = undefined
    matter.updatedAt = this.clock.now()
    return { facts, links, updates, commitments, preferences, routes }
  }

  /** Association is a proposal first; only a human or a verified rule confirms it. */
  proposeLink(input: {
    fromMatter: Id
    toMatter: Id
    type: MatterLinkType
    confidence?: number
    evidence?: string[]
    createdBy?: MatterLink['createdBy']
  }): MatterLink {
    const link: MatterLink = {
      id: this.ids.next('link'),
      fromMatter: input.fromMatter,
      toMatter: input.toMatter,
      type: input.type,
      confidence: input.confidence ?? 0.5,
      evidence: input.evidence ?? [],
      status: 'candidate',
      createdBy: input.createdBy ?? 'agent',
      createdAt: this.clock.now(),
    }
    this.links.set(link.id, link)
    return link
  }

  listLinks(matterId?: Id, includeCandidates = true): MatterLink[] {
    return [...this.links.values()].filter((l) => {
      if (!includeCandidates && l.status !== 'confirmed') return false
      if (l.status === 'rejected') return false
      if (!matterId) return true
      return l.fromMatter === matterId || l.toMatter === matterId
    })
  }

  confirmLink(id: Id): MatterLink {
    const link = this.links.get(id)
    if (!link) throw new Error(`unknown link: ${id}`)
    link.status = 'confirmed'
    return link
  }

  /** Cross-matter writes are queued, never applied by the chat model. */
  proposeUpdate(input: { sourceMatter: Id; targetMatter: Id; change: string }): UpdateProposal {
    const proposal: UpdateProposal = {
      id: this.ids.next('upd'),
      sourceMatter: input.sourceMatter,
      targetMatter: input.targetMatter,
      change: input.change,
      status: 'pending',
      createdAt: this.clock.now(),
    }
    this.updates.set(proposal.id, proposal)
    return proposal
  }

  listUpdates(status?: UpdateProposal['status']): UpdateProposal[] {
    return [...this.updates.values()].filter((u) => (status ? u.status === status : true))
  }

  resolveUpdate(id: Id, status: 'applied' | 'rejected', rollback?: string): UpdateProposal {
    const proposal = this.updates.get(id)
    if (!proposal) throw new Error(`unknown update proposal: ${id}`)
    proposal.status = status
    if (rollback) proposal.rollback = rollback
    return proposal
  }

  findPreference(id: Id): UserPreference | undefined {
    return this.preferences.get(id)
  }

  addRoutine(input: Omit<Routine, 'id' | 'version' | 'status' | 'createdAt' | 'updatedAt'>): Routine {
    const now = this.clock.now()
    const routine: Routine = {
      ...input,
      id: this.ids.next('routine'),
      version: 1,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    }
    this.routines.set(routine.id, routine)
    return routine
  }

  listRoutines(status?: Routine['status']): Routine[] {
    return [...this.routines.values()].filter((r) => (status ? r.status === status : true))
  }

  staleRoutine(id: Id): Routine {
    const routine = this.routines.get(id)
    if (!routine) throw new Error(`unknown routine: ${id}`)
    if (routine.status !== 'active') throw new Error(`only active routines can go stale: ${id}`)
    routine.status = 'stale'
    routine.updatedAt = this.clock.now()
    return routine
  }

  deprecateRoutine(id: Id): Routine {
    const routine = this.routines.get(id)
    if (!routine) throw new Error(`unknown routine: ${id}`)
    routine.status = 'deprecated'
    routine.updatedAt = this.clock.now()
    return routine
  }

  restoreRoutine(id: Id): Routine {
    const routine = this.routines.get(id)
    if (!routine) throw new Error(`unknown routine: ${id}`)
    routine.status = 'draft'
    routine.updatedAt = this.clock.now()
    return routine
  }

  approveRoutine(id: Id): Routine {
    const routine = this.routines.get(id)
    if (!routine) throw new Error(`unknown routine: ${id}`)
    if (routine.status !== 'draft') throw new Error(`only draft routines can be approved: ${id}`)
    routine.status = 'active'
    routine.updatedAt = this.clock.now()
    return routine
  }

  archiveRoutine(id: Id): Routine {
    const routine = this.routines.get(id)
    if (!routine) throw new Error(`unknown routine: ${id}`)
    routine.status = 'archived'
    routine.updatedAt = this.clock.now()
    return routine
  }

  proposeRoutinePatch(
    routineId: Id,
    changes: RoutinePatch['changes'],
  ): RoutinePatch {
    const routine = this.routines.get(routineId)
    if (!routine) throw new Error(`unknown routine: ${routineId}`)
    const diff = Object.entries(changes)
      .map(([key, value]) => `- ${key}: ${JSON.stringify((routine as unknown as Record<string, unknown>)[key])}\n+ ${key}: ${JSON.stringify(value)}`)
      .join('\n')
    const before = Object.fromEntries(
      Object.keys(changes).map((key) => [key, (routine as unknown as Record<string, unknown>)[key]]),
    ) as RoutinePatch['before']
    const patch: RoutinePatch = {
      id: this.ids.next('rpatch'),
      routineId,
      baseVersion: routine.version,
      changes,
      before,
      diff,
      status: 'pending',
      createdAt: this.clock.now(),
    }
    this.routinePatches.set(patch.id, patch)
    return patch
  }

  listRoutinePatches(status?: RoutinePatch['status']): RoutinePatch[] {
    return [...this.routinePatches.values()].filter((p) => (status ? p.status === status : true))
  }

  applyRoutinePatch(id: Id): RoutinePatch {
    const patch = this.routinePatches.get(id)
    if (!patch || patch.status !== 'pending') throw new Error(`unknown or closed routine patch: ${id}`)
    const routine = this.routines.get(patch.routineId)
    if (!routine) throw new Error(`unknown routine: ${patch.routineId}`)
    for (const [key, value] of Object.entries(patch.changes)) {
      ;(routine as unknown as Record<string, unknown>)[key] = value
    }
    routine.version = Math.max(routine.version, patch.baseVersion) + 1
    routine.updatedAt = this.clock.now()
    patch.status = 'applied'
    return patch
  }

  revertRoutinePatch(id: Id): RoutinePatch {
    const patch = this.routinePatches.get(id)
    if (!patch || patch.status !== 'applied') throw new Error(`no applied routine patch: ${id}`)
    const routine = this.routines.get(patch.routineId)
    if (!routine) throw new Error(`unknown routine: ${patch.routineId}`)
    for (const [key, value] of Object.entries(patch.before)) {
      ;(routine as unknown as Record<string, unknown>)[key] = value
    }
    routine.version += 1
    routine.updatedAt = this.clock.now()
    patch.status = 'rolled_back'
    return patch
  }

  rejectRoutinePatch(id: Id): RoutinePatch {
    const patch = this.routinePatches.get(id)
    if (!patch) throw new Error(`unknown routine patch: ${id}`)
    patch.status = 'rejected'
    return patch
  }

  getRoute(key: string): Id | undefined {
    return this.routes.get(key)
  }

  setRoute(key: string, matterId: Id): void {
    this.routes.set(key, matterId)
  }

  toJSON(): LedgerSnapshot {
    return {
      version: 1,
      matters: [...this.matters.values()],
      facts: [...this.facts.values()],
      commitments: [...this.commitments.values()],
      preferences: [...this.preferences.values()],
      links: [...this.links.values()],
      updates: [...this.updates.values()],
      routes: Object.fromEntries(this.routes),
      routines: [...this.routines.values()],
      routinePatches: [...this.routinePatches.values()],
    }
  }

  static fromJSON(snapshot: LedgerSnapshot, ports: HostPorts = systemPorts()): Ledger {
    const ledger = new Ledger(ports)
    for (const m of snapshot.matters ?? []) ledger.matters.set(m.id, m)
    for (const f of snapshot.facts ?? []) ledger.facts.set(f.id, f)
    for (const c of snapshot.commitments ?? []) ledger.commitments.set(c.id, c)
    for (const p of snapshot.preferences ?? []) ledger.preferences.set(p.id, p)
    for (const l of snapshot.links ?? []) ledger.links.set(l.id, l)
    for (const u of snapshot.updates ?? []) ledger.updates.set(u.id, u)
    for (const [k, v] of Object.entries(snapshot.routes ?? {})) ledger.routes.set(k, v)
    for (const r of snapshot.routines ?? []) ledger.routines.set(r.id, r)
    for (const p of snapshot.routinePatches ?? []) ledger.routinePatches.set(p.id, p)
    return ledger
  }
}

export interface LedgerSnapshot {
  version: 1
  matters: Matter[]
  facts: Fact[]
  commitments: Commitment[]
  preferences: UserPreference[]
  links: MatterLink[]
  updates: UpdateProposal[]
  routes: Record<string, Id>
  routines: Routine[]
  routinePatches: RoutinePatch[]
}
