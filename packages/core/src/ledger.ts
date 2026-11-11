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

  remember(input: FactInput): Fact {
    const existing = [...this.facts.values()].find(
      (f) =>
        f.status !== 'deleted' &&
        f.subject === input.subject &&
        f.predicate === input.predicate &&
        f.object === input.object,
    )
    if (existing) return existing

    const fact: Fact = {
      id: this.ids.next('fact'),
      matterId: input.matterId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      recordedAt: this.clock.now(),
      authority: input.authority ?? 'user',
      confidence: input.confidence ?? 0.9,
      source: input.source,
      status: 'confirmed',
    }
    this.facts.set(fact.id, fact)
    return fact
  }

  listFacts(matterId?: Id): Fact[] {
    return [...this.facts.values()].filter(
      (f) => f.status !== 'deleted' && (matterId ? f.matterId === matterId : true),
    )
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

  completeCommitment(id: Id, evidence: CommitmentEvidence[]): Commitment {
    if (evidence.length === 0) throw new Error('done requires external evidence; model self-report is not evidence')
    const commitment = this.commitments.get(id)
    if (!commitment) throw new Error(`unknown commitment: ${id}`)
    commitment.status = 'done'
    commitment.evidence.push(...evidence)
    return commitment
  }

  /** Soft delete with a tombstone; never hard-delete user data. */
  forget(kind: 'fact' | 'preference', id: Id): boolean {
    if (kind === 'fact') {
      const fact = this.facts.get(id)
      if (!fact) return false
      fact.status = 'deleted'
      return true
    }
    const pref = this.preferences.get(id)
    if (!pref) return false
    pref.status = 'deprecated'
    return true
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

  approveRoutine(id: Id): Routine {
    const routine = this.routines.get(id)
    if (!routine) throw new Error(`unknown routine: ${id}`)
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
    const patch: RoutinePatch = {
      id: this.ids.next('rpatch'),
      routineId,
      baseVersion: routine.version,
      changes,
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
