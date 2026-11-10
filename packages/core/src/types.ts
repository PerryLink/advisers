export type Id = string
export type IsoDate = string

export type Secrecy = 0 | 1 | 2 | 3
export type MatterStatus = 'active' | 'paused' | 'archived'

/**
 * A matter is a dimension on the three ledgers, not a fourth ledger.
 * Commitments, facts, and decisions point at it; the global user model does not.
 */
export interface Matter {
  id: Id
  title: string
  status: MatterStatus
  domain: string
  secrecy: Secrecy
  summary?: string
  participants: string[]
  deadlines: IsoDate[]
  openQuestions: string[]
  createdAt: IsoDate
  updatedAt: IsoDate
}

export type Authority = 'user' | 'tool' | 'inferred'
export type FactStatus = 'candidate' | 'confirmed' | 'superseded' | 'deleted'

export interface SourceRef {
  quote?: string
  ref?: string
}

export interface Fact {
  id: Id
  matterId?: Id
  subject: string
  predicate: string
  object: string
  validFrom?: IsoDate
  validTo?: IsoDate
  recordedAt: IsoDate
  authority: Authority
  confidence: number
  source?: SourceRef
  status: FactStatus
  supersedes?: Id
}

export type Debtor = 'user' | 'agent' | `third:${string}`
export type CommitmentStatus = 'open' | 'done' | 'snoozed' | 'dropped'
export type Capability = 'calendar' | 'todo' | 'none'

export interface CommitmentEvidence {
  sessionId: string
  turnId: string
  quote: string
}

export interface Commitment {
  id: Id
  matterId: Id
  debtor: Debtor
  creditor: string
  action: string
  dueAt?: IsoDate
  timezone: string
  status: CommitmentStatus
  evidence: CommitmentEvidence[]
  capability: Capability
  supersedes?: Id
}

export type PreferenceKind =
  | 'preference'
  | 'constraint'
  | 'context'
  | 'taboo'
  | 'relationship'
  | 'goal'

export type PreferenceSourceType = 'user_explicit' | 'inferred' | 'imported' | 'tool'
export type PreferenceStatus = 'candidate' | 'confirmed' | 'deprecated'
export type PreferencePriority = 'hard' | 'soft'

export interface PreferenceScope {
  level: 'global' | 'project' | 'matter' | 'audience'
  value?: string
}

export interface PreferenceSource {
  type: PreferenceSourceType
  quote?: string
  ref?: string
}

export interface UserPreference {
  id: Id
  kind: PreferenceKind
  statement: string
  scope: PreferenceScope
  source: PreferenceSource
  evidence: SourceRef[]
  confidence: number
  status: PreferenceStatus
  validFrom: IsoDate
  lastConfirmed?: IsoDate
  expiresAt?: IsoDate
  priority: PreferencePriority
}

export interface LinkCard {
  title: string
  why: string
  matterId?: Id
}

export interface TurnContext {
  matter: Matter
  prompt: string
  hints: LinkCard[]
  usedTokens: number
}
