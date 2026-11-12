import { defineTool } from '@deepseek-ai/dsh-tools'
import { AdvisersRuntime } from 'advisers-core'
import { buildDocx, buildPptx, buildXlsx, buildXmind, buildMermaid, buildDrawio, validateOffice, validateXmind } from 'advisers-office'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const name = 'advisers'
export const inject = ['tools']
export const version = '0.2.0-preview.14'

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
    name: 'advisers_office',
    description: 'Build a real Office/diagram file from a JSON spec inside the configured workspace. Returns the path and validation result.',
    parameters: {
      kind: { type: 'string', required: true, description: 'docx | xlsx | pptx | xmind | mermaid | drawio' },
      out: { type: 'string', required: true, description: 'Relative output path, e.g. out/q4.docx' },
      spec: { type: 'object', required: true, description: 'Builder spec (title/sections/columns/rows/slides/nodes/branches).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.ok ? 'written' : 'failed'}: ${value.path} (${value.bytes} bytes)` }],
    },
    async execute(args) {
      const root = resolve(config.workspace || process.cwd())
      const target = resolve(root, args.out)
      if (!target.startsWith(root + '/')) throw new Error('output path escapes workspace')
      let buffer
      let validation
      if (args.kind === 'docx') { buffer = await buildDocx(args.spec); validation = await validateOffice(buffer, 'docx') }
      else if (args.kind === 'xlsx') { buffer = await buildXlsx(args.spec); validation = await validateOffice(buffer, 'xlsx') }
      else if (args.kind === 'pptx') { buffer = await buildPptx(args.spec); validation = await validateOffice(buffer, 'pptx') }
      else if (args.kind === 'xmind') { buffer = await buildXmind(args.spec); validation = await validateXmind(buffer) }
      else if (args.kind === 'drawio') { buffer = Buffer.from(buildDrawio(args.spec)); validation = { ok: true } }
      else if (args.kind === 'mermaid') { buffer = Buffer.from(buildMermaid(args.spec)); validation = { ok: true } }
      else throw new Error(`unsupported kind: ${args.kind}`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, buffer)
      return { ok: validation.ok, path: target, bytes: buffer.length }
    },
  }))

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
