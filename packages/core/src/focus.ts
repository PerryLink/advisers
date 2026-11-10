import type { Commitment, Matter, UserPreference } from './types.ts'

export interface FocusInput {
  matter: Matter
  commitments: Commitment[]
  preferences: UserPreference[]
  budget?: number
  audience?: string
}

export interface FocusFrame {
  matterId: string
  summary?: string
  openQuestions: string[]
  deadlines: string[]
  commitments: Commitment[]
  preferences: UserPreference[]
  budget: number
  audience?: string
}

/**
 * The focus frame is a whitelist, not a retrieval result.
 * It always carries the global user model; it never carries another matter's body.
 */
export function buildFocusFrame(input: FocusInput): FocusFrame {
  const budget = input.budget ?? 1200
  const hard = input.preferences.filter((p) => p.scope.level === 'global' && p.priority === 'hard')
  const rest = input.preferences.filter((p) => p.scope.level === 'global' && p.priority !== 'hard')
  const scoped = input.preferences.filter(
    (p) => p.scope.level === 'matter' && p.scope.value === input.matter.id,
  )
  return {
    matterId: input.matter.id,
    summary: input.matter.summary,
    openQuestions: input.matter.openQuestions.slice(0, 5),
    deadlines: input.matter.deadlines.slice(0, 3),
    commitments: input.commitments.filter((c) => c.status === 'open').slice(0, 5),
    preferences: [...hard, ...scoped, ...rest],
    budget,
    audience: input.audience,
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function renderFocusFrame(frame: FocusFrame): string {
  const lines: string[] = []
  lines.push(`[matter] ${frame.matterId}`)
  if (frame.summary) lines.push(`summary: ${frame.summary}`)
  if (frame.openQuestions.length) lines.push(`open: ${frame.openQuestions.join(' | ')}`)
  if (frame.deadlines.length) lines.push(`deadlines: ${frame.deadlines.join(' | ')}`)
  if (frame.commitments.length) {
    lines.push(
      'commitments: ' +
        frame.commitments
          .map((c) => `${c.debtor} owes ${c.creditor}: ${c.action}${c.dueAt ? ` (${c.dueAt})` : ''}`)
          .join(' | '),
    )
  }
  if (frame.preferences.length) {
    lines.push('preferences:')
    for (const p of frame.preferences) lines.push(`- [${p.kind}/${p.priority}] ${p.statement}`)
  }

  let text = lines.join('\n')
  while (estimateTokens(text) > frame.budget && lines.length > 2) {
    // Drop the least critical tail first; hard taboos are ordered first and stay.
    lines.pop()
    text = lines.join('\n')
  }
  return text
}
