/** Shared temp-home setup for cases that need the deterministic fixture. */
import { cleanupWorkdir, createWorkdir } from '../lib/harness.mjs'
import { seedMorningLedger } from '../fixtures/morning-ledger.mjs'

/** Create a seeded temp HOME, run `fn(workdir)`, always clean up. */
export async function withSeededHome(label, fn) {
  const workdir = createWorkdir('seeded-' + label)
  try {
    await seedMorningLedger(workdir.home)
    return await fn(workdir)
  } finally {
    cleanupWorkdir(workdir)
  }
}

/** Create an empty temp HOME (fresh install path), run `fn`, always clean up. */
export async function withFreshHome(label, fn) {
  const workdir = createWorkdir('fresh-' + label)
  try {
    return await fn(workdir)
  } finally {
    cleanupWorkdir(workdir)
  }
}

/** True for a lowercase SHA-256 hex digest. */
export function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
