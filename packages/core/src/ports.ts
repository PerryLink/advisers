import type { Id, IsoDate, SoulDocument } from './types.ts'

/** Injectable time source; tests can freeze it. */
export interface Clock {
  now(): IsoDate
}

/** Injectable id source; tests can make ids deterministic. */
export interface Ids {
  next(prefix: string): Id
}

/** Human-owned identity document. The agent may propose, never write. */
export interface SoulStore {
  load(): SoulDocument | undefined
  save(doc: SoulDocument): void
}

/** Idempotency port; links must persist this so a restart does not replay. */
export interface SeenStore {
  has(key: string): boolean
  add(key: string): void
}

/** Persistence port. The in-memory skeleton ignores it. */
export interface Store {
  load(): unknown | undefined
  save(snapshot: unknown): void
}

/** Optional model port. Without it, a host can print the focus frame instead. */
export interface ModelPort {
  complete(input: { prompt: string }): AsyncIterable<string>
}

/**
 * The only host boundary of the core. The cordis-only and DSH distributions
 * provide their own implementations; core never imports either host.
 */
export interface HostPorts {
  clock: Clock
  ids: Ids
  soul?: SoulStore
  store?: Store
  model?: ModelPort
}

export function systemPorts(): HostPorts {
  let seq = 0
  return {
    clock: { now: () => new Date().toISOString() },
    ids: {
      next: (prefix) => `${prefix}_${Date.now().toString(36)}_${++seq}`,
    },
  }
}
