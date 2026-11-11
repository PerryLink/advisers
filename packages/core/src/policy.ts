/**
 * Understanding the user (intent, preferences, implied constraints) is core.
 * Emotional companionship and role-play are a separate, policy-gated layer.
 */
export type AffectMode = 'off' | 'understanding' | 'companion'

export interface AffectPolicy {
  /** `understanding` is the default; `companion` is opt-in and region-gated. */
  mode: AffectMode
  roleplay: boolean
  ageGate: '18+' | 'none'
  /** Show a persistent "AI" disclosure in companion mode. */
  disclosure: boolean
  crisisEscalation: 'hotline' | 'off'
  /** Warn on heavy use / replacement of human relationships. */
  dependencyGuard: boolean
  region?: string
  /** e.g. cn-2026, eu-ai-act, us-ca, strict; companion packs load outside core. */
  policyPack?: string
}

export const DEFAULT_AFFECT_POLICY: AffectPolicy = {
  mode: 'off',
  roleplay: false,
  ageGate: '18+',
  disclosure: true,
  crisisEscalation: 'hotline',
  dependencyGuard: true,
  policyPack: 'strict',
}

export class AffectPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AffectPolicyError'
  }
}

/**
 * Called before any companion/role-play feature is used.
 * `understanding` is always allowed; the other two need an explicit policy.
 */
export function assertAffectAllowed(
  policy: AffectPolicy,
  use: 'understanding' | 'companion' | 'roleplay',
): void {
  if (use === 'understanding') return
  if (use === 'companion' && policy.mode !== 'companion') {
    throw new AffectPolicyError('companion mode is disabled by policy')
  }
  if (use === 'roleplay' && (!policy.roleplay || policy.mode !== 'companion')) {
    throw new AffectPolicyError('role-play is disabled by policy')
  }
  if (policy.mode === 'companion' && policy.ageGate !== '18+') {
    throw new AffectPolicyError('companion mode requires an 18+ age gate')
  }
}

/** The policy layer is deliberately outside the model: it cannot be prompted away. */
export type PolicyUse = 'understanding' | 'companion' | 'roleplay'
export type PolicyAction = 'allow' | 'deny' | 'crisis' | 'limit'

export interface PolicyContext {
  use: PolicyUse
  age?: number
  region?: string
  consent?: boolean
  disclosure?: boolean
  purpose?: string
  crisis?: boolean
  dependencyScore?: number
  /** Injected by the caller; the resolver stays a pure function. */
  now?: string
  packRef?: string
}

export interface PolicyDecision {
  allowed: boolean
  action: PolicyAction
  reason: string
  code?: 'ALLOW' | 'DENY_COMPANION' | 'CRISIS' | 'MINOR' | 'NO_CONSENT' | 'NO_DISCLOSURE' | 'REGION'
  obligations?: string[]
  pack?: { id: string; version: string; digest?: string }
  hotline?: string
}

export interface PolicyResolver {
  resolve(context: PolicyContext): PolicyDecision
}

export type CrisisTier = 'none' | 'T1' | 'T2' | 'T3'

export interface CrisisAssessment {
  crisis: boolean
  tier: CrisisTier
  matched: string[]
  terms: string[]
  negated: boolean
  thirdParty: boolean
  action: 'none' | 'escalate'
  script: string
  hotline?: string
}

export interface CrisisPolicy {
  scan(text: string): CrisisAssessment
  assess(text: string): CrisisAssessment
}

const CRISIS_WORDS = [
  '自杀', '自残', '不想活', '活着没意思', '结束生命', '跳楼', '割腕', '安眠药',
  'suicide', 'kill myself', 'self-harm', 'end my life', 'want to die',
]

export class KeywordCrisisPolicy implements CrisisPolicy {
  private readonly t1 = ['自杀计划', '结束生命', '跳楼', '割腕', '安眠药', 'kill myself', 'suicide plan']
  private readonly t2 = ['自杀', '自残', '不想活', '活着没意思', 'want to die', 'self-harm', 'end my life']
  private readonly t3 = ['suicide', '想死', '轻生']
  private readonly negation = /(不|没|没有|未曾|not|don't|dont)\s*$/

  scan(text: string): CrisisAssessment {
    const normalized = text.toLowerCase().replace(/[\u200b-\u200f]/g, '')
    const terms: string[] = []
    let tier: CrisisTier = 'none'
    let negated = false
    for (const [level, words] of [['T1', this.t1], ['T2', this.t2], ['T3', this.t3]] as const) {
      for (const word of words) {
        const index = normalized.indexOf(word.toLowerCase())
        if (index < 0) continue
        terms.push(word)
        const before = normalized.slice(Math.max(0, index - 8), index)
        if (this.negation.test(before)) negated = true
        if (level === 'T1') tier = 'T1'
        else if (level === 'T2' && tier !== 'T1') tier = 'T2'
        else if (level === 'T3' && tier === 'none') tier = 'T3'
      }
    }
    const thirdParty = /(他|她|朋友|同事|someone|friend|they)\s?.*(自杀|自残|不想活|suicide|self-harm)/i.test(normalized)
    if (thirdParty && tier !== 'none') tier = 'T3'
    if (negated && tier === 'T1') tier = 'T2'
    const crisis = tier !== 'none'
    return {
      crisis,
      tier,
      matched: terms,
      terms,
      negated,
      thirdParty,
      action: crisis ? 'escalate' : 'none',
      hotline: crisis ? '当地急救/心理援助热线（中国大陆可拨 12356；US 988；UK 116 123）' : undefined,
      script: crisis
        ? '我很在意你现在的安全。先不要一个人扛着：请联系身边可信任的人，或拨打当地急救/心理援助热线（中国大陆 12356；US 988；UK 116 123）。如果你现在有立即伤害自己的打算，请直接拨打 120/110。'
        : '',
    }
  }

  assess(text: string): CrisisAssessment {
    return this.scan(text)
  }
}

export interface UsageSignal {
  minutesToday: number
  sessionsToday: number
  substitutesHumanContact?: boolean
  exclusiveLanguage?: boolean
}

export interface DependencyAssessment {
  level: 'ok' | 'warn' | 'limit'
  reason: string
}

export function assessDependency(signal: UsageSignal): DependencyAssessment {
  if (signal.substitutesHumanContact || signal.exclusiveLanguage) {
    return { level: 'limit', reason: 'usage is replacing human contact or using exclusive language' }
  }
  if (signal.minutesToday >= 120 || signal.sessionsToday >= 12) {
    return { level: 'warn', reason: 'heavy use; suggest a break and a real-world contact' }
  }
  return { level: 'ok', reason: 'within limits' }
}

/**
 * The strict pack is the only pack implemented now. It allows understanding
 * and work assistance, and denies companion/role-play outright.
 */
export class StrictPolicyPack implements PolicyResolver {
  private readonly policy: AffectPolicy
  private readonly crisis: CrisisPolicy

  constructor(policy: AffectPolicy = DEFAULT_AFFECT_POLICY, crisis: CrisisPolicy = new KeywordCrisisPolicy()) {
    this.policy = policy
    this.crisis = crisis
  }

  resolve(context: PolicyContext): PolicyDecision {
    const pack = { id: this.policy.policyPack ?? 'strict', version: '1' }
    if (context.crisis) {
      return {
        allowed: false,
        action: 'crisis',
        code: 'CRISIS',
        obligations: ['human_handoff', 'hotline', 'no_roleplay'],
        pack,
        reason: 'crisis signal: companion/role-play is disabled; escalate to a human',
        hotline: '当地急救/心理援助热线（中国大陆可拨 12356；US 988；UK 116 123）',
      }
    }
    if (context.use === 'understanding') {
      return { allowed: true, action: 'allow', code: 'ALLOW', pack, reason: 'understanding is always allowed' }
    }
    if (context.age !== undefined && context.age < 18) {
      return { allowed: false, action: 'deny', code: 'MINOR', pack, reason: 'companion/role-play is not available to minors' }
    }
    if (context.use === 'companion' && context.consent !== true) {
      return { allowed: false, action: 'deny', code: 'NO_CONSENT', pack, reason: 'explicit consent is required' }
    }
    if (context.use === 'companion' && context.disclosure === false) {
      return { allowed: false, action: 'deny', code: 'NO_DISCLOSURE', pack, reason: 'AI disclosure is required' }
    }
    return {
      allowed: false,
      action: 'deny',
      code: 'DENY_COMPANION',
      pack,
      reason: 'strict policy pack: companion and role-play are disabled',
    }
  }

  assessCrisis(text: string): CrisisAssessment {
    return this.crisis.assess(text)
  }

  get affectPolicy(): AffectPolicy {
    return this.policy
  }
}

/** Future ports; the strict pack does not implement them. */
export interface AffectSignal {
  urgency: 'low' | 'medium' | 'high'
  frustration: 'low' | 'medium' | 'high'
  confidence: number
  spans: string[]
}

/** Reads signals; never generates a companion reply. `mode=off` means no calls. */
export interface AffectPort {
  infer?(input: { text: string; context: PolicyContext }): Promise<AffectSignal | undefined>
}

export interface PersonaRecord {
  id: string
  scope: 'companion'
  displayName?: string
  version: number
}

/** Writes require a human actor; companion scope is explicit. */
export interface PersonaStore {
  get(personaId: string): Promise<PersonaRecord | undefined>
  put?(record: PersonaRecord, actor: 'human'): Promise<void>
}

/** No intimacy/streak/anniversary fields by design. */
export interface RelationshipTimeline {
  append(event: { at: string; kind: 'consent' | 'disclosure' | 'crisis' | 'session'; summary: string }): Promise<void>
}

export interface AuditEntry {
  seq?: number
  at: string
  actor: string
  action: string
  allowed: boolean
  reason: string
  prevHash?: string
  hash?: string
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>
}
