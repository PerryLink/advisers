import type { IntentBrief } from './intent.ts'

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

export interface AssociationHint {
  title: string
  why: string
  matterId?: Id
}

/** @deprecated Use AssociationHint; "LinkCard" collides with IM cards. */
export type LinkCard = AssociationHint

export type MatterLinkType =
  | 'same_entity'
  | 'part_of'
  | 'depends_on'
  | 'conflicts'
  | 'similar'
  | 'temporal'
  | 'document'
  | 'impact'

export interface MatterLink {
  id: Id
  fromMatter: Id
  toMatter: Id
  type: MatterLinkType
  confidence: number
  evidence: string[]
  status: 'candidate' | 'confirmed' | 'rejected'
  createdBy: 'user' | 'agent'
  createdAt: IsoDate
}

export interface UpdateProposal {
  id: Id
  sourceMatter: Id
  targetMatter: Id
  change: string
  status: 'pending' | 'applied' | 'rejected'
  createdAt: IsoDate
  rollback?: string
}

/** Human-owned identity document. The agent may propose, never write. */
export interface SoulDocument {
  id: Id
  version: number
  content: string
  updatedAt: IsoDate
  updatedBy: 'human'
}

/** One continuous relationship; a thread can contain many matters/episodes. */
export interface Thread {
  id: Id
  principalId: string
  title?: string
  createdAt: IsoDate
  updatedAt: IsoDate
}

export interface Episode {
  id: Id
  threadId: Id
  matterId?: Id
  startedAt: IsoDate
  endedAt?: IsoDate
  summary?: string
}

export interface TurnContext {
  matter: Matter
  threadId?: Id
  intent?: IntentBrief
  prompt: string
  hints: AssociationHint[]
  usedTokens: number
}

export type RoutineStatus = 'draft' | 'active' | 'archived'

/** A procedure learned from a successful task; proposal first, human approves. */
export interface Routine {
  id: Id
  name: string
  description: string
  trigger: string[]
  steps: string[]
  preferences: string[]
  pitfalls: string[]
  verification: string[]
  scope?: string
  version: number
  status: RoutineStatus
  createdBy: 'user' | 'agent'
  createdAt: IsoDate
  updatedAt: IsoDate
}

export interface RoutinePatch {
  id: Id
  routineId: Id
  baseVersion: number
  changes: Partial<Pick<Routine, 'name' | 'description' | 'trigger' | 'steps' | 'preferences' | 'pitfalls' | 'verification' | 'scope'>>
  diff: string
  status: 'pending' | 'applied' | 'rejected'
  createdAt: IsoDate
}
