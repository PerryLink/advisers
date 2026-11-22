/**
 * Sequential case runner. Sequential on purpose: the suite is a determinism
 * gate, so shared temp dirs, spawn order and timing must be predictable.
 */
import { check } from './harness.mjs'
import { buildResult } from './report.mjs'

/**
 * @param {{id:string,group:string,title?:string,run:()=>Promise<{checks:Array}>|{checks:Array}}}[] cases
 */
export async function runCases(cases, { onCase } = {}) {
  const results = []
  for (const testCase of cases) {
    const startedAt = Date.now()
    let checks = []
    try {
      const outcome = await testCase.run()
      checks = Array.isArray(outcome?.checks) ? outcome.checks : []
      if (!checks.length) checks = [{ id: 'case.returned-checks', pass: false, detail: 'case returned no checks' }]
    } catch (error) {
      checks = [{ id: 'case.exception', pass: false, detail: String(error?.stack ?? error).slice(0, 800) }]
    }
    const result = {
      id: testCase.id,
      group: testCase.group,
      title: testCase.title ?? '',
      durationMs: Date.now() - startedAt,
      checks,
    }
    results.push(result)
    if (onCase) onCase(result)
  }
  return results
}

/** Append harness-wide checks that do not belong to a single command. */
export function harnessCases({ network }) {
  const checks = []
  check(checks, 'no-network-attempts', () => {
    if (network.attempts > 0) throw new Error(network.attempts + ' blocked network attempt(s): ' + JSON.stringify(network.kinds))
  })
  return [{
    id: 'det.harness.network-block',
    group: 'harness',
    title: 'every child ran behind the network-block preload with 0 attempts',
    durationMs: 0,
    checks,
  }]
}

/** Build the sanitized result object for this run. */
export function finalize({ cases, startedAt, filters, baseline, network, workdirs, command = [] }) {
  const durationMs = Math.max(0, Date.now() - Date.parse(startedAt))
  return buildResult({ cases, startedAt, durationMs, baseline, filters, workdirs, network, command })
}
