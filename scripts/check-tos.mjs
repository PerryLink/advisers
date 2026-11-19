#!/usr/bin/env node
/**
 * TOS / legal-docs consistency gate (dual mode).
 *
 * docs/TOS.md is the single canonical TOS text. docs/PRIVACY.md, docs/DISCLAIMER.md and
 * docs/SAFETY.md are canonical too. packages/advisers/lib/tos/ ships byte-identical
 * packaged copies plus manifest.json (version + effective date + per-file SHA-256) for the
 * CLI consent gate to consume.
 *
 * Two modes:
 *
 *   node scripts/check-tos.mjs             # development mode: review markers are tolerated
 *   node scripts/check-tos.mjs --release   # release mode: finalized texts only (no
 *                                          # 【需法务复核】/草案/占位/TBD, operator & contact &
 *                                          # venue & effective date resolved, PRIVACY shipped
 *                                          # and referenced, legal-citations.json complete,
 *                                          # package README carries the AI/legal notice)
 *
 * Both modes fail when the packaged copies drift from docs/, the manifest hash/version/date
 * disagree, required legal material disappears, or README/QUICKSTART/CONTRIBUTING lose
 * their legal-doc links or any local relative markdown link is dead.
 *
 * URL connectivity for the legal citations is intentionally NOT asserted here (government
 * sites move and CI must stay offline-stable); release-mode validates the structured
 * citations and the release owner verifies the links in a browser (record: docs/TOS.md
 * appendix A, accessed 2026-11-17).
 *
 * Run: node scripts/check-tos.mjs [--release]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const RELEASE = process.argv.includes('--release')
const FINAL_EFFECTIVE = '2026-11-20'

const failures = []
const warnings = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(detail ? `${name} — ${detail}` : name)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}
const info = (message) => console.log(`INFO ${message}`)
const warn = (message) => {
  warnings.push(message)
  console.log(`WARN ${message}`)
}
const read = (file) => readFileSync(join(root, file), 'utf8')
const readJson = (file) => JSON.parse(read(file))
const sha256 = (file) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex')

const MANIFEST = 'packages/advisers/lib/tos/manifest.json'
const TOS = 'docs/TOS.md'
const DISCLAIMER = 'docs/DISCLAIMER.md'
const PRIVACY = 'docs/PRIVACY.md'
const SAFETY = 'docs/SAFETY.md'
const TEMPLATE = 'templates/legal-notice-code-template.md'
const CITATIONS = 'docs/legal-citations.json'
const PKG_README_EN = 'packages/advisers/README.md'
const PKG_README_ZH = 'packages/advisers/README-zh.md'
const CANONICAL_FILES = [TOS, DISCLAIMER, PRIVACY, SAFETY]

console.log(`INFO mode: ${RELEASE ? 'release (finalized legal texts)' : 'development (review markers tolerated)'}`)

// ---------------------------------------------------------------------------
// 0. Required files exist.
// ---------------------------------------------------------------------------
for (const file of [TOS, DISCLAIMER, PRIVACY, SAFETY, TEMPLATE, MANIFEST, CITATIONS, PKG_README_EN, PKG_README_ZH]) {
  check(`${file} exists`, existsSync(join(root, file)))
}
if (failures.length) {
  console.error(`\n${failures.length} missing legal-doc file(s); cannot continue.`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. Manifest shape and version/date.
// ---------------------------------------------------------------------------
let manifest
try {
  manifest = readJson(MANIFEST)
  check('manifest.json parses as JSON', true)
} catch (error) {
  check('manifest.json parses as JSON', false, error.message)
  console.error('\nCannot continue without a readable manifest.')
  process.exit(1)
}

const { version, effectiveFrom } = manifest
check('manifest schema is advisers.tos/1', manifest.schema === 'advisers.tos/1', String(manifest.schema))
check('manifest.version matches YYYY.MM.N', typeof version === 'string' && /^\d{4}\.\d{2}\.\d+$/.test(version), String(version))
check('manifest.effectiveFrom is an ISO date', typeof effectiveFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom), String(effectiveFrom))
check('manifest.effectiveFrom is a real date', !Number.isNaN(Date.parse(effectiveFrom ?? '')), String(effectiveFrom))
check('manifest.language is zh-CN', manifest.language === 'zh-CN', String(manifest.language))
check('manifest.canonical is docs/TOS.md', manifest.canonical === TOS, String(manifest.canonical))
check('manifest.shortNotice is docs/DISCLAIMER.md', manifest.shortNotice === DISCLAIMER, String(manifest.shortNotice))
check('manifest.privacy is docs/PRIVACY.md', manifest.privacy === PRIVACY, String(manifest.privacy))
check('manifest.safety is docs/SAFETY.md', manifest.safety === SAFETY, String(manifest.safety))

const tosText = read(TOS)
const disclaimerText = read(DISCLAIMER)
const privacyText = read(PRIVACY)
const safetyText = read(SAFETY)

const versionFrom = (text, file) => {
  const match = /文档版本\s*\|\s*\**\s*(\d{4}\.\d{2}\.\d+)/.exec(text)
  return match?.[1]
}
const effectiveFromText = (text) => /生效日期\s*\|\s*(\d{4}-\d{2}-\d{2})/.exec(text)?.[1]

const tosVersion = versionFrom(tosText, TOS)
check('docs/TOS.md header version matches manifest.version', tosVersion === version, `found ${tosVersion}, expected ${version}`)
const tosEffective = effectiveFromText(tosText)
check('docs/TOS.md effective date matches manifest.effectiveFrom', tosEffective === effectiveFrom, `found ${tosEffective}, expected ${effectiveFrom}`)
const privacyVersion = versionFrom(privacyText, PRIVACY)
check('docs/PRIVACY.md header version matches manifest.version', privacyVersion === version, `found ${privacyVersion}, expected ${version}`)
const privacyEffective = effectiveFromText(privacyText)
check('docs/PRIVACY.md effective date matches manifest.effectiveFrom', privacyEffective === effectiveFrom, `found ${privacyEffective}, expected ${effectiveFrom}`)
check('docs/DISCLAIMER.md names the current TOS version', disclaimerText.includes(`v${version}`), `missing v${version}`)
check('docs/SAFETY.md names the current TOS version', safetyText.includes(version), `missing ${version}`)

// ---------------------------------------------------------------------------
// 2. Packaged copies are byte-identical to the canonical docs and hashes match.
// ---------------------------------------------------------------------------
const packageDir = dirname(MANIFEST)
check('manifest.files is a non-empty array', Array.isArray(manifest.files) && manifest.files.length > 0)
const packagedBySource = new Map()
const packagedPaths = new Set()
for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
  const rel = typeof entry?.path === 'string' ? entry.path : ''
  const safe = rel.length > 0 && !isAbsolute(rel) && !rel.split(/[\\/]/).includes('..')
  check(`manifest files[] path is safe: ${rel || '<missing>'}`, safe)
  if (!safe) continue
  packagedPaths.add(rel)
  const packagedFile = join(packageDir, rel)
  const packagedExists = existsSync(join(root, packagedFile))
  check(`packaged legal text exists: ${packagedFile}`, packagedExists)
  const hashOk = /^[a-f0-9]{64}$/.test(entry.sha256 ?? '') && packagedExists && sha256(packagedFile) === entry.sha256
  check(`manifest sha256 matches packaged file: ${rel}`, hashOk, hashOk ? '' : 'hash drift — bump the manifest after editing the text')
  if (typeof entry.source !== 'string') continue
  const sourceExists = existsSync(join(root, entry.source))
  check(`manifest source exists: ${entry.source}`, sourceExists)
  if (!sourceExists) continue
  const identical = packagedExists && sha256(packagedFile) === sha256(entry.source)
  check(`packaged copy is byte-identical to ${entry.source}`, identical, identical ? '' : `re-copy docs text to ${packagedFile}`)
  if (identical) packagedBySource.set(entry.source, rel)
}
for (const source of CANONICAL_FILES) {
  check(`manifest ships ${source}`, packagedBySource.has(source), 'no files[] entry with source ' + source)
}
if (RELEASE) {
  const expected = new Set(CANONICAL_FILES)
  const unknown = [...packagedBySource.keys()].filter((source) => !expected.has(source))
  check('manifest.files covers exactly the packaged legal texts', packagedBySource.size === expected.size && unknown.length === 0, `extra sources: ${unknown.join(', ') || 'none'}`)
}

// ---------------------------------------------------------------------------
// 3. Required legal material is present in the canonical TOS.
// ---------------------------------------------------------------------------
const REQUIRED_LAWS = [
  '民法典',
  '刑法',
  '治安管理处罚法',
  '网络安全法',
  '数据安全法',
  '个人信息保护法',
  '网络数据安全管理条例',
  '未成年人网络保护条例',
  '生成式人工智能服务管理暂行办法',
  '互联网信息服务深度合成管理规定',
  '人工智能生成合成内容标识办法',
  'GB 45438-2025',
  'TC260-003',
  '人工智能拟人化互动服务管理暂行办法',
  '网络信息内容生态治理规定',
  '互联网信息服务算法推荐管理规定',
  '网络暴力信息治理规定',
  '具有舆论属性或社会动员能力的互联网信息服务安全评估规定',
  '互联网信息服务管理办法',
  '促进和规范数据跨境流动规定',
  '清朗',
]
for (const law of REQUIRED_LAWS) {
  check(`docs/TOS.md covers ${law}`, tosText.includes(law))
}

const REQUIRED_CLAUSES = {
  'prohibited behaviour clause': '禁止',
  'AI-generated-content risk clause': 'AI 生成内容',
  'TTS / deep synthesis and labelling clause': '深度合成',
  'AI labelling duty': '标识',
  'minor protection clause': '未成年人',
  'personal information / customer data clause': '个人信息',
  'customer data clause': '客户数据',
  'health-use clause': '健康使用',
  'disclaimer / liability limitation clause': '责任限制',
  're-confirmation clause': '重新确认',
  'DLC / extension-point clause': '扩展点',
  'governing law clause': '中华人民共和国法律',
  'contact channel clause': '联系与投诉渠道',
  'non-OSI-licence statement': '不是 OSI 开源许可证',
  'PolyForm software licence': 'PolyForm Noncommercial 1.0.0',
  'CC BY-NC-SA docs licence': 'CC BY-NC-SA 4.0',
  'licence notice requirement': 'Required Notice',
  'version-bump on text change': '升级版本号',
  'operator identity': 'PerryLink',
  'operator venue': '运营者住所地',
  'liability cap (free version)': '人民币壹佰元',
  'consent withdrawal': '撤回',
  'delegated processing': '委托处理',
  'separate consent': '单独同意',
  'cross-border transfer': '跨境',
  'personal-information impact assessment': '个人信息保护影响评估',
  'default telemetry-free statement': '不含遥测',
  'local DB not encrypted by default': '默认不加密',
  'partial purge disclosure': 'purge 是部分删除',
  'forget tombstone disclosure': '墓碑',
}
for (const [name, needle] of Object.entries(REQUIRED_CLAUSES)) {
  check(`docs/TOS.md has ${name}`, tosText.includes(needle), `missing "${needle}"`)
}

// The egress list must be complete (lead decision E, 2026-11-17).
const REQUIRED_EGRESS = ['api.deepseek.com', 'chat', 'capture', 'review', 'brief --deep', 'learn review', 'research', 'IMAP', 'webhook', 'sync', 'MCP', 'DSH', '桌宠', '遥测', 'bridge', 'Hermes', 'inbox', 'outbox']
for (const needle of REQUIRED_EGRESS) {
  check(`docs/TOS.md data clause lists egress: ${needle}`, tosText.includes(needle))
}

// ---------------------------------------------------------------------------
// 4. Short disclaimer is short, current, and points to the TOS / privacy notice.
// ---------------------------------------------------------------------------
const disclaimerLines = disclaimerText.split(/\r?\n/).filter((line) => line.trim().length > 0)
check('docs/DISCLAIMER.md is a short notice (4-12 non-empty lines)', disclaimerLines.length >= 4 && disclaimerLines.length <= 12, `${disclaimerLines.length} non-empty lines`)
for (const [name, needle] of Object.entries({
  'AI fallibility': 'AI 输出可能错误',
  'prohibited use': '禁止使用',
  'minors': '未成年人',
  'TTS / labelling': '标识',
  'liability limit': '责任',
  'not a compliance certification': '不构成合规认证',
  'privacy notice reference': 'PRIVACY.md',
  'bridge / Hermes egress': /bridge[^\n]*Hermes/,
})) {
  const ok = typeof needle === 'string' ? disclaimerText.includes(needle) : needle.test(disclaimerText)
  check(`docs/DISCLAIMER.md has ${name}`, ok, `missing "${String(needle)}"`)
}

// ---------------------------------------------------------------------------
// 5. SAFETY.md uses the honest framing.
// ---------------------------------------------------------------------------
check('docs/SAFETY.md marks the mechanism as auxiliary', safetyText.includes('辅助机制'))
check('docs/SAFETY.md denies being a compliance certification', /不构成[^。\n]*合规认证/.test(safetyText))
check('docs/SAFETY.md states the user remains responsible', /第一责任人|自行承担/.test(safetyText))
check('docs/SAFETY.md links the privacy notice', safetyText.includes('PRIVACY.md'))

// ---------------------------------------------------------------------------
// 6. PRIVACY.md covers the data-flow disclosure required by the legal review.
// ---------------------------------------------------------------------------
const REQUIRED_PRIVACY = {
  'operator does not process personal data': /运营者不接收、不存储、不访问|运营者不通过本软件处理你的个人信息/,
  'user as personal-information controller': '个人信息处理者',
  'DeepSeek default provider': 'api.deepseek.com',
  'delegated processing': '委托处理',
  'separate consent': '单独同意',
  'cross-border transfer and impact assessment': '个人信息保护影响评估',
  'default plaintext database': /默认不顺?加密|默认数据库\*\*不加密/,
  'backup/undo/import copies': 'import-backup-*.db',
  'partial purge + tombstone': /purge 是部分删除/,
  'IMAP egress': 'IMAP',
  'webhook egress': 'webhook',
  'sync egress': 'sync',
  'MCP egress': 'MCP',
  'DSH egress': 'DSH',
  'desktop-pet egress': '桌宠',
  'bridge / Hermes egress': /bridge[^\n]*Hermes/,
  'minors 18 / 14 rules': /未满 18|18 周岁/,
  'under-14 rule': '14 周岁',
  'withdrawal': '撤回',
  'complaint channel': 'GitHub Issues',
}
for (const [name, needle] of Object.entries(REQUIRED_PRIVACY)) {
  const ok = typeof needle === 'string' ? privacyText.includes(needle) : needle.test(privacyText)
  check(`docs/PRIVACY.md covers ${name}`, ok, `missing ${String(needle)}`)
}

// ---------------------------------------------------------------------------
// 6b. Egress surfaces ↔ legal disclosures (anti-false-green).
//
// docs/TOS.md §9.3 and docs/PRIVACY.md §4 are the canonical complete egress
// lists. The `privacy` command lists the same surfaces from the code base, so
// the gate maps every surface it prints to a disclosure row: adding a new
// egress surface without updating the legal texts must FAIL, and deleting the
// bridge/Hermes row while the words survive elsewhere must FAIL too.
// ---------------------------------------------------------------------------
const BIN = 'packages/advisers/bin/advisers.js'
const binText = read(BIN)
const egressBlock = /const egressSurfaces = \[([\s\S]*?)\n  \]/.exec(binText)
check('privacy command egress-surface list is parseable', Boolean(egressBlock), `const egressSurfaces = [ ... ] not found in ${BIN}`)
const privacySurfaces = []
if (egressBlock) for (const match of egressBlock[1].matchAll(/'([^']+)'/g)) privacySurfaces.push(match[1])
check('privacy command lists egress surfaces', privacySurfaces.length >= 6, `${privacySurfaces.length} parsed`)

// Key = the part before the em dash in the `privacy` egress line. Each key must
// be disclosed by at least these needles in TOS §9.3 / PRIVACY §4.
const EGRESS_DISCLOSURE = {
  'model provider': { tos: ['模型调用', 'api.deepseek.com'], privacy: ['模型调用', 'api.deepseek.com'] },
  'research --web|--url': { tos: ['网页研究'], privacy: ['网页研究'] },
  'capture --from-imap': { tos: ['邮件导入'], privacy: ['邮件导入'] },
  'remind --deliver --notify': { tos: ['通知'], privacy: ['webhook'] },
  'sync push|pull': { tos: ['同步'], privacy: ['同步'] },
  bridge: { tos: ['桥接', 'Hermes'], privacy: ['桥接', 'Hermes'] },
  'MCP --stdio / DSH host tools / pet-brief': { tos: ['MCP', 'DSH', '桌宠'], privacy: ['MCP', 'DSH', '桌宠'] },
  'ocr / timestamp': { tos: ['OCR'], privacy: ['OCR'] },
}
const surfaceKeys = new Set()
for (const surface of privacySurfaces) {
  const key = surface.split(' — ')[0].trim()
  surfaceKeys.add(key)
  const disclosure = EGRESS_DISCLOSURE[key]
  check(`privacy egress surface is mapped to a legal disclosure: ${key}`, Boolean(disclosure), 'add the surface to docs/TOS.md §9.3 + docs/PRIVACY.md §4 and to EGRESS_DISCLOSURE')
  if (!disclosure) continue
  for (const needle of disclosure.tos) check(`docs/TOS.md §9.3 discloses "${key}" (${needle})`, tosText.includes(needle))
  for (const needle of disclosure.privacy) check(`docs/PRIVACY.md §4 discloses "${key}" (${needle})`, privacyText.includes(needle))
}
for (const key of Object.keys(EGRESS_DISCLOSURE)) {
  check(`legal egress map has no stale entry: ${key}`, surfaceKeys.has(key), 'remove it from EGRESS_DISCLOSURE')
}

// Row-scoped checks: deleting the bridge row/clause must fail even if the words
// "bridge"/"Hermes" still occur elsewhere in the document.
const bridgePrivacyRow = privacyText.split(/\r?\n/).find((line) => /^\|\s*\d+\s*\|[^\n]*bridge/i.test(line))
check('docs/PRIVACY.md §4 has a bridge/Hermes table row', Boolean(bridgePrivacyRow), 'no "| N | ... bridge ... |" row')
for (const needle of ['Hermes', 'inbox', 'outbox', '模型', '0700', '0600', '同步盘', '明文']) {
  check(`docs/PRIVACY.md bridge row discloses ${needle}`, Boolean(bridgePrivacyRow) && bridgePrivacyRow.includes(needle))
}
const bridgeTosClause = tosText.split(/\r?\n/).find((line) => /^（h）[^\n]*bridge/i.test(line))
check('docs/TOS.md §9.3 has a bridge (h) clause', Boolean(bridgeTosClause), 'no "（h）... bridge ..." clause')
for (const needle of ['Hermes', 'inbox', 'outbox', '模型服务商', '0700', '0600', '同步盘', '明文']) {
  check(`docs/TOS.md bridge clause discloses ${needle}`, Boolean(bridgeTosClause) && bridgeTosClause.includes(needle))
}

// ---------------------------------------------------------------------------
// 7. README / QUICKSTART / CONTRIBUTING must link the legal docs.
// ---------------------------------------------------------------------------
const LINK_FILES = ['README.md', 'README-zh.md', 'docs/QUICKSTART.md', 'CONTRIBUTING.md', TOS, DISCLAIMER, PRIVACY, SAFETY, TEMPLATE]
const REQUIRED_LINKS = {
  'README.md': [TOS, DISCLAIMER, SAFETY, PRIVACY],
  'README-zh.md': [TOS, DISCLAIMER, SAFETY, PRIVACY],
  'docs/QUICKSTART.md': [TOS, DISCLAIMER, SAFETY, PRIVACY],
  'CONTRIBUTING.md': [TOS, SAFETY, TEMPLATE],
}

const linkTargets = (file) => {
  const text = read(file)
  const baseDir = dirname(join(root, file))
  const targets = new Set()
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().split(/\s+/)[0]
    if (!raw || /^(https?:|mailto:|tel:|#|data:)/i.test(raw)) continue
    const target = raw.split('#')[0]
    if (!target) continue
    targets.add(resolve(baseDir, target))
  }
  return targets
}

for (const [file, required] of Object.entries(REQUIRED_LINKS)) {
  const targets = linkTargets(file)
  for (const requiredTarget of required) {
    check(`${file} links ${requiredTarget}`, targets.has(resolve(root, requiredTarget)))
  }
}
for (const file of LINK_FILES) {
  const dead = []
  const text = read(file)
  const baseDir = dirname(join(root, file))
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().split(/\s+/)[0]
    if (!raw || /^(https?:|mailto:|tel:|#|data:)/i.test(raw)) continue
    const target = raw.split('#')[0]
    if (!target) continue
    if (!existsSync(resolve(baseDir, target))) dead.push(raw)
  }
  check(`${file} has no dead local links`, dead.length === 0, [...new Set(dead)].join(', '))
}

// Privacy must be referenced by every user-facing entry point.
for (const file of [TOS, DISCLAIMER, 'README.md', 'README-zh.md', 'docs/QUICKSTART.md']) {
  check(`${file} references docs/PRIVACY.md`, read(file).includes('docs/PRIVACY.md'))
}

// ---------------------------------------------------------------------------
// 8. Extension-point template keeps its marker and bypass prohibition.
// ---------------------------------------------------------------------------
const templateText = read(TEMPLATE)
check('templates/legal-notice-code-template.md carries the legal-notice marker', templateText.includes('ADVISERS-LEGAL-NOTICE v1'))
check('templates/legal-notice-code-template.md forbids bypassing safety/audit/labels', /不得移除或绕过内容安全审核/.test(templateText))
const templateVersions = [...templateText.matchAll(/v(\d{4}\.\d{2}\.\d+)/g)].map((match) => match[1])
if (templateVersions.length && !templateVersions.includes(version)) {
  warn(`templates/legal-notice-code-template.md references TOS ${[...new Set(templateVersions)].join(', ')} but the manifest version is ${version}; bump the template (file not in the legal-text writer's scope) or refresh it before release`)
}

// ---------------------------------------------------------------------------
// 9. legal-citations.json: existence/parse in dev mode, full validation in release mode.
// ---------------------------------------------------------------------------
let citations = null
try {
  citations = readJson(CITATIONS)
  check('docs/legal-citations.json parses as JSON', true)
  check('docs/legal-citations.json has an entries array', Array.isArray(citations.entries) && citations.entries.length > 0)
} catch (error) {
  check('docs/legal-citations.json parses as JSON', false, error.message)
}

const CITATION_KINDS = ['law', 'administrative-regulation', 'department-rule', 'national-standard', 'technical-document', 'judicial-interpretation', 'action']
const CITATION_SOURCE_TYPES = ['database', 'official-page', 'official-site', 'name-only']
const CITATION_STATUSES = ['verified', 'name-only']
const CITATION_HOSTS = ['flk.npc.gov.cn', 'www.npc.gov.cn', 'npc.gov.cn', 'www.gov.cn', 'gov.cn', 'www.cac.gov.cn', 'openstd.samr.gov.cn', 'www.tc260.org.cn', 'www.xinhuanet.com']
const CITATION_PLACEHOLDERS = /【需法务复核|需法务复核|草案|待定|占位|TBD|【/

if (citations && RELEASE) {
  check('legal-citations schema is advisers.legal-citations/1', citations.schema === 'advisers.legal-citations/1', String(citations.schema))
  check('legal-citations.asOf is an ISO date', typeof citations.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(citations.asOf), String(citations.asOf))
  check('legal-citations.language is zh-CN', citations.language === 'zh-CN', String(citations.language))
  check('legal-citations declares at least 20 entries', Array.isArray(citations.entries) && citations.entries.length >= 20, `${Array.isArray(citations.entries) ? citations.entries.length : 0}`)
  const serialized = JSON.stringify(citations)
  check('legal-citations contains no review/placeholder markers', !CITATION_PLACEHOLDERS.test(serialized))
  const ids = new Set()
  for (const entry of Array.isArray(citations.entries) ? citations.entries : []) {
    const label = entry?.id || '<missing id>'
    const idOk = typeof entry?.id === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/.test(entry.id) && !ids.has(entry.id)
    check(`legal-citations id is unique and safe: ${label}`, idOk)
    if (typeof entry?.id === 'string') ids.add(entry.id)
    check(`legal-citations ${label} name`, typeof entry?.name === 'string' && entry.name.trim().length > 1)
    check(`legal-citations ${label} kind`, CITATION_KINDS.includes(entry?.kind), String(entry?.kind))
    check(`legal-citations ${label} authority`, typeof entry?.authority === 'string' && entry.authority.trim().length > 1)
    check(`legal-citations ${label} documentNumber`, typeof entry?.documentNumber === 'string' && entry.documentNumber.trim().length > 0)
    check(`legal-citations ${label} publishedAt`, entry?.publishedAt === null || (typeof entry?.publishedAt === 'string' && !Number.isNaN(Date.parse(entry.publishedAt))))
    check(`legal-citations ${label} effectiveAt`, entry?.effectiveAt === null || (typeof entry?.effectiveAt === 'string' && !Number.isNaN(Date.parse(entry.effectiveAt))))
    check(`legal-citations ${label} sourceType`, CITATION_SOURCE_TYPES.includes(entry?.sourceType), String(entry?.sourceType))
    check(`legal-citations ${label} status`, CITATION_STATUSES.includes(entry?.status), String(entry?.status))
    check(`legal-citations ${label} accessedAt`, typeof entry?.accessedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.accessedAt))
    if (entry?.url !== null && entry?.url !== undefined) {
      let urlOk = false
      try {
        const parsed = new URL(entry.url)
        urlOk = (parsed.protocol === 'https:' || parsed.protocol === 'http:') && CITATION_HOSTS.includes(parsed.hostname)
      } catch {}
      check(`legal-citations ${label} url is an official https/http URL`, urlOk, String(entry.url))
    }
    if (entry?.sourceType === 'name-only') {
      check(`legal-citations ${label} name-only entry has no URL`, entry.url === null || entry.url === undefined)
      check(`legal-citations ${label} name-only status`, entry.status === 'name-only')
    }
    check(`legal-citations ${label} is referenced in docs/TOS.md`, tosText.includes(entry.name))
  }
  for (const law of REQUIRED_LAWS) {
    check(`legal-citations covers ${law}`, (citations.entries ?? []).some((entry) => typeof entry?.name === 'string' && entry.name.includes(law)))
  }
}

// ---------------------------------------------------------------------------
// 10. Release-only: finalized texts, determined operator/contact/venue, package README.
// ---------------------------------------------------------------------------
const PLACEHOLDER_RE = /【需法务复核|需法务复核|草案|待定|占位|TBD|【|以实际发布版本为准/g
if (!RELEASE) {
  for (const file of CANONICAL_FILES) {
    const count = (read(file).match(PLACEHOLDER_RE) ?? []).length
    if (count > 0) info(`${file}: ${count} review marker(s) — allowed in development mode, blocked by --release`)
  }
}

if (RELEASE) {
  for (const file of CANONICAL_FILES) {
    const text = read(file)
    const matches = text.match(PLACEHOLDER_RE) ?? []
    check(`${file} is finalized (no review markers)`, matches.length === 0, `${matches.length} marker(s): ${[...new Set(matches)].join(', ')}`)
  }

  check('TOS names the operator (PerryLink)', tosText.includes('PerryLink'))
  check('TOS names the operator GitHub account', tosText.includes('https://github.com/PerryLink'))
  check('TOS gives the contact/complaint channel (GitHub Issues)', tosText.includes('https://github.com/PerryLink/advisers/issues'))
  check('TOS gives the security channel (private vulnerability reporting)', tosText.includes('私密漏洞报告') && tosText.includes('GitHub'))
  check('TOS fixes the dispute venue', tosText.includes('运营者住所地') && tosText.includes('有管辖权的人民法院'))
  check('TOS fixes the free-version liability cap', tosText.includes('人民币壹佰元') && tosText.includes('¥100'))
  check('TOS fixes a first-response deadline', tosText.includes('15 个工作日'))
  check('TOS effective date is finalized', tosEffective === FINAL_EFFECTIVE, `found ${tosEffective}, expected ${FINAL_EFFECTIVE}`)
  check('manifest effective date is finalized', effectiveFrom === FINAL_EFFECTIVE, `found ${effectiveFrom}, expected ${FINAL_EFFECTIVE}`)

  // Packaged copies must not carry relative markdown links (they are opened from lib/tos/).
  for (const [source, packaged] of packagedBySource) {
    const packagedPath = join(packageDir, packaged)
    const relativeLinks = []
    for (const match of read(packagedPath).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].trim().split(/\s+/)[0]
      if (!raw || /^(https?:|mailto:|tel:|#|data:)/i.test(raw)) continue
      relativeLinks.push(raw)
    }
    check(`packaged copy of ${source} has no relative markdown links`, relativeLinks.length === 0, [...new Set(relativeLinks)].join(', '))
  }

  // package READMEs must carry the AI/legal notice for npm users.
  const pkgEn = read(PKG_README_EN)
  const pkgZh = read(PKG_README_ZH)
  check('packages/advisers/README.md carries the AI & legal notice', pkgEn.includes('AI & legal notice'))
  check('packages/advisers/README.md links the legal docs', ['TOS', 'PRIVACY'].every((needle) => pkgEn.includes(needle)))
  check('packages/advisers/README-zh.md carries the AI & legal notice', pkgZh.includes('AI 与法律提示'))
  check('packages/advisers/README-zh.md links the legal docs', pkgZh.includes('服务条款') && pkgZh.includes('隐私'))

  // Root README first-screen notice.
  const rootEn = read('README.md')
  const rootZh = read('README-zh.md')
  check('README.md first-screen notice links TOS and PRIVACY', rootEn.includes('docs/TOS.md') && rootEn.includes('docs/PRIVACY.md'))
  check('README-zh.md first-screen notice links TOS and PRIVACY', rootZh.includes('docs/TOS.md') && rootZh.includes('docs/PRIVACY.md'))
  check('README.md states the noncommercial source-available status', /not open source/i.test(rootEn) && /PolyForm/.test(rootEn) && /commercial/i.test(rootEn))
  check('README-zh.md states the noncommercial source-available status', /不是开源/.test(rootZh) && /PolyForm/.test(rootZh) && /商业/.test(rootZh))
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------
if (warnings.length) console.log(`\n${warnings.length} warning(s):`)
for (const warning of warnings) console.log(`- ${warning}`)
if (failures.length) {
  console.error(`\n${failures.length} TOS consistency failure(s):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`\nPASS TOS consistency (${RELEASE ? 'release' : 'development'} mode, v${version}, effective ${effectiveFrom})`)
