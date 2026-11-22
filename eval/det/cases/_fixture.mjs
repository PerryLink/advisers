/** Shared temp-home setup for cases that need the deterministic fixture. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, check, cleanupWorkdir, createWorkdir, parseJson, runCli } from '../lib/harness.mjs'
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

/* -------------------------------------------------------------------------- */
/* 0.4.0 fixtures for the kb / mail / policy groups                           */
/*                                                                            */
/* These helpers keep every new case on the same rules as the 0.3.0 ones:     */
/* temp ADVISERS_HOME, fixed clock where the CLI accepts one, no real         */
/* ~/.advisers, no network, no model key. The ledger rows below are written   */
/* through the same SqliteStore the CLI uses with fixed ids/timestamps so      */
/* page/fact output is reproducible; they are additive helpers and do not      */
/* change the morning-ledger fixture or its golden hash.                     */
/* -------------------------------------------------------------------------- */

/** Fixed ledger clock/ids used by the 0.4 KB and policy fixtures. */
export const KB_FIXTURE_CLOCK = '2026-01-01T00:00:00.000Z'
export const KB_FIXTURE_MATTER_ID = 'matter_eval'
export const KB_FIXTURE_CLIENT_ID = 'cl_eval'
export const KB_FIXTURE_PROJECT_ID = 'prj_eval'

/** Write one input file into the case's `<TMP>/work` directory; returns its path. */
export function writeWorkFile(workdir, name, content) {
  mkdirSync(workdir.work, { recursive: true })
  const path = join(workdir.work, name)
  writeFileSync(path, content)
  return path
}

/** Run one CLI invocation and parse stdout as JSON (no throwing). */
export function runJsonCli(workdir, args, options = {}) {
  const run = runCli(workdir, args, options)
  return { run, parsed: parseJson(run.stdout) }
}

/** Open the same SQLite store the CLI uses (`<HOME>/state.db`); caller closes it. */
export async function openStateStore(home) {
  const { SqliteStore } = await import('../../../packages/advisers/lib/sqlite.js')
  return new SqliteStore(join(home, 'state.db'))
}

/** Return parsed stdout or throw an actionable error (for use inside check()). */
export function jsonValue(result, label) {
  if (!result?.parsed?.ok) {
    throw new Error((label ?? 'command') + ' stdout is not JSON: ' + (result?.parsed?.error ?? 'no result') + '; first bytes: ' + JSON.stringify(String(result?.run?.stdout ?? '').slice(0, 120)))
  }
  return result.parsed.value
}

/** Fail a check when any of the given CLI runs recorded a network attempt. */
export function checkNoNetwork(checks, id, runs) {
  return check(checks, id, () => {
    const attempts = []
    for (const item of runs) {
      const run = item?.run ?? item
      if (Array.isArray(run?.network)) attempts.push(...run.network)
    }
    if (attempts.length) throw new Error(JSON.stringify(attempts.slice(0, 5)))
  })
}

/**
 * Seed a small deterministic ledger for the KB page and fact as-of gates:
 * one client + project + matter, one open commitment and a fact chain
 * (old -> new) plus one recordedAt-only fact.
 *
 * The CLI reads this database; ids/timestamps are fixed so page ids and
 * `fact as-of` output are reproducible across fresh homes.
 */
export async function seedKbLedger(home) {
  const store = await openStateStore(home)
  try {
    store.mutate(() => {
      store.insertMatter({
        id: KB_FIXTURE_MATTER_ID,
        title: '客户甲 · 官网改版',
        status: 'active',
        domain: 'work',
        secrecy: 0,
        participants: [],
        deadlines: [],
        openQuestions: [],
        createdAt: KB_FIXTURE_CLOCK,
        updatedAt: KB_FIXTURE_CLOCK,
      })
      store.insertCommitment({
        id: 'cm_eval_1',
        matterId: KB_FIXTURE_MATTER_ID,
        debtor: 'user',
        creditor: '客户甲',
        action: '发出首页视觉稿',
        timezone: 'Asia/Shanghai',
        status: 'open',
        evidence: [],
        capability: 'none',
        createdAt: '2026-01-02T00:00:00.000Z',
        dueAt: '2026-12-01T10:00:00+08:00',
      })
      store.insertFact({
        id: 'fact_old',
        matterId: KB_FIXTURE_MATTER_ID,
        subject: '客户甲',
        predicate: 'quote.total',
        object: '80000',
        recordedAt: '2026-01-01T00:00:00.000Z',
        authority: 'user',
        confidence: 0.9,
        evidence: [],
        status: 'superseded',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2026-06-01T00:00:00.000Z',
        supersededBy: 'fact_new',
      })
      store.insertFact({
        id: 'fact_new',
        matterId: KB_FIXTURE_MATTER_ID,
        subject: '客户甲',
        predicate: 'quote.total',
        object: '90000',
        recordedAt: '2026-06-01T00:00:00.000Z',
        authority: 'user',
        confidence: 0.9,
        evidence: [],
        status: 'confirmed',
        validFrom: '2026-06-01T00:00:00.000Z',
        supersedes: 'fact_old',
      })
      store.insertFact({
        id: 'fact_fallback',
        matterId: KB_FIXTURE_MATTER_ID,
        subject: '客户甲',
        predicate: 'contact.channel',
        object: 'email',
        recordedAt: '2026-01-15T00:00:00.000Z',
        authority: 'user',
        confidence: 0.9,
        evidence: [],
        status: 'confirmed',
      })
    })
    store.addClient({ name: '客户甲', id: KB_FIXTURE_CLIENT_ID })
    store.addProject({ clientId: KB_FIXTURE_CLIENT_ID, name: '官网改版', startedAt: '2026-01-01', id: KB_FIXTURE_PROJECT_ID })
    store.setMatterClient(KB_FIXTURE_MATTER_ID, { clientId: KB_FIXTURE_CLIENT_ID, projectId: KB_FIXTURE_PROJECT_ID })
  } finally {
    store.close()
  }
}

/* -------------------------------------------------------------------------- */
/* 0.5.0 WF4 fixtures: accepted TOS record, memory (fact as-of) ledger         */
/* -------------------------------------------------------------------------- */

/**
 * Seed `<HOME>/tos.json` with the packaged TOS version/hash (0600), so the
 * read-only ledger facade used by the DSH projection can read a real ledger.
 * Mirrors packages/advisers/test/tos-fixture.js without importing test code.
 */
export function seedAcceptedTos(home) {
  const manifestPath = join(REPO_ROOT, 'packages/advisers/lib/tos/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entry = (manifest.files ?? []).find((file) => file.source === manifest.canonical) ?? (manifest.files ?? [])[0]
  if (!entry?.sha256) throw new Error('packaged TOS manifest is missing the TOS file hash')
  mkdirSync(home, { recursive: true })
  const target = join(home, 'tos.json')
  writeFileSync(target, JSON.stringify({
    version: manifest.version,
    sha256: entry.sha256,
    acceptedAt: '2026-11-17T00:00:00.000Z',
    channel: 'interactive',
    nonInteractive: false,
  }) + '\n', { mode: 0o600 })
  return target
}

/** Fixed ids/timestamps of the memory (fact as-of) fixture. */
export const MEMORY_FIXTURE_MATTER_ID = 'm_mem_alpha'
export const MEMORY_FIXTURE_BETA_MATTER_ID = 'm_mem_beta'
export const MEMORY_FIXTURE_CLIENT_ID = 'cl_mem_alpha'
export const MEMORY_FIXTURE_BETA_CLIENT_ID = 'cl_mem_beta'

/**
 * Seed the memory/fact-as-of fixture: two clients (one matter each; the beta
 * matter is secrecy 1), a supersede chain with overlapping valid intervals, a
 * recordedAt-only fallback fact and a parallel matter/predicate pair used by the
 * filter cases. Pure store writes with fixed ids/timestamps, so two runs on the
 * same rows produce byte-identical CLI output.
 *
 * `extras` is a list of extra fact rows for the case-specific edge cases (bad
 * timestamp, tombstone, broken chain, quote sanitisation) so the core fixture
 * stays warning-free for every other case.
 */
export async function seedMemoryFacts(home, { extras = [] } = {}) {
  const store = await openStateStore(home)
  try {
    store.mutate(() => {
      store.insertMatter({
        id: MEMORY_FIXTURE_MATTER_ID, title: '客户甲 · 官网改版', status: 'active', domain: 'work', secrecy: 0,
        participants: [], deadlines: [], openQuestions: [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      })
      store.insertMatter({
        id: MEMORY_FIXTURE_BETA_MATTER_ID, title: '客户乙 · 品牌升级', status: 'active', domain: 'work', secrecy: 1,
        participants: [], deadlines: [], openQuestions: [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      })
      const fact = (row) => store.insertFact({
        authority: 'user', confidence: 0.9, evidence: [], status: 'confirmed',
        matterId: MEMORY_FIXTURE_MATTER_ID, subject: '客户甲',
        ...row,
      })
      // Supersede chain: early -> mid -> new. Overlap between mid and new only.
      fact({ id: 'fact_early', predicate: 'quote.total', object: '70000', recordedAt: '2025-12-01T00:00:00.000Z', validFrom: '2025-12-01T00:00:00.000Z', validTo: '2026-01-01T00:00:00.000Z', status: 'superseded', supersededBy: 'fact_mid' })
      fact({ id: 'fact_mid', predicate: 'quote.total', object: '80000', recordedAt: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-06-01T00:00:00.000Z', status: 'superseded', supersedes: 'fact_early', supersededBy: 'fact_new' })
      fact({ id: 'fact_new', predicate: 'quote.total', object: '90000', recordedAt: '2026-06-01T00:00:00.000Z', validFrom: '2026-06-01T00:00:00.000Z', status: 'confirmed', supersedes: 'fact_mid' })
      // RecordedAt-only fact: validFrom is missing, so as-of falls back to recordedAt.
      fact({ id: 'fact_fallback', predicate: 'contact.channel', object: 'email', recordedAt: '2026-01-15T00:00:00.000Z' })
      // Two overlapping valid intervals for one (subject, predicate, matter) group.
      fact({ id: 'fact_overlap_a', predicate: 'scope.deliverable', object: 'A', recordedAt: '2026-02-01T00:00:00.000Z', validFrom: '2026-02-01T00:00:00.000Z', validTo: '2026-08-01T00:00:00.000Z' })
      fact({ id: 'fact_overlap_b', predicate: 'scope.deliverable', object: 'B', recordedAt: '2026-03-01T00:00:00.000Z', validFrom: '2026-03-01T00:00:00.000Z', validTo: '2026-07-01T00:00:00.000Z' })
      // Filter fixture: same predicate on two matters/clients, one subject each.
      fact({ id: 'fact_alpha_stage', predicate: 'project.stage', object: 'design', recordedAt: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z' })
      fact({
        id: 'fact_beta_stage', matterId: MEMORY_FIXTURE_BETA_MATTER_ID, subject: '客户乙',
        predicate: 'project.stage', object: 'build', recordedAt: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z',
      })
      for (const row of extras) fact(row)
    })
    store.addClient({ name: '客户甲', id: MEMORY_FIXTURE_CLIENT_ID })
    store.addClient({ name: '客户乙', id: MEMORY_FIXTURE_BETA_CLIENT_ID })
    store.setMatterClient(MEMORY_FIXTURE_MATTER_ID, { clientId: MEMORY_FIXTURE_CLIENT_ID })
    store.setMatterClient(MEMORY_FIXTURE_BETA_MATTER_ID, { clientId: MEMORY_FIXTURE_BETA_CLIENT_ID })
  } finally {
    store.close()
  }
}
