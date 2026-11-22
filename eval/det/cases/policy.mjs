/**
 * 0.4.0 policy/consent deterministic gate: the privacy surface matrix, the
 * revocable model-egress consent lifecycle and the fail-closed mail model path.
 *
 * These cases are the machine form of the 0.4 promise that model egress is
 * explicit and revocable:
 *   - 'privacy --matrix' reports every surface with an honest gate/default and
 *     the rows are stable across runs (only 'generatedAt' is wall-clock);
 *   - 'consent status|grant|revoke' keeps a 0600 local record with stable reads;
 *   - 'mail extract --model' fails closed BEFORE any egress when the opt-in or
 *     the matching consent record is missing (and before a key check).
 *
 * The evidence case pins the 0.4 four-state vocabulary on 'evidence show':
 * verified / missing / unverifiable are reachable from a local CLI and
 * not_checked is the capability-absent state (the vocabulary constant comes
 * from lib/evidence.js, so a rename fails this gate).
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { EVIDENCE_RESOLUTIONS } from '../../../packages/advisers/lib/evidence.js'
import { check } from '../lib/harness.mjs'
import { KB_FIXTURE_MATTER_ID, checkNoNetwork, isSha256, jsonValue, openStateStore, runJsonCli, writeWorkFile, withFreshHome, withSeededHome } from './_fixture.mjs'

const MATRIX_GATES = ['enforced-policy', 'legacy-gate', 'self-attested', 'not-wired']
const MATRIX_DEFAULTS = ['on', 'off']
const REQUIRED_SURFACES = ['mcp', 'export', 'mail.sync', 'mail.extract', 'kb.ingest', 'kb.search']
const RESOLUTION_STATES = ['verified', 'missing', 'unverifiable', 'not_checked']

const EML_SAMPLE = [
  'From: Wang Gong <wang@example.com>',
  'To: me@example.com',
  'Subject: 官网改版报价',
  'Date: Fri, 20 Nov 2026 09:00:00 +0800',
  'Message-ID: <fixed-mail-1@example.com>',
  'Content-Type: text/plain; charset=UTF-8',
  'MIME-Version: 1.0',
  '',
  '王工你好：',
  '',
  '我将在 2026-11-25 前发出报价单，请查收。',
  '',
  '谢谢。',
  '',
].join('\n')

function isIsoInstant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function envelopeCode(result, label) {
  if (result.run.stdout !== '') throw new Error(label + ' wrote to stdout: ' + JSON.stringify(result.run.stdout.slice(0, 120)))
  try {
    return JSON.parse(result.run.stderr)?.error?.code
  } catch {
    throw new Error(label + ' stderr is not a JSON error envelope: ' + JSON.stringify(result.run.stderr.slice(0, 200)))
  }
}

export default [
  {
    id: 'det.policy.privacy-matrix',
    group: 'policy',
    title: 'privacy --matrix reports every surface with a stable, honest gate and default',
    async run() {
      return withSeededHome('policy-matrix', async (workdir) => {
        const checks = []
        const runs = []
        const first = runJsonCli(workdir, ['privacy', '--matrix', '--json'], { index: 'policy-matrix-1' })
        const second = runJsonCli(workdir, ['privacy', '--matrix', '--json'], { index: 'policy-matrix-2' })
        runs.push(first.run, second.run)
        check(checks, 'matrix.exit-0', () => {
          if (first.run.status !== 0 || second.run.status !== 0) throw new Error('exit ' + first.run.status + '/' + second.run.status + ': ' + first.run.stderr.slice(0, 200))
        })
        check(checks, 'matrix.envelope', () => {
          const value = jsonValue(first, 'privacy --matrix')
          if (value.command !== 'privacy --matrix') throw new Error('command=' + value.command)
          if (value.policyVersion !== 1) throw new Error('policyVersion=' + value.policyVersion)
          if (!/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(String(value.rulesetVersion))) throw new Error('rulesetVersion=' + value.rulesetVersion)
          if (!isIsoInstant(value.generatedAt)) throw new Error('generatedAt=' + value.generatedAt)
          if (!Array.isArray(value.rows) || value.rows.length < 10) throw new Error('rows=' + value.rows?.length)
        })
        check(checks, 'matrix.row-contract', () => {
          const rows = jsonValue(first, 'privacy --matrix').rows ?? []
          const surfaces = new Set()
          for (const row of rows) {
            if (typeof row.surface !== 'string' || !row.surface) throw new Error('surface=' + row.surface)
            if (surfaces.has(row.surface)) throw new Error('duplicate surface=' + row.surface)
            surfaces.add(row.surface)
            if (!Array.isArray(row.actions) || row.actions.length === 0) throw new Error(row.surface + ' actions=' + JSON.stringify(row.actions))
            if (typeof row.dataClass !== 'string' || !row.dataClass) throw new Error(row.surface + ' dataClass=' + row.dataClass)
            if (typeof row.sink !== 'string') throw new Error(row.surface + ' sink=' + row.sink)
            if (!MATRIX_DEFAULTS.includes(row.default)) throw new Error(row.surface + ' default=' + row.default)
            if (!MATRIX_GATES.includes(row.gate)) throw new Error(row.surface + ' gate=' + row.gate)
            if (typeof row.tosRef !== 'string' || typeof row.doc !== 'string') throw new Error(row.surface + ' tosRef/doc missing')
          }
          for (const required of REQUIRED_SURFACES) if (!surfaces.has(required)) throw new Error('missing surface=' + required)
        })
        check(checks, 'matrix.mail-extract-is-off-by-default', () => {
          const row = (jsonValue(first, 'privacy --matrix').rows ?? []).find((item) => item.surface === 'mail.extract')
          if (!row) throw new Error('mail.extract row missing')
          if (row.dataClass !== 'mail') throw new Error('dataClass=' + row.dataClass)
          if (row.sink !== 'model') throw new Error('sink=' + row.sink)
          if (row.default !== 'off') throw new Error('default=' + row.default)
          if (!row.actions.includes('model-egress')) throw new Error('actions=' + JSON.stringify(row.actions))
          if (row.gate !== 'enforced-policy') throw new Error('gate=' + row.gate)
        })
        check(checks, 'matrix.rows-stable-across-runs', () => {
          const left = JSON.stringify(jsonValue(first, 'privacy --matrix').rows)
          const right = JSON.stringify(jsonValue(second, 'privacy --matrix').rows)
          if (left !== right) throw new Error('matrix rows differ between two runs')
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.policy.consent-lifecycle',
    group: 'policy',
    title: 'consent status is empty, grant/revoke write a 0600 record and reads stay byte-stable',
    async run() {
      return withSeededHome('policy-consent', async (workdir) => {
        const checks = []
        const runs = []
        const consentPath = join(workdir.home, 'consent.json')

        const status0 = runJsonCli(workdir, ['consent', 'status', '--json'], { index: 'policy-consent-status-0' })
        runs.push(status0.run)
        check(checks, 'status.fresh-home', () => {
          if (status0.run.status !== 0) throw new Error('exit ' + status0.run.status + ': ' + status0.run.stderr.slice(0, 200))
          const value = jsonValue(status0, 'consent status')
          if (value.command !== 'consent status') throw new Error('command=' + value.command)
          if (value.configured !== false) throw new Error('configured=' + value.configured)
          if (!Array.isArray(value.entries) || value.entries.length !== 0) throw new Error('entries=' + JSON.stringify(value.entries))
          if (value.path !== consentPath) throw new Error('path=' + value.path + ' expected ' + consentPath)
          if (existsSync(consentPath)) throw new Error('consent file exists before any grant')
        })

        const grant = runJsonCli(workdir, ['consent', 'grant', 'mail.extract', '--yes', '--json'], { index: 'policy-consent-grant' })
        runs.push(grant.run)
        check(checks, 'grant.exit-0-and-envelope', () => {
          if (grant.run.status !== 0) throw new Error('exit ' + grant.run.status + ': ' + grant.run.stderr.slice(0, 200))
          const value = jsonValue(grant, 'consent grant')
          if (value.command !== 'consent grant') throw new Error('command=' + value.command)
          if (value.version !== 1) throw new Error('version=' + value.version)
          if (value.entry?.surface !== 'mail.extract' || value.entry?.dataClass !== 'mail') throw new Error('entry=' + JSON.stringify(value.entry))
          if (value.entry?.provider !== 'deepseek') throw new Error('provider=' + value.entry?.provider)
          if (value.entry?.channel !== 'flag') throw new Error('channel=' + value.entry?.channel)
          if (value.entry?.baseUrl !== 'https://api.deepseek.com') throw new Error('baseUrl=' + value.entry?.baseUrl)
          if (!isIsoInstant(value.entry?.grantedAt)) throw new Error('grantedAt=' + value.entry?.grantedAt)
          if (value.auditWritten !== true) throw new Error('auditWritten=' + value.auditWritten)
          if (!Array.isArray(value.record?.entries) || value.record.entries.length !== 1) throw new Error('record=' + JSON.stringify(value.record))
        })
        check(checks, 'grant.file-is-private', () => {
          if (!existsSync(consentPath)) throw new Error('consent file was not written at ' + consentPath)
          if (process.platform !== 'win32') {
            const mode = statSync(consentPath).mode & 0o777
            if (mode !== 0o600) throw new Error('consent file mode=' + mode.toString(8))
          }
        })

        const status1 = runJsonCli(workdir, ['consent', 'status', '--json'], { index: 'policy-consent-status-1' })
        const status2 = runJsonCli(workdir, ['consent', 'status', '--json'], { index: 'policy-consent-status-2' })
        runs.push(status1.run, status2.run)
        check(checks, 'status.after-grant-stable', () => {
          if (status1.run.status !== 0 || status2.run.status !== 0) throw new Error('exit ' + status1.run.status + '/' + status2.run.status)
          if (status1.run.stdout !== status2.run.stdout) throw new Error('consent status differs between two runs')
          const value = jsonValue(status1, 'consent status')
          if (value.configured !== true) throw new Error('configured=' + value.configured)
          const entry = value.entries?.[0] ?? {}
          if (value.entries.length !== 1) throw new Error('entries=' + value.entries.length)
          if (entry.surface !== 'mail.extract' || entry.dataClass !== 'mail') throw new Error('entry=' + JSON.stringify(entry))
          if (entry.active !== true) throw new Error('active=' + entry.active)
          if (entry.revokedAt !== null) throw new Error('revokedAt=' + entry.revokedAt)
          if (entry.grantedAt !== jsonValue(grant, 'consent grant').entry.grantedAt) throw new Error('grantedAt moved between grant and status')
        })

        const revoke = runJsonCli(workdir, ['consent', 'revoke', 'mail.extract', '--yes', '--json'], { index: 'policy-consent-revoke' })
        runs.push(revoke.run)
        check(checks, 'revoke.records-revocation', () => {
          if (revoke.run.status !== 0) throw new Error('exit ' + revoke.run.status + ': ' + revoke.run.stderr.slice(0, 200))
          const value = jsonValue(revoke, 'consent revoke')
          if (value.command !== 'consent revoke') throw new Error('command=' + value.command)
          if (value.revoked !== 1) throw new Error('revoked=' + value.revoked)
          if (value.auditWritten !== true) throw new Error('auditWritten=' + value.auditWritten)
          const entry = value.entries?.[0] ?? {}
          if (!isIsoInstant(entry.revokedAt)) throw new Error('revokedAt=' + entry.revokedAt)
          if (value.record?.entries?.length !== 1) throw new Error('record=' + JSON.stringify(value.record))
        })
        const status3 = runJsonCli(workdir, ['consent', 'status', '--json'], { index: 'policy-consent-status-3' })
        const status4 = runJsonCli(workdir, ['consent', 'status', '--json'], { index: 'policy-consent-status-4' })
        runs.push(status3.run, status4.run)
        check(checks, 'status.after-revoke-stable', () => {
          if (status3.run.status !== 0 || status4.run.status !== 0) throw new Error('exit ' + status3.run.status + '/' + status4.run.status)
          if (status3.run.stdout !== status4.run.stdout) throw new Error('consent status differs between two runs after revoke')
          const value = jsonValue(status3, 'consent status')
          if (value.configured !== true) throw new Error('configured=' + value.configured)
          if (value.entries.length !== 1) throw new Error('entries=' + value.entries.length)
          const entry = value.entries[0]
          if (entry.active !== false) throw new Error('active=' + entry.active)
          const revokedAt = jsonValue(revoke, 'consent revoke').entries?.[0]?.revokedAt
          if (entry.revokedAt !== revokedAt) throw new Error('revokedAt=' + entry.revokedAt + ' expected ' + revokedAt)
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.policy.mail-model-fail-closed',
    group: 'policy',
    title: 'mail extract --model fails closed before any egress without opt-in, consent or key',
    async run() {
      return withFreshHome('policy-egress', async (workdir) => {
        const checks = []
        const runs = []
        writeWorkFile(workdir, 'sample.eml', EML_SAMPLE)
        const imported = runJsonCli(workdir, ['mail', 'import', 'sample.eml', '--json'], { index: 'policy-egress-import' })
        runs.push(imported.run)
        check(checks, 'import.exit-0', () => {
          if (imported.run.status !== 0) throw new Error('exit ' + imported.run.status + ': ' + imported.run.stderr.slice(0, 200))
          if (jsonValue(imported, 'mail import').inserted !== 1) throw new Error('inserted=' + jsonValue(imported, 'mail import').inserted)
        })

        const noOptIn = runJsonCli(workdir, ['mail', 'extract', '--all-new', '--model', '--json'], { index: 'policy-egress-no-optin' })
        runs.push(noOptIn.run)
        check(checks, 'missing-opt-in-fails-closed', () => {
          if (noOptIn.run.status !== 1) throw new Error('exit ' + noOptIn.run.status)
          if (envelopeCode(noOptIn, 'mail extract --model') !== 'E_MAIL_MODEL_OPT_IN') throw new Error('code=' + envelopeCode(noOptIn, 'mail extract --model'))
        })

        const noConsent = runJsonCli(workdir, ['mail', 'extract', '--all-new', '--model', '--yes', '--json'], { index: 'policy-egress-no-consent' })
        runs.push(noConsent.run)
        check(checks, 'missing-consent-fails-closed', () => {
          if (noConsent.run.status !== 1) throw new Error('exit ' + noConsent.run.status)
          const code = envelopeCode(noConsent, 'mail extract --model --yes (no consent)')
          if (code !== 'E_POLICY_CONSENT_REQUIRED') throw new Error('code=' + code)
        })

        const grant = runJsonCli(workdir, ['consent', 'grant', 'mail.extract', '--yes', '--json'], { index: 'policy-egress-grant' })
        runs.push(grant.run)
        check(checks, 'consent-grant-written', () => {
          if (grant.run.status !== 0) throw new Error('exit ' + grant.run.status + ': ' + grant.run.stderr.slice(0, 200))
          if (jsonValue(grant, 'consent grant').auditWritten !== true) throw new Error('auditWritten=' + jsonValue(grant, 'consent grant').auditWritten)
        })

        const noKey = runJsonCli(workdir, ['mail', 'extract', '--all-new', '--model', '--yes', '--json'], { index: 'policy-egress-no-key' })
        runs.push(noKey.run)
        check(checks, 'consented-but-keyless-fails-closed', () => {
          if (noKey.run.status !== 1) throw new Error('exit ' + noKey.run.status)
          const code = envelopeCode(noKey, 'mail extract --model --yes (consented, no key)')
          if (code !== 'E_MAIL_MODEL_DISABLED') throw new Error('code=' + code)
          if (!/ADVISERS_API_KEY/.test(noKey.run.stderr)) throw new Error('stderr does not name the missing key')
        })

        const lsAfter = runJsonCli(workdir, ['mail', 'ls', '--json'], { index: 'policy-egress-ls' })
        runs.push(lsAfter.run)
        check(checks, 'message-untouched-and-no-candidates', () => {
          if (lsAfter.run.status !== 0) throw new Error('exit ' + lsAfter.run.status)
          const message = jsonValue(lsAfter, 'mail ls').messages?.[0] ?? {}
          if (message.status !== 'new') throw new Error('status=' + message.status)
          if ((message.candidateIds ?? []).length !== 0) throw new Error('candidateIds=' + JSON.stringify(message.candidateIds))
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.policy.evidence-resolutions',
    group: 'policy',
    title: 'evidence show resolves verified/missing/unverifiable against the local store',
    async run() {
      return withFreshHome('policy-evidence', async (workdir) => {
        const checks = []
        const runs = []
        const QUOTE_MD = ['# 报价说明', '', '本次官网改版报价 80000 元，含设计与开发。', ''].join('\n')
        const evidenceQuote = '本次官网改版报价 80000 元'
        writeWorkFile(workdir, 'quote.md', QUOTE_MD)

        const add = runJsonCli(workdir, ['kb', 'add', 'quote.md', '--json'], { index: 'policy-evidence-kb-add' })
        runs.push(add.run)
        check(checks, 'kb-add.exit-0', () => {
          if (add.run.status !== 0) throw new Error('exit ' + add.run.status + ': ' + add.run.stderr.slice(0, 200))
          if (jsonValue(add, 'kb add').counts?.added !== 1) throw new Error('counts=' + JSON.stringify(jsonValue(add, 'kb add').counts))
        })
        const docId = jsonValue(add, 'kb add').added?.[0]?.id

        const store = await openStateStore(workdir.home)
        try {
          const chunk = store.db.prepare('SELECT seq, text FROM kb_chunks WHERE doc_id = ? ORDER BY seq LIMIT 1').get(docId)
          if (!chunk || !String(chunk.text).includes(evidenceQuote)) throw new Error('fixture KB chunk does not contain the evidence quote')
          store.mutate(() => {
            store.insertMatter({
              id: KB_FIXTURE_MATTER_ID,
              title: '客户甲 · 官网改版',
              status: 'active',
              domain: 'work',
              secrecy: 0,
              participants: [],
              deadlines: [],
              openQuestions: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            })
            store.insertCommitment({
              id: 'cm_verified',
              matterId: KB_FIXTURE_MATTER_ID,
              debtor: 'user',
              creditor: '客户甲',
              action: 'KB 证据承诺',
              timezone: 'Asia/Shanghai',
              status: 'open',
              capability: 'none',
              createdAt: '2026-01-02T00:00:00.000Z',
              evidence: [{ kind: 'derived', quote: evidenceQuote, source: { type: 'kb_chunk', docId, chunkIndex: chunk.seq } }],
            })
            store.insertCommitment({
              id: 'cm_missing',
              matterId: KB_FIXTURE_MATTER_ID,
              debtor: 'user',
              creditor: '客户甲',
              action: '缺失证据承诺',
              timezone: 'Asia/Shanghai',
              status: 'open',
              capability: 'none',
              createdAt: '2026-01-02T00:00:00.000Z',
              evidence: [{ sessionId: 'sess-x', turnId: 'turn-x', quote: '不存在的话' }],
            })
          })
        } finally {
          store.close()
        }

        const manualAdd = runJsonCli(workdir, ['commit', 'add', '手工证据承诺', '--quote', '手工录入的原话'], { index: 'policy-evidence-manual-add' })
        runs.push(manualAdd.run)
        const list = runJsonCli(workdir, ['commit', 'ls', '--json'], { index: 'policy-evidence-commit-ls' })
        runs.push(list.run)
        const manualId = (jsonValue(list, 'commit ls') ?? []).find((row) => row.action === '手工证据承诺')?.id
        check(checks, 'manual-evidence-fixture-created', () => {
          if (manualAdd.run.status !== 0) throw new Error('exit ' + manualAdd.run.status + ': ' + manualAdd.run.stderr.slice(0, 200))
          if (!/^cm_/.test(String(manualId))) throw new Error('manual commitment id=' + manualId)
        })

        const verified = runJsonCli(workdir, ['evidence', 'show', 'cm_verified', '--json'], { index: 'policy-evidence-verified' })
        const missing = runJsonCli(workdir, ['evidence', 'show', 'cm_missing', '--json'], { index: 'policy-evidence-missing' })
        const manual = runJsonCli(workdir, ['evidence', 'show', manualId, '--json'], { index: 'policy-evidence-manual' })
        runs.push(verified.run, missing.run, manual.run)
        const resolutions = []
        check(checks, 'verified.kb-chunk-resolves', () => {
          if (verified.run.status !== 0) throw new Error('exit ' + verified.run.status + ': ' + verified.run.stderr.slice(0, 200))
          const value = jsonValue(verified, 'evidence show cm_verified')
          const source = value.sources?.[0] ?? {}
          if (source.resolution !== 'verified') throw new Error('resolution=' + source.resolution)
          if (source.type !== 'kb_chunk' || source.quoteVerified !== true) throw new Error('type/quoteVerified=' + source.type + '/' + source.quoteVerified)
          if (value.byKind?.derived !== 1 || value.summary?.missing !== 0 || value.summary?.unverifiable !== 0) throw new Error('byKind/summary=' + JSON.stringify(value.byKind) + '/' + JSON.stringify(value.summary))
          resolutions.push(source.resolution)
        })
        check(checks, 'missing.dangling-turn-resolves', () => {
          if (missing.run.status !== 0) throw new Error('exit ' + missing.run.status + ': ' + missing.run.stderr.slice(0, 200))
          const value = jsonValue(missing, 'evidence show cm_missing')
          const item = value.missing?.[0] ?? {}
          if (item.resolution !== 'missing' || item.reason !== 'turn_not_found') throw new Error('missing=' + JSON.stringify(item))
          if (value.summary?.missing !== 1 || value.summary?.notCheckedCount !== 0) throw new Error('summary=' + JSON.stringify(value.summary))
          resolutions.push(item.resolution)
        })
        check(checks, 'unverifiable.manual-is-not-missing', () => {
          if (manual.run.status !== 0) throw new Error('exit ' + manual.run.status + ': ' + manual.run.stderr.slice(0, 200))
          const value = jsonValue(manual, 'evidence show <manual>')
          const item = value.unverifiable?.[0] ?? {}
          if (item.resolution !== 'unverifiable' || item.reason !== 'operator_entered') throw new Error('unverifiable=' + JSON.stringify(item))
          if (value.summary?.operatorEntered !== 1 || value.summary?.missing !== 0) throw new Error('summary=' + JSON.stringify(value.summary))
          if (value.verificationBasis !== 'build-time') throw new Error('verificationBasis=' + value.verificationBasis)
          resolutions.push(item.resolution)
        })
        check(checks, 'four-state-vocabulary', () => {
          if (JSON.stringify(EVIDENCE_RESOLUTIONS) !== JSON.stringify(RESOLUTION_STATES)) throw new Error('lib/evidence EVIDENCE_RESOLUTIONS=' + JSON.stringify(EVIDENCE_RESOLUTIONS))
          for (const resolution of resolutions) {
            if (!EVIDENCE_RESOLUTIONS.includes(resolution)) throw new Error('unknown resolution=' + resolution)
          }
          if (resolutions.length !== 3) throw new Error('expected three reachable resolutions, got ' + JSON.stringify(resolutions))
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  /* ----------------------------------------------------------------------- */
  /* 0.5.0 WF4 Q4b: two more fail-closed policy cases                        */
  /* ----------------------------------------------------------------------- */
  {
    id: 'det.policy.consent-binding-invalidated',
    group: 'policy',
    title: 'a consent record bound to another provider/base URL fails closed before any egress',
    async run() {
      return withFreshHome('policy-consent-binding', async (workdir) => {
        const checks = []
        const runs = []
        writeWorkFile(workdir, 'sample.eml', EML_SAMPLE)
        const imported = runJsonCli(workdir, ['mail', 'import', 'sample.eml', '--json'], { index: 'policy-binding-import' })
        runs.push(imported.run)
        check(checks, 'import.exit-0', () => {
          if (imported.run.status !== 0) throw new Error('exit ' + imported.run.status + ': ' + imported.run.stderr.slice(0, 200))
          if (jsonValue(imported, 'mail import').inserted !== 1) throw new Error('inserted=' + jsonValue(imported, 'mail import').inserted)
        })
        // Consent is bound to the provider + base URL it was granted under.
        const grant = runJsonCli(workdir, ['consent', 'grant', 'mail.extract', '--yes', '--json'], { index: 'policy-binding-grant' })
        runs.push(grant.run)
        check(checks, 'consent-granted-under-default-provider', () => {
          if (grant.run.status !== 0) throw new Error('exit ' + grant.run.status + ': ' + grant.run.stderr.slice(0, 200))
          const entry = jsonValue(grant, 'consent grant').entry ?? {}
          if (entry.provider !== 'deepseek') throw new Error('provider=' + entry.provider)
          if (entry.baseUrl !== 'https://api.deepseek.com') throw new Error('baseUrl=' + entry.baseUrl)
        })
        const fakeKey = { ADVISERS_API_KEY: 'sk-eval-consent-binding-unit-test' }
        const changedBaseUrl = runJsonCli(workdir, ['mail', 'extract', '--all-new', '--model', '--yes', '--json'], {
          index: 'policy-binding-base-url',
          extra: { ...fakeKey, ADVISERS_BASE_URL: 'https://api.openai.com/v1' },
        })
        const changedProvider = runJsonCli(workdir, ['mail', 'extract', '--all-new', '--model', '--yes', '--json'], {
          index: 'policy-binding-provider',
          extra: { ...fakeKey, ADVISERS_PROVIDER: 'openai' },
        })
        runs.push(changedBaseUrl.run, changedProvider.run)
        check(checks, 'changed-base-url-invalidates-consent', () => {
          if (changedBaseUrl.run.status !== 1) throw new Error('exit ' + changedBaseUrl.run.status)
          const code = envelopeCode(changedBaseUrl, 'mail extract --model (changed base URL)')
          if (code !== 'E_POLICY_CONSENT_REQUIRED') throw new Error('code=' + code)
        })
        check(checks, 'changed-provider-invalidates-consent', () => {
          if (changedProvider.run.status !== 1) throw new Error('exit ' + changedProvider.run.status)
          const code = envelopeCode(changedProvider, 'mail extract --model (changed provider)')
          if (code !== 'E_POLICY_CONSENT_REQUIRED') throw new Error('code=' + code)
        })
        check(checks, 'no-request-before-denial', () => {
          for (const run of [changedBaseUrl.run, changedProvider.run]) {
            if (run.network.length) throw new Error('network attempted before the consent gate: ' + JSON.stringify(run.network.slice(0, 5)))
          }
        })
        const lsAfter = runJsonCli(workdir, ['mail', 'ls', '--json'], { index: 'policy-binding-ls' })
        runs.push(lsAfter.run)
        check(checks, 'mail-untouched', () => {
          if (lsAfter.run.status !== 0) throw new Error('exit ' + lsAfter.run.status)
          const message = jsonValue(lsAfter, 'mail ls').messages?.[0] ?? {}
          if (message.status !== 'new') throw new Error('status=' + message.status)
          if ((message.candidateIds ?? []).length !== 0) throw new Error('candidateIds=' + JSON.stringify(message.candidateIds))
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.policy.protected-model-fail-closed',
    group: 'policy',
    title: 'model extraction is refused for a secrecy>0 matter before consent or any model call',
    async run() {
      return withFreshHome('policy-protected-model', async (workdir) => {
        const checks = []
        const runs = []
        const store = await openStateStore(workdir.home)
        try {
          store.mutate(() => {
            store.insertMatter({
              id: 'm_protected', title: '保密事项', status: 'active', domain: 'work', secrecy: 2,
              participants: [], deadlines: [], openQuestions: [],
              createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
            })
          })
        } finally {
          store.close()
        }
        writeWorkFile(workdir, 'sample.eml', EML_SAMPLE)
        const imported = runJsonCli(workdir, ['mail', 'import', 'sample.eml', '--json'], { index: 'policy-protected-import' })
        runs.push(imported.run)
        check(checks, 'import.exit-0', () => {
          if (imported.run.status !== 0) throw new Error('exit ' + imported.run.status + ': ' + imported.run.stderr.slice(0, 200))
        })
        // Grant consent first: the protected-matter refusal must still win (it is
        // a property of the record, not of the consent state).
        const grant = runJsonCli(workdir, ['consent', 'grant', 'mail.extract', '--yes', '--json'], { index: 'policy-protected-grant' })
        runs.push(grant.run)
        check(checks, 'consent-granted', () => {
          if (grant.run.status !== 0) throw new Error('exit ' + grant.run.status + ': ' + grant.run.stderr.slice(0, 200))
        })
        const protectedRun = runJsonCli(workdir, ['mail', 'extract', '--all-new', '--model', '--yes', '--matter', 'm_protected', '--json'], {
          index: 'policy-protected-extract',
          extra: { ADVISERS_API_KEY: 'sk-eval-protected-unit-test' },
        })
        runs.push(protectedRun.run)
        check(checks, 'protected-matter-fails-closed', () => {
          if (protectedRun.run.status !== 1) throw new Error('exit ' + protectedRun.run.status)
          if (protectedRun.run.stdout !== '') throw new Error('stdout not empty: ' + JSON.stringify(protectedRun.run.stdout.slice(0, 120)))
          const code = envelopeCode(protectedRun, 'mail extract --model (protected matter)')
          if (code !== 'E_MAIL_MODEL_DISABLED') throw new Error('code=' + code)
          if (!/protected matters/.test(protectedRun.run.stderr)) throw new Error('stderr does not name the protection rule')
        })
        check(checks, 'no-request-before-denial', () => {
          if (protectedRun.run.network.length) throw new Error('network attempted before the protection gate: ' + JSON.stringify(protectedRun.run.network.slice(0, 5)))
        })
        const lsAfter = runJsonCli(workdir, ['mail', 'ls', '--json'], { index: 'policy-protected-ls' })
        runs.push(lsAfter.run)
        check(checks, 'message-untouched-and-no-candidates', () => {
          if (lsAfter.run.status !== 0) throw new Error('exit ' + lsAfter.run.status)
          const message = jsonValue(lsAfter, 'mail ls').messages?.[0] ?? {}
          if (message.status !== 'new') throw new Error('status=' + message.status)
          if ((message.candidateIds ?? []).length !== 0) throw new Error('candidateIds=' + JSON.stringify(message.candidateIds))
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
]
