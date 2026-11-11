import { defineTool } from '@deepseek-ai/dsh-tools'
import { AdvisersRuntime } from 'advisers-core'

export const name = 'advisers'
export const inject = ['tools']
export const version = '0.2.0-preview.5'

/**
 * DSH bundle entry point. The first slice is deliberately one read-only tool:
 * it turns a request into an IntentBrief and never touches the ledger or sends.
 */
export function apply(ctx, config = {}) {
  const runtime = new AdvisersRuntime({
    stage: config.stage === 'trusted' ? 'trusted' : 'probation',
  })

  ctx.provide('advisers', runtime)

  ctx.tools.register(defineTool({
    name: 'advisers_brief',
    description: 'Turn a work request into a concise IntentBrief: goal, deliverable, risk, assumptions, one question, and a two-line readback. Use before starting an ambiguous task.',
    parameters: {
      text: { type: 'string', required: true, description: 'The user request, verbatim.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goal: { type: 'string', required: true },
          deliverable: { type: 'string', required: true },
          action: { type: 'string', required: true },
          risk: { type: 'string', required: true },
          questions: { type: 'array', items: { type: 'string' }, required: true },
          readback: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.readback }],
    },
    async execute(args) {
      const brief = runtime.brief(args.text)
      return {
        goal: brief.goal,
        deliverable: brief.deliverable,
        action: brief.action,
        risk: brief.risk,
        questions: brief.questions,
        readback: brief.readback,
      }
    },
  }))
}
