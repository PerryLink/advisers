/**
 * Understanding the user (intent, preferences, implied constraints) is core.
 * Emotional companionship and role-play are a separate, policy-gated layer.
 */
export type AffectMode = 'off' | 'understanding' | 'companion'

export interface AffectPolicy {
  /** `understanding` is the default; `companion` is opt-in and region-gated. */
  mode: AffectMode
  roleplay: boolean
  ageGate: 'none' | '18+'
  /** Show a persistent "AI" disclosure in companion mode. */
  disclosure: boolean
  crisisEscalation: 'off' | 'hotline'
  /** Warn on heavy use / replacement of human relationships. */
  dependencyGuard: boolean
  region?: string
  /** e.g. cn-2026, eu-ai-act, us-ca, strict; companion packs load outside core. */
  policyPack?: string
}

export const DEFAULT_AFFECT_POLICY: AffectPolicy = {
  mode: 'off',
  roleplay: false,
  ageGate: 'none',
  disclosure: true,
  crisisEscalation: 'off',
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
