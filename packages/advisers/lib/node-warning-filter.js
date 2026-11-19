/**
 * Suppress the one-time `node:sqlite is experimental` warning on Node 22.
 *
 * The warning is a runtime implementation detail, not part of the CLI
 * contract; without this filter a plain `advisers status --json` writes it to
 * stderr and breaks JSON-purity gates (and scripts that parse stderr).
 * Only this exact warning is filtered; all other warnings pass through.
 */
const originalEmitWarning = process.emitWarning.bind(process)

process.emitWarning = (warning, ...args) => {
  const text = typeof warning === 'string' ? warning : String(warning?.message ?? '')
  if (/SQLite is an experimental feature/i.test(text)) return
  return originalEmitWarning(warning, ...args)
}
