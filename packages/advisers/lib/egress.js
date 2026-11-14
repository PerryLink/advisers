/**
 * Egress guard for matter-scoped model calls.
 *
 * Matter.secrecy is a numeric level `0 | 1 | 2 | 3` (packages/core/src/types.ts).
 * The old research guard compared it to the string `'secret'`, which can never
 * be true for the stored shape — a protected matter was silently allowed to
 * egress. Until the 0–3 secrecy levels are productized we fail closed for any
 * level above 0.
 */

const BLOCK_ABOVE = 0

export function secrecyLevel(matter) {
  const raw = matter?.secrecy
  if (raw === undefined || raw === null) return 0
  const level = Number(raw)
  return Number.isFinite(level) ? level : Number.POSITIVE_INFINITY
}

export function egressDeniedReason(matter, command = 'research') {
  if (!matter) return `${command} is disabled: active matter not found; egress requires a normal matter`
  const level = secrecyLevel(matter)
  if (level > BLOCK_ABOVE) {
    return `${command} is disabled for protected matters (secrecy=${Number.isFinite(level) ? level : 'invalid'}); egress requires a matter with secrecy 0`
  }
  return null
}
