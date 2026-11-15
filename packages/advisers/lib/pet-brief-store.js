/**
 * Read-only ledger snapshot loader for `advisers pet-brief`.
 *
 * Unlike `loadLedger()` in the CLI, this never creates, migrates, or writes
 * the store: it opens SQLite with `readOnly: true`, or reads `state.json`
 * as-is. Used only by the Pet Brief producer path.
 */
import { existsSync, readFileSync } from 'node:fs'
import { SqliteStore } from './sqlite.js'

export class PetBriefStoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PetBriefStoreError'
    this.code = code
  }
}

/**
 * @param {object} options
 * @param {'sqlite'|'json'} [options.store] store backend (ADVISERS_STORE)
 * @param {string} options.dbPath SQLite database path
 * @param {string} options.statePath JSON ledger path
 * @returns {object} LedgerSnapshot v1 (plain JSON object)
 */
export function readLedgerSnapshotReadOnly({ store = 'sqlite', dbPath, statePath } = {}) {
  if (store === 'json') {
    if (!statePath || !existsSync(statePath)) {
      throw new PetBriefStoreError('E_STORE', `store not found: ${statePath ?? '(no state path)'}; run \`advisers init\``)
    }
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'))
    } catch (error) {
      throw new PetBriefStoreError('E_STORE', `cannot read JSON ledger ${statePath}: ${error.message}`)
    }
  }
  if (!dbPath || !existsSync(dbPath)) {
    throw new PetBriefStoreError('E_STORE', `store not found: ${dbPath ?? '(no database path)'}; run \`advisers init\``)
  }
  let database
  try {
    database = new SqliteStore(dbPath, { readOnly: true })
    return database.load()
  } catch (error) {
    throw new PetBriefStoreError('E_STORE', `cannot read SQLite store ${dbPath} read-only: ${error.message}`)
  } finally {
    if (database) {
      try { database.close() } catch {}
    }
  }
}
