import { DEFAULT_AFFECT_POLICY, KeywordCrisisPolicy } from 'advisers-core'
import type {
  AffectPolicy,
  CrisisAssessment,
  CrisisPolicy,
  PolicyContext,
  PolicyDecision,
  PolicyResolver,
} from 'advisers-core'

/** The strict pack allows understanding/work assistance and denies companion/roleplay. */
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

export default StrictPolicyPack
