import { chatCompletion } from './model.js'

const MAX_NAME = 60

export async function reviewRun({ run, routines = [], apiKey, baseUrl, model, fetchImpl = fetch }) {
  const response = await chatCompletion({
    apiKey,
    baseUrl,
    model,
    fetchImpl,
    messages: [
      {
        role: 'system',
        content: `You review finished secretary task trajectories. Return ONLY JSON:
{"verdict":"SAVE|FOLD_INTO|NONE","name":"<=60 chars","description":"<=60 chars","steps":["tool or step"],"verification":["file:path"],"foldInto":"routine id or null","pitfalls":["..."],"reason":"..."}
Rules: only tools/artifacts present in the run; never invent a file; SAVE only if repeatable; FOLD_INTO only an existing routine id; NONE is a good answer.`,
      },
      { role: 'user', content: JSON.stringify({ run, routines: routines.map((r) => ({ id: r.id, name: r.name, description: r.description })) }) },
    ],
  })
  return parseReview(response.content)
}

export function parseReview(raw) {
  if (typeof raw !== 'string') return { verdict: 'NONE', reason: 'empty review' }
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  try {
    const parsed = JSON.parse(text)
    const verdict = ['SAVE', 'FOLD_INTO', 'NONE'].includes(parsed.verdict) ? parsed.verdict : 'NONE'
    return { ...parsed, verdict, name: String(parsed.name ?? '').slice(0, MAX_NAME), description: String(parsed.description ?? '').slice(0, MAX_NAME) }
  } catch {
    return { verdict: 'NONE', reason: 'invalid review JSON' }
  }
}

/** Deterministic lint: the model's proposal must be backed by this run. */
export function lintReview(review, { run, routines = [] }) {
  if (review.verdict === 'NONE') return { ok: true, review }
  const tools = new Set((run.tools ?? []).map((t) => (typeof t === 'string' ? t : t.name)))
  const artifacts = new Set(run.artifacts ?? [])
  if (review.verdict === 'SAVE') {
    if (!review.name || !review.description) return { ok: false, error: 'name/description required' }
    if (!Array.isArray(review.steps) || review.steps.length < 2) return { ok: false, error: 'steps required' }
    for (const step of review.steps) {
      if (!tools.has(step)) return { ok: false, error: `step not in run: ${step}` }
    }
    const checks = (review.verification ?? []).filter((v) => String(v).startsWith('file:'))
    for (const check of checks) {
      if (!artifacts.has(check.slice(5))) return { ok: false, error: `verification not in run: ${check}` }
    }
    if (checks.length === 0) return { ok: false, error: 'verification must reference an artifact' }
    return { ok: true, review: { ...review, verification: checks } }
  }
  if (review.verdict === 'FOLD_INTO') {
    const target = routines.find((r) => r.id === review.foldInto)
    if (!target) return { ok: false, error: 'unknown foldInto routine' }
    return { ok: true, review }
  }
  return { ok: false, error: 'unknown verdict' }
}

export function materializeReview(review, { run, ledger }) {
  if (review.verdict === 'NONE') return { verdict: 'NONE' }
  if (review.verdict === 'SAVE') {
    const routine = ledger.addRoutine({
      name: review.name,
      description: review.description,
      trigger: [],
      steps: review.steps,
      preferences: [],
      pitfalls: review.pitfalls ?? [],
      verification: review.verification,
      createdBy: 'agent',
    })
    return { verdict: 'SAVE', routine }
  }
  if (review.verdict === 'FOLD_INTO') {
    const patch = ledger.proposeRoutinePatch(review.foldInto, {
      pitfalls: review.pitfalls ?? [],
      verification: review.verification ?? [],
    })
    return { verdict: 'FOLD_INTO', patch }
  }
  return { verdict: 'NONE' }
}
