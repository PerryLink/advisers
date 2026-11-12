const IGNORE = /(别烦|不要提醒|不用提醒|晚点|以后再说|先放着|取消提醒|忽略)/
const ACCEPT = /(做了|完成|已完成|已发|已处理|搞定|收到并处理|好的我处理)/

export function classifyNudgeOutcome(text) {
  const value = String(text ?? '').trim()
  if (!value) return null
  if (IGNORE.test(value)) return 'ignored'
  if (ACCEPT.test(value)) return 'accepted'
  return null
}
