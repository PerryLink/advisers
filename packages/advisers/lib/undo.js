import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

function stamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}

/** Copy an existing target before overwrite; a new target gets a deletion manifest. */
export async function backupBeforeWrite(target, { cwd = process.cwd(), backupDir } = {}) {
  if (!backupDir) return null
  const abs = resolve(cwd, target)
  const rel = relative(cwd, abs)
  if (rel.startsWith('..') || rel === '') throw new Error('backup target escapes workspace')
  const dir = join(backupDir, `${stamp()}-${Math.random().toString(36).slice(2, 8)}`)
  const existed = existsSync(abs)
  await mkdir(dir, { recursive: true })
  if (existed) await copyFile(abs, join(dir, 'file'))
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ path: rel, existed, at: new Date().toISOString() }, null, 2))
  return dir
}

export async function listBackups(backupDir) {
  if (!existsSync(backupDir)) return []
  const dirs = (await readdir(backupDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse()
  const rows = []
  for (const name of dirs) {
    try {
      const manifest = JSON.parse(await readFile(join(backupDir, name, 'manifest.json'), 'utf8'))
      rows.push({ id: name, ...manifest })
    } catch {}
  }
  return rows
}

/** Restore the latest backup, or delete a file that was newly created. */
export async function undoLatest({ cwd = process.cwd(), backupDir } = {}) {
  const rows = await listBackups(backupDir)
  if (!rows.length) return { ok: false, error: 'no backups' }
  const latest = rows[0]
  const dir = join(backupDir, latest.id)
  const target = resolve(cwd, latest.path)
  const rel = relative(cwd, target)
  if (rel.startsWith('..') || rel === '') return { ok: false, error: 'backup path escapes workspace' }
  if (latest.existed) await copyFile(join(dir, 'file'), target)
  else if (existsSync(target)) await rm(target, { force: true })
  await rm(dir, { recursive: true, force: true })
  return { ok: true, path: target, existed: latest.existed }
}
