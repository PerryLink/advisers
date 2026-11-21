/**
 * Runtime TOS gate: packaged manifest, local acceptance record, and the pure
 * decision helpers the CLI uses to implement docs/TOS.md §2.
 *
 * Contract implemented here:
 * - The acceptance record lives in `$ADVISERS_HOME/tos.json` (mode 0600, written
 *   with a same-directory temp file + fsync + rename).
 * - The record stores ONLY `version`, `sha256` (the manifest's hash of the TOS
 *   text), `acceptedAt`, `channel` (`interactive` | `flag` | `env`),
 *   `nonInteractive`, and `revokedAt` after a revoke. It NEVER stores the terms
 *   text (or any user content).
 * - Interactive acceptance requires the user to type 同意; `y`/`yes` are
 *   accepted as shortcuts. Empty input, Enter, `n`, or anything else rejects.
 * - Non-interactive acceptance requires `--accept-tos` or
 *   `ADVISERS_ACCEPT_TOS=1|true|yes|<version>`. Per TOS §2.5 the env var never
 *   takes effect when stdin is a TTY; the explicit `--accept-tos` flag does.
 * - A changed TOS version or text hash invalidates the old record; revocation
 *   (`revokedAt`) also invalidates it. The audit-chain writes and process exit
 *   codes stay in bin/advisers.js so this module can be unit-tested without a PTY.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

/** File name of the local acceptance record inside ADVISERS_HOME. */
export const RECORD_FILE = 'tos.json'
/** File name of the source-checkout dev notice marker inside ADVISERS_HOME. */
export const SOURCE_REVIEW_FILE = 'source-reviewed.json'
/** Repo root when running from a git checkout (four levels above lib/tos/index.js). */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
/** Online canonical text (also printed by `advisers tos show`). */
export const ONLINE_TOS_URL = 'https://github.com/PerryLink/advisers/blob/main/docs/TOS.md'
/** Commands that stay usable without accepting the TOS (TOS §2.1 last sentence). */
export const EXEMPT_COMMANDS = new Set(['help', '--help', '-h', 'version', '--version', '-v', 'status', 'doctor', 'init', 'tos'])
/** Words/answers that count as explicit interactive acceptance. */
export const ACCEPT_WORDS = new Set(['同意'])
export const ACCEPT_SHORTCUTS = new Set(['y', 'yes'])
/** Values that mean "yes" for --accept-tos=<value>. */
const ACCEPT_VALUES = new Set(['1', 'true', 'yes'])
/** Values that mean "no" for ADVISERS_ACCEPT_TOS (treated as unset). */
const DECLINE_VALUES = new Set(['0', 'false', 'no'])

const MANIFEST_PATH = fileURLToPath(new URL('./manifest.json', import.meta.url))
let manifestCache

/** Read the packaged manifest (version + per-file SHA-256). */
export function readManifest() {
  manifestCache ??= JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  return manifestCache
}

/** Resolve the current TOS facts (version/hash/paths) from the packaged manifest. */
export function currentTos({ version } = {}) {
  const manifest = readManifest()
  const files = Array.isArray(manifest.files) ? manifest.files : []
  const entry = files.find((file) => file.source === manifest.canonical)
    ?? files.find((file) => file.path === 'terms.zh-CN.md')
    ?? files[0]
  if (!entry?.sha256 || typeof entry.path !== 'string') throw new Error('packaged TOS manifest is missing the TOS text hash/path')
  const envVersion = typeof process.env.ADVISERS_TOS_VERSION === 'string' ? process.env.ADVISERS_TOS_VERSION.trim() : ''
  const resolvedVersion = version ?? (envVersion || manifest.version)
  return {
    version: resolvedVersion,
    manifestVersion: manifest.version,
    effectiveFrom: manifest.effectiveFrom,
    language: manifest.language,
    sha256: entry.sha256,
    canonical: manifest.canonical,
    termsPath: fileURLToPath(new URL(entry.path, import.meta.url)),
    url: ONLINE_TOS_URL,
    versionOverridden: Boolean(envVersion && envVersion !== manifest.version),
  }
}

/** Default Advisers home (same rule as the CLI). */
export function defaultHome() {
  return process.env.ADVISERS_HOME || join(homedir(), '.advisers')
}

/** Path of the acceptance record for a home directory. */
export function acceptancePath(home = defaultHome()) {
  return join(home, RECORD_FILE)
}

/** Validate a parsed record; returns a clean record or null (fail closed). */
export function validateAcceptance(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  const sha256 = typeof record.sha256 === 'string' ? record.sha256.trim() : ''
  const acceptedAt = typeof record.acceptedAt === 'string' ? record.acceptedAt.trim() : ''
  const channel = ['interactive', 'flag', 'env'].includes(record.channel) ? record.channel : ''
  if (!version || !/^[a-f0-9]{64}$/.test(sha256) || !acceptedAt || !channel) return null
  if (Number.isNaN(Date.parse(acceptedAt))) return null
  const clean = {
    version,
    sha256,
    acceptedAt,
    channel,
    nonInteractive: record.nonInteractive === true || record.nonInteractive === 1,
  }
  if (typeof record.revokedAt === 'string' && !Number.isNaN(Date.parse(record.revokedAt))) clean.revokedAt = record.revokedAt
  return clean
}

/** Read the local acceptance record; missing/corrupt records fail closed (null). */
export function readAcceptance(home = defaultHome()) {
  try {
    const target = acceptancePath(home)
    if (!existsSync(target)) return null
    return validateAcceptance(JSON.parse(readFileSync(target, 'utf8')))
  } catch {
    return null
  }
}

/** Atomically write the acceptance record with mode 0600. */
export function writeAcceptance(home = defaultHome(), record) {
  const clean = validateAcceptance(record)
  if (!clean) throw new Error('refusing to write an invalid TOS acceptance record')
  const target = acceptancePath(home)
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch {}
  const temp = join(dir, `.${RECORD_FILE}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeSync(fd, JSON.stringify(clean, null, 2) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, target)
  } catch (error) {
    try { if (existsSync(temp)) rmSync(temp) } catch {}
    throw error
  }
  try { chmodSync(target, 0o600) } catch {}
  try {
    const dirFd = openSync(dir, 'r')
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  } catch {}
  return clean
}

/** Mark the current acceptance as revoked (keeps version/hash/timestamp history). */
export function revokeAcceptance(home = defaultHome(), { revokedAt = new Date().toISOString() } = {}) {
  const record = readAcceptance(home)
  if (!record) return null
  return writeAcceptance(home, { ...record, revokedAt })
}

/**
 * Decide whether the current TOS version/hash is accepted for a home.
 * @returns {{accepted: boolean, reason: 'accepted'|'missing'|'invalid'|'revoked'|'version-changed'|'text-changed', record: object|null}}
 */
export function acceptanceStatus({ home = defaultHome(), version, sha256 } = {}) {
  const info = version && sha256 ? { version, sha256 } : currentTos()
  const record = readAcceptance(home)
  if (!record) return { accepted: false, reason: 'missing', record: null }
  if (record.revokedAt) return { accepted: false, reason: 'revoked', record }
  if (record.version !== info.version) return { accepted: false, reason: 'version-changed', record }
  if (record.sha256 !== info.sha256) return { accepted: false, reason: 'text-changed', record }
  return { accepted: true, reason: 'accepted', record }
}

/**
 * Interpret an interactive answer. `同意` is required; y/yes are shortcuts.
 * Empty input (Enter), n, or anything else rejects.
 */
export function decidePrompt(answer) {
  const normalized = String(answer ?? '').trim().toLowerCase()
  if (!normalized) return { accepted: false, reason: 'empty' }
  if (ACCEPT_WORDS.has(normalized) || ACCEPT_SHORTCUTS.has(normalized)) return { accepted: true, reason: 'explicit' }
  return { accepted: false, reason: 'rejected' }
}

/**
 * Resolve explicit non-interactive consent.
 * @returns {null | {ok: true, channel: 'flag'|'env', nonInteractive: true} | {ok: false, error: string}}
 */
export function resolveConsent({ flag, env, version, isTTY = false } = {}) {
  if (flag !== undefined && flag !== null && flag !== false) {
    const raw = flag === true ? '' : String(flag).trim()
    if (!raw || ACCEPT_VALUES.has(raw.toLowerCase()) || raw === version) return { ok: true, channel: 'flag', nonInteractive: true }
    return { ok: false, error: `--accept-tos version "${raw}" does not match the current TOS version ${version}` }
  }
  // TOS §2.5: ADVISERS_ACCEPT_TOS never takes effect in an interactive TTY.
  if (isTTY) return null
  const raw = env === undefined || env === null ? '' : String(env).trim()
  if (!raw) return null
  const lowered = raw.toLowerCase()
  if (DECLINE_VALUES.has(lowered)) return null
  if (ACCEPT_VALUES.has(lowered) || raw === version) return { ok: true, channel: 'env', nonInteractive: true }
  return { ok: false, error: `ADVISERS_ACCEPT_TOS must be 1|true|yes or the current TOS version ${version} (got "${raw}")` }
}

/** Whether a command may run without accepting the TOS. */
export function isExemptCommand(command, { isTTY = false } = {}) {
  if (!command) return !isTTY
  return EXEMPT_COMMANDS.has(command)
}

/** TTY summary printed before the first acceptance prompt (12 lines, plus prompt). */
export function summaryLines({ version = currentTos().version, url = ONLINE_TOS_URL } = {}) {
  return [
    `Advisers · 使用条款摘要（v${version}）`,
    '1. 许可：PolyForm Noncommercial 1.0.0，仅限个人非商业用途；商业使用需另行书面授权。文档/数据/设计按 CC BY-NC-SA 4.0。',
    '2. 旧版本许可不变：0.2.0-preview.71 及更早版本按其发布时的许可证继续有效。',
    '3. 本地优先助手，不提供法律、医疗、财务、税务、会计等专业意见；AI 输出可能出错，请自行核验并承担对外使用后果。',
    '4. 禁止违法与有害用途：违法内容、诈骗、侵权、危害未成年人、深度伪造或逃避 AI 标识等（详见第 4 条）。',
    '5. 你是内容安全审核与 AI 生成内容标识的第一责任人。',
    '6. 数据默认留在本机：邮件、知识库与回款记录默认本地处理；设置 ADVISERS_API_KEY 后相关模型输入会发送给你配置的模型服务；`mail sync` 只读连接你配置的 IMAP 服务器；`mail extract --model` 须显式 opt-in 并另行单独同意（与接受 TOS 分开记录、更换服务商即失效）；运行 bridge（Hermes 文件网关）时本软件按轮询持续与 Hermes 交换明文 JSON 并可能经其平台出网；受保护事项模型调用 fail-closed。',
    '7. 免责与责任限制：按“现状”提供；免费版本累计赔偿责任上限为人民币壹佰元（¥100），法律不得排除的责任除外。',
    '8. 管辖：适用中华人民共和国法律；争议由运营者住所地有管辖权的人民法院管辖（第 15.2 条）。',
    '9. 修改人格/例行、数据替换等操作每次会再次确认；TTS/DLC 在 0.2.0 不提供，未来将另行取得明确同意。',
    `10. 完整条款：运行 advisers tos show（随包于 packages/advisers/lib/tos/terms.zh-CN.md）；在线：${url}`,
    '11. 接受记录只含版本、文本 SHA-256、时间与渠道（写入本地审计链，不写条款正文）；可用 advisers tos revoke 撤回。',
  ]
}

/** Short re-confirmation notice shown for each modification surface (≤5 lines). */
export function modificationNotice({ scope = 'config', action = '' } = {}) {
  if (scope === 'routine') {
    return [
      '修改确认 · 例行/自动化（routine）',
      '例行会在后续会话中被复用；请勿写入违法、越权或对外自动发送的步骤。',
      '仅个人非商业用途；本次确认会写入本地审计链（tos.reaccept，scope=routine）。',
    ]
  }
  if (scope === 'import') {
    return [
      '修改确认 · 数据替换（import --replace）',
      '导入会覆盖既有账本（导入前会自动备份 state.db）；请确认导入文件来源可信。',
      '仅个人非商业用途；本次确认会写入本地审计链（tos.reaccept，scope=import）。',
    ]
  }
  return [
    '修改确认 · 人格/设定（soul）',
    '你即将替换 Advisers 的人格/行为设定。许可：PolyForm Noncommercial 1.0.0，仅个人非商业；对外分发或商用需另行授权。',
    '设定导致的输出由你负责，不得写入违法或伤害性指令；本次确认会写入本地审计链（tos.reaccept，scope=config）。',
  ]
}

/**
 * TOS §2.3 "源码修改版" row: when the CLI runs from a git checkout that has
 * local modifications, show a non-blocking notice once per fingerprint change.
 * Returns null when this is not a git checkout of the Advisers repo.
 * @returns {string|null} fingerprint like `<sha7|nogit>+dirty` / `<sha7>`
 */
export function sourceCheckoutFingerprint() {
  try {
    // Only a real checkout of this repo: an npm install inside some *other* git
    // project must not be mistaken for the Advisers source checkout.
    if (!existsSync(join(REPO_ROOT, '.git'))) return null
    if (!existsSync(join(REPO_ROOT, 'packages', 'advisers', 'bin', 'advisers.js'))) return null
  } catch {
    return null
  }
  const run = (args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
  try {
    const head = run(['rev-parse', '--short=7', 'HEAD'])
    const dirty = run(['status', '--porcelain', '--untracked-files=no']).length > 0
    return `${head || 'nogit'}${dirty ? '+dirty' : ''}`
  } catch {
    return 'nogit'
  }
}

/** Read the last fingerprint the dev-source notice was shown for (marker file). */
export function readSourceFingerprint(home = defaultHome()) {
  try {
    const parsed = JSON.parse(readFileSync(join(home, SOURCE_REVIEW_FILE), 'utf8'))
    return typeof parsed?.fingerprint === 'string' ? parsed.fingerprint : null
  } catch {
    return null
  }
}

/** Atomically remember the fingerprint the notice was shown for (0600). */
export function writeSourceFingerprint(home = defaultHome(), fingerprint) {
  if (typeof fingerprint !== 'string' || !fingerprint) throw new Error('refusing to write an empty source fingerprint')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const target = join(home, SOURCE_REVIEW_FILE)
  const temp = join(home, `.${SOURCE_REVIEW_FILE}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeSync(fd, JSON.stringify({ fingerprint, noticedAt: new Date().toISOString() }, null, 2) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try { renameSync(temp, target) } catch (error) { try { if (existsSync(temp)) rmSync(temp) } catch {} throw error }
  try { chmodSync(target, 0o600) } catch {}
  return fingerprint
}

/** Whether the dev-source notice should be shown (dirty checkout, new fingerprint). */
export function shouldNoticeSourceModified({ home = defaultHome(), fingerprint } = {}) {
  if (typeof fingerprint !== 'string' || !fingerprint.endsWith('+dirty')) return false
  return readSourceFingerprint(home) !== fingerprint
}

/** Non-blocking notice for a locally modified source checkout (TOS §2.3). */
export function sourceModifiedNotice({ fingerprint = 'nogit+dirty' } = {}) {
  return [
    `开发者模式 · 源码修改版（指纹 ${fingerprint}）`,
    '你在源码 checkout 中运行含本地改动的版本。PolyForm Noncommercial 1.0.0 允许个人非商业修改；对外提供服务或分发修改版需另行授权。',
    '请勿移除 policy / 审计 / 内容安全钩子。本提示不阻塞运行，指纹变化后首次提示。',
  ]
}

/**
 * Print notice lines and read one interactive answer. TTY-only; callers check
 * process.stdin.isTTY first (the pure `decidePrompt` is what the tests exercise).
 * @returns {Promise<{accepted: boolean, reason: string, answer: string}>}
 */
export async function promptForConsent({ version, lines, question, stdin = process.stdin, stdout = process.stdout } = {}) {
  const body = Array.isArray(lines) && lines.length ? lines : summaryLines({ version })
  const terminal = createInterface({ input: stdin, output: stdout })
  try {
    for (const line of body) stdout.write(`${line}\n`)
    const answer = await terminal.question(question ?? '输入“同意”后回车接受并继续（n 或直接 Enter 拒绝）：')
    return { ...decidePrompt(answer), answer: String(answer ?? '').trim() }
  } finally {
    try { terminal.close() } catch {}
  }
}
