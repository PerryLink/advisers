function shanghaiMidnight(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-').map(Number)
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], -8, 0, 0))
}

export function buildDigest({ period = 'day', now = new Date(), turns = [], commitments = [], deliveries = [] } = {}) {
  const start = period === 'week'
    ? new Date(shanghaiMidnight(now).getTime() - 6 * 86400_000)
    : shanghaiMidnight(now)
  const inPeriod = (iso) => {
    const t = Date.parse(iso)
    return Number.isFinite(t) && t >= start.getTime() && t <= now.getTime()
  }
  const userTurns = turns.filter((t) => t.role === 'user' && inPeriod(t.createdAt))
  const done = commitments.filter((c) => c.status === 'done' && c.doneAt && inPeriod(c.doneAt))
  const open = commitments.filter((c) => c.status === 'open')
  const due = open.filter((c) => c.dueAt && Date.parse(c.dueAt) <= now.getTime() + 86400_000)
  const files = deliveries.filter((d) => inPeriod(d.createdAt))
  const lines = [
    `${period === 'week' ? '本周' : '今天'}：${userTurns.length} 次对话，${files.length} 个交付，${done.length} 个承诺完成。`,
  ]
  if (due.length) lines.push(`到期：${due.slice(0, 3).map((c) => c.action).join('；')}`)
  else lines.push('到期：无')
  if (done.length) lines.push(`完成：${done.slice(0, 3).map((c) => c.action).join('；')}`)
  if (userTurns.length) lines.push(`最近一句：${userTurns.at(-1).content.replace(/\s+/g, ' ').slice(0, 100)}`)
  return lines.join('\n')
}
