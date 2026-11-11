import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Verification entries are intentionally small and local:
 *   "file:out/weekly.docx"  -> file exists and is non-empty
 *   anything else           -> manual check (never auto-passes a failed file)
 */
export function checkRoutine(routine, { cwd = process.cwd() } = {}) {
  const results = []
  for (const entry of routine.verification ?? []) {
    if (entry.startsWith('file:')) {
      const path = resolve(cwd, entry.slice(5).trim())
      const exists = existsSync(path)
      const bytes = exists ? statSync(path).size : 0
      results.push({ entry, kind: 'file', ok: exists && bytes > 0, path, bytes })
    } else {
      results.push({ entry, kind: 'manual', ok: true })
    }
  }
  return { ok: results.every((r) => r.ok), results }
}
