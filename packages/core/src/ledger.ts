import type { HostPorts } from './ports.ts'
import { systemPorts } from './ports.ts'
import type {
  Commitment,
  CommitmentEvidence,
  Fact,
  Id,
  Matter,
  PreferenceKind,
  PreferenceScope,
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

  listPreferences(filter: { matterId?: Id; includeCandidates?: boolean } = {}): UserPreference[] {
    return [...this.preferences.values()].filter((p) => {
      if (p.status === 'deprecated') return false
      if (!filter.includeCandidates && p.status !== 'confirmed') return false
      if (p.scope.level === 'global') return true
      if (p.scope.level === 'matter') return p.scope.value === filter.matterId
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
}
