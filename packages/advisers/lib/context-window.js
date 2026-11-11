export function estimateTokens(text) {
  const value = String(text ?? '')
  let cjk = 0
  for (const ch of value) if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk++
  return Math.ceil(cjk + (value.length - cjk) / 4)
}

export function shouldSummarize(turns, throughSeq = 0, every = 10, keepTurns = 20) {
  const latest = turns.at(-1)?.seq ?? 0
  return latest - keepTurns - throughSeq >= every
}

/** Deterministic fallback; the caller may replace it with an LLM summary. */
export function summarizeTurns(turns, previous = '') {
  const lines = []
  if (previous) lines.push(previous.trim())
  for (const turn of turns) {
    const content = String(turn.content ?? '').replace(/\s+/g, ' ').trim()
    if (!content) continue
    const who = turn.role === 'user' ? '用户' : '助手'
    lines.push(`- ${who}：${content.slice(0, 180)}`)
  }
  const text = lines.join('\n')
  if (text.length <= 2400) return text
  // Keep the head (pins/summary) and the latest lines; trim the middle, never the pins.
  return `${text.slice(0, 1200)}\n…[summary trimmed]…\n${text.slice(-1000)}`
}

/** Newest turns first backwards, but returned chronologically. */
export function selectTurns(turns, { maxTurns = 20, maxTokens = 3000 } = {}) {
  const selected = []
  let tokens = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (selected.length >= maxTurns) break
    const content = String(turn.content ?? '')
    const capped = content.length > 4000 ? `${content.slice(0, 4000)}\n…[turn truncated]` : content
    const cost = estimateTokens(capped) + 4
    if (tokens + cost > maxTokens && selected.length > 0) break
    selected.push({ ...turn, content: capped })
    tokens += cost
  }
  return selected.reverse()
}

export function buildHistory({ turns = [], summary, throughSeq = 0, maxTurns = 20, maxTokens = 3000, keepTurns = 20 } = {}) {
  const latest = turns.at(-1)?.seq ?? 0
  // Never let compaction erase the live window: always retain the last keepTurns.
  const cutoff = throughSeq >= latest ? Math.max(0, latest - keepTurns) : throughSeq
  const fresh = turns.filter((t) => t.seq > cutoff)
  const selected = selectTurns(fresh, { maxTurns, maxTokens })
  return {
    summary: summary?.trim() || '',
    turns: selected,
    usedTokens: estimateTokens(summary ?? '') + selected.reduce((n, t) => n + estimateTokens(t.content) + 4, 0),
    dropped: fresh.length - selected.length,
  }
}

export function buildOpening({ summary, turns = [], commitments = [], now = new Date() } = {}) {
  const lastUser = [...turns].reverse().find((t) => t.role === 'user')
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')
  const due = commitments
    .filter((c) => c.status === 'open' && c.dueAt)
    .filter((c) => Date.parse(c.dueAt) <= now.getTime() + 24 * 3600_000)
    .slice(0, 3)
  const lines = []
  if (summary) lines.push(`上次：${summary.replace(/\s+/g, ' ').slice(0, 160)}`)
  else if (lastUser) lines.push(`上次你说：${lastUser.content.replace(/\s+/g, ' ').slice(0, 120)}`)
  if (due.length) lines.push(`今天到期：${due.map((c) => `${c.action}${c.dueAt ? `（${c.dueAt.slice(0, 16)}）` : ''}`).join('；')}`)
  else lines.push('今天到期：无')
  const action = due.length ? '先处理到期承诺，或告诉我今天先做什么' : (lastAssistant ? '继续上次的活，或告诉我今天先做什么' : '告诉我今天先做什么')
  lines.push(`默认动作：${action}`)
  return lines.join('\n')
}

export function buildPins({ preferences = [], commitments = [], now = new Date() } = {}) {
  const hard = preferences.filter((p) => p.priority === 'hard' && p.status === 'confirmed')
  const due = commitments
    .filter((c) => c.status === 'open' && c.dueAt && Date.parse(c.dueAt) <= now.getTime() + 14 * 86400_000)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
  const lines = []
  for (const p of hard.slice(0, 8)) lines.push(`hard: ${p.statement}`)
  for (const c of due.slice(0, 6)) lines.push(`due: ${c.action}${c.dueAt ? ` (${c.dueAt})` : ''}`)
  const text = lines.join('\n')
  return text.length > 2000 ? `${text.slice(0, 2000)}\n…[pins truncated]` : text
}
