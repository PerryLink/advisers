#!/usr/bin/env node
/**
 * TOS / legal-docs consistency gate.
 *
 * docs/TOS.md is the single canonical TOS text. packages/advisers/lib/tos/ ships a
 * packaged copy plus manifest.json (TOS version + per-file SHA-256 + effective date)
 * for the CLI consent gate to consume. This script fails when:
 *   1. the packaged copy drifts from docs/ (manifest hash mismatch or not byte-identical);
 *   2. the manifest version / effective date disagree with the docs headers;
 *   3. required legal material disappears (10 statutes + "清朗", AI labelling, minors,
 *      data, health, liability, DLC/extension points, re-confirmation, legal venue);
 *   4. README / README-zh / QUICKSTART / CONTRIBUTING lose their TOS / disclaimer /
 *      safety / template links, or any local relative markdown link is dead.
 *
 * Run: node scripts/check-tos.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(detail ? `${name} — ${detail}` : name)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}
const read = (file) => readFileSync(join(root, file), 'utf8')
const readJson = (file) => JSON.parse(read(file))
const sha256 = (file) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex')

const MANIFEST = 'packages/advisers/lib/tos/manifest.json'
const TOS = 'docs/TOS.md'
const DISCLAIMER = 'docs/DISCLAIMER.md'
const SAFETY = 'docs/SAFETY.md'
const TEMPLATE = 'templates/legal-notice-code-template.md'

// ---------------------------------------------------------------------------
// 0. Required files exist.
// ---------------------------------------------------------------------------
for (const file of [TOS, DISCLAIMER, SAFETY, TEMPLATE, MANIFEST]) {
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

const tosText = read(TOS)
const disclaimerText = read(DISCLAIMER)
const safetyText = read(SAFETY)

const tosVersion = /文档版本\s*\|\s*\*\*([0-9.]+)\*\*/.exec(tosText)?.[1]
check('docs/TOS.md header version matches manifest.version', tosVersion === version, `found ${tosVersion}, expected ${version}`)
const tosEffective = /生效日期\s*\|\s*(\d{4}-\d{2}-\d{2})/.exec(tosText)?.[1]
check('docs/TOS.md effective date matches manifest.effectiveFrom', tosEffective === effectiveFrom, `found ${tosEffective}, expected ${effectiveFrom}`)

// ---------------------------------------------------------------------------
// 2. Packaged copies are byte-identical to the canonical docs and hashes match.
// ---------------------------------------------------------------------------
const packageDir = dirname(MANIFEST)
check('manifest.files is a non-empty array', Array.isArray(manifest.files) && manifest.files.length > 0)
const packagedBySource = new Map()
for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
  const rel = typeof entry?.path === 'string' ? entry.path : ''
  const safe = rel.length > 0 && !isAbsolute(rel) && !rel.split(/[\\/]/).includes('..')
  check(`manifest files[] path is safe: ${rel || '<missing>'}`, safe)
  if (!safe) continue
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
check('manifest ships the canonical TOS text', packagedBySource.has(TOS), `no files[] entry with source ${TOS}`)
check('manifest ships the short disclaimer', packagedBySource.has(DISCLAIMER), `no files[] entry with source ${DISCLAIMER}`)

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
  '未成年人网络保护条例',
  '互联网信息服务深度合成管理规定',
  '人工智能生成合成内容标识办法',
  '人工智能拟人化互动服务管理暂行办法',
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
  'legal-review placeholders': '【需法务复核】',
  'non-OSI-licence statement': '不是 OSI 开源许可证',
  'PolyForm software licence': 'PolyForm Noncommercial 1.0.0',
  'CC BY-NC-SA docs licence': 'CC BY-NC-SA 4.0',
  'licence notice requirement': 'Required Notice',
  'version-bump on text change': '升级版本号',
}
for (const [name, needle] of Object.entries(REQUIRED_CLAUSES)) {
  check(`docs/TOS.md has ${name}`, tosText.includes(needle), `missing "${needle}"`)
}
const reviewPlaceholders = (tosText.match(/【需法务复核/g) ?? []).length
check('docs/TOS.md marks legal placeholders for review (>=3)', reviewPlaceholders >= 3, `found ${reviewPlaceholders}`)

// ---------------------------------------------------------------------------
// 4. Short disclaimer is short, current, and points to the TOS.
// ---------------------------------------------------------------------------
const disclaimerLines = disclaimerText.split(/\r?\n/).filter((line) => line.trim().length > 0)
check('docs/DISCLAIMER.md is a short notice (4-12 non-empty lines)', disclaimerLines.length >= 4 && disclaimerLines.length <= 12, `${disclaimerLines.length} non-empty lines`)
check('docs/DISCLAIMER.md names the current TOS version', disclaimerText.includes(`v${version}`), `missing v${version}`)
for (const [name, needle] of Object.entries({
  'AI fallibility': 'AI 输出可能错误',
  'prohibited use': '禁止使用',
  'minors': '未成年人',
  'TTS / labelling': '标识',
  'liability limit': '责任',
  'not a compliance certification': '不构成合规认证',
})) {
  check(`docs/DISCLAIMER.md has ${name}`, disclaimerText.includes(needle), `missing "${needle}"`)
}

// ---------------------------------------------------------------------------
// 5. SAFETY.md uses the honest framing.
// ---------------------------------------------------------------------------
check('docs/SAFETY.md names the current TOS version', safetyText.includes(version))
check('docs/SAFETY.md marks the mechanism as auxiliary', safetyText.includes('辅助机制'))
check('docs/SAFETY.md denies being a compliance certification', /不构成[^。\n]*合规认证/.test(safetyText))
check('docs/SAFETY.md states the user remains responsible', /第一责任人|自行承担/.test(safetyText))
check('docs/SAFETY.md carries legal-review placeholders', safetyText.includes('【需法务复核】'))

// ---------------------------------------------------------------------------
// 6. README / QUICKSTART / CONTRIBUTING must link the legal docs.
// ---------------------------------------------------------------------------
const LINK_FILES = ['README.md', 'README-zh.md', 'docs/QUICKSTART.md', 'CONTRIBUTING.md', TOS, DISCLAIMER, SAFETY, TEMPLATE]
const REQUIRED_LINKS = {
  'README.md': [TOS, DISCLAIMER, SAFETY],
  'README-zh.md': [TOS, DISCLAIMER, SAFETY],
  'docs/QUICKSTART.md': [TOS, DISCLAIMER, SAFETY],
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
    const absolute = resolve(baseDir, target)
    targets.add(absolute)
    if (!existsSync(absolute)) {
      check(`${file} local link target exists: ${raw}`, false, absolute)
    }
  }
  return targets
}

for (const [file, required] of Object.entries(REQUIRED_LINKS)) {
  const targets = linkTargets(file)
  for (const requiredTarget of required) {
    const absolute = resolve(root, requiredTarget)
    check(`${file} links ${requiredTarget}`, targets.has(absolute))
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

// ---------------------------------------------------------------------------
// 7. Template names the current TOS version and the extension-point contract.
// ---------------------------------------------------------------------------
const templateText = read(TEMPLATE)
check('templates/legal-notice-code-template.md names the current TOS version', templateText.includes(`v${version}`))
check('templates/legal-notice-code-template.md carries the legal-notice marker', templateText.includes('ADVISERS-LEGAL-NOTICE v1'))
check('templates/legal-notice-code-template.md forbids bypassing safety/audit/labels', /不得移除或绕过内容安全审核/.test(templateText))

if (failures.length) {
  console.error(`\n${failures.length} TOS consistency failure(s):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`\nPASS TOS consistency (v${version}, effective ${effectiveFrom})`)
