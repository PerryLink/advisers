const CORRECTION_START = /^(不是|不对|错了|应该|以后|记住|每次|改成|改一下)/
const MAX_STATEMENT = 160

/** Extract a correction/preference statement from a short user message. */
export function correctionStatement(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw || raw.length > MAX_STATEMENT || !CORRECTION_START.test(raw)) return null
  const contrast = raw.match(/^不是(.+?)[，,]\s*(?:而)?是(.+)$/)
  if (contrast) return contrast[2].trim()
  const rewrite = raw.match(/^(?:改成|改一下|应该)\s*(.+)$/)
  if (rewrite) return rewrite[1].trim()
  return raw
}

/** Exponential decay per 30 days; deprecated below 0.3. */
export function applyPreferenceDecay(preferences, now = new Date(), days = 30) {
  const changed = []
  for (const pref of preferences) {
    if (pref.status === 'deprecated') continue
    if (pref.priority === 'hard') continue
    const last = new Date(pref.lastConfirmed ?? pref.validFrom).getTime()
    const ageDays = (now.getTime() - last) / 86_400_000
    if (!Number.isFinite(ageDays) || ageDays < days) continue
    const periods = Math.floor(ageDays / days)
    pref.confidence = Math.max(0, pref.confidence * Math.pow(0.8, periods))
    if (pref.confidence < 0.3) pref.status = 'deprecated'
    changed.push(pref)
  }
  return changed
}

/** A successful multi-tool task becomes a draft routine, never auto-active. */
export function buildRoutineCandidate({ text, toolLog = [], artifacts = [] }) {
  const tools = [...new Set(toolLog.map((t) => t.name).filter(Boolean))]
  if (tools.length < 3 || artifacts.length === 0) return null
  return {
    name: text.replace(/\s+/g, ' ').slice(0, 60),
    description: '从一次多工具任务沉淀的流程草稿',
    trigger: [],
    steps: tools,
    preferences: [],
    pitfalls: [],
    verification: artifacts.map((file) => `file:${file}`),
    createdBy: 'agent',
  }
}
