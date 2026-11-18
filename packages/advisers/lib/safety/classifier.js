/**
 * Local content-safety classifier.
 *
 * Pure function over text: no network, no filesystem, no third-party deps.
 * It normalizes (NFKC / zero-width / traditional-to-simplified / whitespace),
 * runs the 14-category rule matrix from rules.js, applies the narrow block
 * allowlist and surface/context downgrades, and returns a structured decision
 * that NEVER contains the original text.
 *
 * Result shape:
 *   {
 *     action: 'allow' | 'warn' | 'confirm' | 'redact' | 'block',
 *     categories: string[],          // category ids, highest priority first
 *     ruleIds: string[],             // stable rule ids, highest priority first
 *     confidence: number,            // 0..1 (0 for allow)
 *     evidenceHash: string | null,   // HMAC-SHA256(key, hit snippets)[0..16]
 *     code: string,                  // stable audit code, 'NONE' for allow
 *     rulesetVersion: string,
 *     rulesetDigest: string,
 *     surface: string,
 *     severity: 'none' | 'low' | 'medium' | 'high' | 'critical',
 *     crisis: boolean,               // self-harm: show crisis hint, never block
 *     downgraded: boolean,
 *     truncated: boolean,            // true when only the first maxChars were scanned
 *     injection?: {                   // additive prompt-injection view (warn only)
 *       detected, highConfidence, severity, code, reason, subtype, confidence,
 *       ruleIds, action, surface
 *     }
 *     hits: [{ ruleId, category, subtype, code, severity, action, confidence,
 *              hardBlock, crisis, downgraded }]
 *   }
 *
 * Truncation fails CLOSED (content-safety audit SEC2-02, 2026-11-17): when the
 * input is longer than maxChars the tail is unscannable, so a benign-looking
 * prefix is never returned as 'allow'. Egress surfaces (text that can leave the
 * machine, see SURFACES) return 'block' with code INPUT_TRUNCATED; local-file
 * surfaces return 'confirm' and let the caller decide. The escalation only ever
 * raises the action of an existing decision.
 *
 * The caller owns the audit key: pass { hmacKey } to get an evidenceHash.
 * Without a key evidenceHash is null (never a plaintext or unkeyed fallback).
 */

import { createHmac } from 'node:crypto'
import { DEFAULT_RULESET, INJECTION_HIGH_CONFIDENCE, INJECTION_REASONS, actionRank, resolveRuleset } from './rules.js'
import { detectPiiInternal } from './redact.js'

export const DEFAULT_SURFACE = 'chat.input'
export const MAX_SCAN_CHARS = 100_000
export const MAX_EVIDENCE_SNIPPETS = 20
export const MAX_EVIDENCE_SNIPPET_CHARS = 64

/** Surface policy table. localFile surfaces downgrade non-CSAM blocks. */
export const SURFACES = Object.freeze({
  'safety.check': { egress: true, localFile: false },
  'chat.input': { egress: true, localFile: false },
  'chat.output': { egress: true, localFile: false },
  'agent.input': { egress: true, localFile: false },
  'agent.output': { egress: true, localFile: false },
  'model.output': { egress: true, localFile: false },
  'research.query': { egress: true, localFile: false },
  'research.output': { egress: true, localFile: false },
  'capture.input': { egress: false, localFile: true },
  'attachments.text': { egress: false, localFile: true },
  'doc-review.text': { egress: false, localFile: true },
  'office.spec': { egress: false, localFile: true },
  'office.output': { egress: true, localFile: false },
  deliverable: { egress: true, localFile: false },
  'pet-brief': { egress: true, localFile: false },
  'mcp.tool': { egress: true, localFile: false },
  'dsh.tool': { egress: true, localFile: false },
  unknown: { egress: true, localFile: false },
})

const SURFACE_ALIASES = Object.freeze({
  chat: 'chat.input',
  agent: 'agent.input',
  capture: 'capture.input',
  attachments: 'attachments.text',
  attachment: 'attachments.text',
  docreview: 'doc-review.text',
  review: 'doc-review.text',
  office: 'office.spec',
  research: 'research.query',
  pet: 'pet-brief',
  mcp: 'mcp.tool',
  dsh: 'dsh.tool',
  safety: 'safety.check',
})

/** Normalize a surface name; unknown names fail closed to the generic surface. */
export function normalizeSurface(surface) {
  if (surface == null || surface === '') return DEFAULT_SURFACE
  const raw = String(surface).trim().toLowerCase()
  const key = SURFACE_ALIASES[raw] || raw
  return SURFACES[key] ? key : 'unknown'
}

/** Policy for a normalized surface (local files are reviewed, not hard-blocked). */
export function surfacePolicy(surface) {
  const key = normalizeSurface(surface)
  return SURFACES[key] || SURFACES.unknown
}

// ---------------------------------------------------------------------------
// normalization: NFKC, zero-width, traditional -> simplified, whitespace
// ---------------------------------------------------------------------------

const ZERO_WIDTH_RE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFE00-\uFE0F\uFEFF\u{E0100}-\u{E01EF}]/gu

// Only characters needed by the rule matrix. This is normalization for
// MATCHING only; the original text is never rewritten for the caller.
const TRAD_TO_SIMP = Object.freeze({
  '兒': '儿', '槍': '枪', '彈': '弹', '藥': '药', '殺': '杀', '竊': '窃',
  '騙': '骗', '賭': '赌', '錢': '钱', '貸': '贷', '證': '证', '駕': '驾',
  '齡': '龄', '賣': '卖', '買': '买', '傷': '伤', '襲': '袭', '擊': '击',
  '軍': '军', '獨': '独', '國': '国', '愛': '爱', '亂': '乱', '華': '华',
  '極': '极', '網': '网', '絡': '络', '組': '组', '織': '织', '揚': '扬',
  '動': '动', '顛': '颠', '製': '制', '販': '贩', '穢': '秽', '強': '强',
  '姦': '奸', '褻': '亵', '視': '视', '殘': '残', '廢': '废', '碼': '码',
  '鑰': '钥', '賬': '账', '帳': '账', '戶': '户', '轉': '转', '詐': '诈',
  '單': '单', '發': '发', '個': '个', '訊': '讯', '錄': '录', '惡': '恶',
  '馬': '马', '驟': '骤', '換': '换', '臉': '脸', '擬': '拟', '聲': '声',
  '偽': '伪', '學': '学', '約': '约', '見': '见', '戀': '恋', '無': '无',
  '統': '统', '開': '开', '戲': '戏', '誘': '诱', '脅': '胁', '嚇': '吓',
  '搶': '抢', '綁': '绑', '撥': '拨', '號': '号', '兇': '凶', '屍': '尸',
  '體': '体', '腦': '脑', '炰': '炮', '菸': '烟', '紋': '纹', '輟': '辍',
  '複': '复', '鍊': '炼', '燒': '烧', '慫': '怂', '慾': '欲', '蕩': '荡',
  '艷': '艳', '親': '亲', '權': '权', '員': '员', '會': '会', '區': '区',
  '縣': '县', '鄉': '乡', '鎮': '镇', '門': '门', '車': '车', '團': '团',
  '夥': '伙', '僱': '雇', '傭': '佣',
})

const HAN_RE = /[\u4e00-\u9fff]/g

function toSimplified(text) {
  return text.replace(HAN_RE, (char) => TRAD_TO_SIMP[char] || char)
}

/**
 * Whitespace/punctuation insensitive view for CJK combo rules. Removing
 * separators defeats "制 作 炸 弹" / "制作，炸弹" style evasions.
 */
const COMPACT_STRIP_RE = /[\s\u3000\u00A0，。、；：！？…—～·“”‘’「」『』（）()《》〈〉【】〔〕\[\]{}<>,.!?;:'"`~!@#$%^&*_+=|\\/\-]/gu

/**
 * Normalize without changing semantics: NFKC (full/half width), zero-width
 * removal, traditional -> simplified for matching, lowercase, collapsed spaces.
 */
export function normalizeText(input) {
  const original = String(input == null ? '' : input)
  const base = original.normalize('NFKC').replace(ZERO_WIDTH_RE, '')
  const normalized = toSimplified(base).toLowerCase().replace(/\s+/gu, ' ').trim()
  const compact = normalized.replace(COMPACT_STRIP_RE, '')
  return { original, normalized, compact }
}

/** Negation window check, compact view only (e.g. "禁止传播儿童裸照"). */
function isNegated(compactText, index) {
  const window = compactText.slice(Math.max(0, index - 6), index)
  return /(不要|不得|严禁|禁止|防止|避免|警惕|防范|预防|拒绝|切勿|勿|反对|反诈|反家暴|反暴力|打击|查处|严惩)$/u.test(window)
}

// ---------------------------------------------------------------------------
// policy heuristics
// ---------------------------------------------------------------------------

// Quoted/legal/news/academic contexts downgrade a non-hard block one step.
const CONTEXT_MARKERS = /(普法|法律|刑法|民法典|法规|法条|条文|判刑|判决|案例|新闻|报道|通报|公告|依据|根据|引用|学术|论文|研究|教学|教材|课堂|培训|防范|预防|应对|自救|求助|支持|志愿者|干预|保护|反诈|维权|举报|打击|查处|严惩|治理|宣传|警示|警示教育|安全研究|渗透测试|授权|应急响应|样本分析|加固|修复|漏洞|通知|声明)/u
// First-person solicitation cancels the context downgrade (anti-bypass).
const HARD_SOLICIT = /(教我|告诉我|指导我|帮我|给我|我要|我想|我需要|求|请给|麻烦给)/u

function hasContextDowngrade(views) {
  return CONTEXT_MARKERS.test(views.compact) && !HARD_SOLICIT.test(views.compact)
}

function rankOf(action) {
  return actionRank(action)
}

function hmacEvidence(snippets, hmacKey) {
  if (!hmacKey || (typeof hmacKey !== 'string' && !Buffer.isBuffer(hmacKey) && !(hmacKey instanceof Uint8Array))) {
    return null
  }
  const unique = [...new Set(snippets)].slice(0, MAX_EVIDENCE_SNIPPETS)
  if (!unique.length) return null
  const material = unique.map((snippet) => String(snippet).slice(0, MAX_EVIDENCE_SNIPPET_CHARS)).sort().join('\u0000')
  try {
    return createHmac('sha256', hmacKey).update(material, 'utf8').digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// core scan
// ---------------------------------------------------------------------------

function scanRule(rule, views) {
  for (const view of rule.views) {
    const text = view === 'normalized' ? views.normalized : views.compact
    if (!text) continue
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text)
      if (!match) continue
      if (rule.negationSensitive && view === 'compact' && isNegated(text, match.index)) continue
      return { view, snippet: match[0] }
    }
  }
  return null
}

function buildHit(rule, snippet, actionOverride) {
  return {
    ruleId: rule.id,
    category: rule.category,
    subtype: rule.subtype,
    code: rule.code,
    severity: rule.severity,
    action: actionOverride || rule.action,
    confidence: rule.confidence,
    hardBlock: Boolean(rule.hardBlock),
    crisis: Boolean(rule.crisis),
    blockable: Boolean(rule.blockable),
    downgraded: null,
    snippet: snippet || rule.id,
    reason: rule.category === 'injection' ? (INJECTION_REASONS[rule.subtype] || INJECTION_REASONS.default) : null,
  }
}

const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 }

function allowResult(views, surface, ruleset, truncated) {
  return {
    action: 'allow',
    categories: [],
    ruleIds: [],
    confidence: 0,
    evidenceHash: null,
    code: 'NONE',
    rulesetVersion: ruleset.version,
    rulesetDigest: ruleset.digest,
    surface,
    severity: 'none',
    crisis: false,
    downgraded: false,
    truncated,
    hits: [],
  }
}

/** The stable fail-closed decision for a truncated payload on an egress surface. */
function truncationBlockResult(surface, ruleset) {
  return {
    action: 'block',
    categories: [],
    ruleIds: [],
    confidence: 0.5,
    evidenceHash: null,
    code: 'INPUT_TRUNCATED',
    rulesetVersion: ruleset.version,
    rulesetDigest: ruleset.digest,
    surface,
    severity: 'medium',
    crisis: false,
    downgraded: false,
    truncated: true,
    hits: [],
  }
}

/**
 * Fail closed when the text was truncated: the unscanned tail could contain a
 * hard-block rule hit, so the prefix result cannot be trusted as 'allow'.
 * Egress surfaces refuse the payload outright (and skip the expensive prefix
 * scan: the verdict does not depend on it); local-file surfaces keep scanning
 * so a hard block in the scanned prefix still wins, then ask for confirmation.
 * Escalation only raises an action, never lowers one.
 */
function applyTruncationFailClosed(result, policy) {
  if (!result.truncated) return result
  const floor = policy.egress ? 'block' : 'confirm'
  if (rankOf(result.action) >= rankOf(floor)) return result
  return {
    ...result,
    action: floor,
    code: 'INPUT_TRUNCATED',
    severity: result.severity === 'none' ? 'medium' : result.severity,
    confidence: Math.max(result.confidence, 0.5),
  }
}

function runClassify(ruleset, text, options = {}) {
  const surface = normalizeSurface(options.surface)
  const policy = SURFACES[surface] || SURFACES.unknown
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : MAX_SCAN_CHARS
  const raw = String(text == null ? '' : text)
  const truncated = raw.length > maxChars
  // Egress + truncation can only end in block, so settle it before the rule
  // scan (deterministic and bounded even for a multi-megabyte paste).
  if (truncated && policy.egress) return truncationBlockResult(surface, ruleset)
  const views = normalizeText(truncated ? raw.slice(0, maxChars) : raw)
  if (!views.compact) return applyTruncationFailClosed(allowResult(views, surface, ruleset, truncated), policy)

  const contextDowngrade = hasContextDowngrade(views)
  const hits = []
  const piiHits = detectPiiInternal(views.original, { ruleset })

  for (const rule of ruleset.rules) {
    if (rule.detector === 'pii') {
      const first = piiHits.filter((hit) => hit.ruleId === rule.id)
      if (!first.length) continue
      const hit = buildHit(rule, first.map((item) => item.raw).join(' '))
      hit.pii = true
      hits.push(hit)
      continue
    }
    if (rule.detector === 'pii-bulk') {
      const enough = piiHits.length >= (rule.minPiiHits || 6)
      const exfil = rule.exfilPattern ? rule.exfilPattern.exec(views.compact) : null
      const quantity = rule.quantityPattern ? rule.quantityPattern.exec(views.compact) : null
      if (!enough || !exfil || !quantity) continue
      hits.push(buildHit(rule, exfil[0] + quantity[0]))
      continue
    }
    const found = scanRule(rule, views)
    if (!found) continue
    hits.push(buildHit(rule, found.snippet))
  }

  // Block is narrow: only explicit block rules can block; the CSAM hard block
  // is never downgraded. Everything else may be softened by context/surface.
  for (const hit of hits) {
    if (hit.action !== 'block' || hit.hardBlock) continue
    if (contextDowngrade) {
      hit.action = 'confirm'
      hit.downgraded = 'context'
    }
    if (policy.localFile && hit.action === 'block') {
      hit.action = 'confirm'
      hit.downgraded = 'surface'
    } else if (policy.localFile && hit.action === 'confirm') {
      hit.action = 'warn'
      hit.downgraded = 'surface'
    }
  }

  const crisis = hits.some((hit) => hit.crisis)
  if (crisis) {
    for (const hit of hits) {
      if (hit.crisis && rankOf(hit.action) < rankOf('warn')) hit.action = 'warn'
    }
  }

  // Deterministic ordering: action rank desc, then ruleset order (id sorted).
  // Array.prototype.sort is stable, so equal-rank hits keep ruleset order.
  const ordered = [...hits].sort((a, b) => rankOf(b.action) - rankOf(a.action))
  const categories = [...new Set(ordered.map((hit) => hit.category))]
  const ruleIds = [...new Set(ordered.map((hit) => hit.ruleId))]
  const action = ordered.length ? ordered[0].action : 'allow'
  const primary = ordered[0]
  const baseConfidence = ordered.length
    ? Math.min(0.99, Math.max(...ordered.map((hit) => hit.confidence)) + 0.02 * Math.max(0, categories.length - 1))
    : 0
  const evidenceHash = hmacEvidence(ordered.map((hit) => hit.snippet), options.hmacKey)

  const result = {
    action,
    categories,
    ruleIds,
    confidence: Math.round(baseConfidence * 100) / 100,
    evidenceHash,
    code: ordered.length ? ordered[0].code : 'NONE',
    rulesetVersion: ruleset.version,
    rulesetDigest: ruleset.digest,
    surface,
    severity: ordered.length ? ordered[0].severity : 'none',
    crisis,
    downgraded: ordered.some((hit) => Boolean(hit.downgraded)),
    truncated,
    hits: ordered.map((hit) => ({
      ruleId: hit.ruleId,
      category: hit.category,
      subtype: hit.subtype,
      code: hit.code,
      severity: hit.severity,
      action: hit.action,
      confidence: hit.confidence,
      hardBlock: hit.hardBlock,
      crisis: hit.crisis,
      downgraded: hit.downgraded,
      ...(hit.reason ? { reason: hit.reason } : {}),
    })),
  }
  const final = applyTruncationFailClosed(result, policy)
  const injectionHits = ordered.filter((hit) => hit.category === 'injection')
  if (injectionHits.length) {
    const maxConfidence = Math.max(...injectionHits.map((hit) => hit.confidence))
    const primary = injectionHits[0]
    final.injection = {
      detected: true,
      highConfidence: maxConfidence >= INJECTION_HIGH_CONFIDENCE,
      severity: primary.severity,
      code: primary.code,
      reason: primary.reason || INJECTION_REASONS.default,
      subtype: primary.subtype,
      confidence: Math.round(maxConfidence * 100) / 100,
      ruleIds: [...new Set(injectionHits.map((hit) => hit.ruleId))],
      action: final.action,
      surface,
    }
  }
  return final
}

/**
 * Classify text locally. Never throws on caller text; invalid options degrade
 * safely (no hmacKey means no evidenceHash; unknown surface means generic).
 */
export function classify(text, options = {}) {
  let ruleset = DEFAULT_RULESET
  if (options.ruleset) {
    try {
      ruleset = options.ruleset.__compiled ? options.ruleset : resolveRuleset(options.ruleset)
    } catch {
      ruleset = DEFAULT_RULESET
    }
  }
  try {
    return runClassify(ruleset, text, options)
  } catch {
    // Fail closed on an internal bug: never let ordinary text slip past as allow.
    return {
      action: 'confirm',
      categories: [],
      ruleIds: [],
      confidence: 0.5,
      evidenceHash: null,
      code: 'SAFETY_INTERNAL_ERROR',
      rulesetVersion: ruleset.version,
      rulesetDigest: ruleset.digest,
      surface: normalizeSurface(options.surface),
      severity: 'medium',
      crisis: false,
      downgraded: false,
      truncated: false,
      hits: [],
    }
  }
}

/**
 * Structured injection view of any classify() result (allow results included).
 * The rule action stays warn; this view is what policy callers (lib/agent.js)
 * use to block/confirm a model call that would carry untrusted instructions.
 * It never contains the matched text.
 */
export function injectionAssessment(result) {
  const injection = result && result.injection && result.injection.detected ? result.injection : null
  return {
    detected: Boolean(injection),
    highConfidence: Boolean(injection && injection.highConfidence),
    severity: injection ? injection.severity : 'none',
    code: injection ? injection.code : 'NONE',
    reason: injection ? injection.reason : null,
    subtype: injection ? injection.subtype : null,
    confidence: injection ? injection.confidence : 0,
    ruleIds: injection && Array.isArray(injection.ruleIds) ? [...injection.ruleIds] : [],
    action: result ? result.action : 'allow',
    surface: result ? result.surface : 'unknown',
    truncated: Boolean(result && result.truncated),
  }
}

/** classify() + injectionAssessment() in one call. */
export function inspectInjection(text, options = {}) {
  return injectionAssessment(classify(text, options))
}

export { INJECTION_HIGH_CONFIDENCE }
/** Bind a ruleset (and default options such as hmacKey) to a classify function. */
export function createClassifier(config = {}) {
  let ruleset = DEFAULT_RULESET
  if (config.ruleset != null) ruleset = resolveRuleset(config.ruleset)
  const defaults = {
    surface: config.surface,
    hmacKey: config.hmacKey,
    maxChars: config.maxChars,
  }
  return (text, options = {}) => {
    const merged = { ...defaults, ...options, ruleset }
    return runClassify(ruleset, text, merged)
  }
}

// Kept for tests and for callers that want the severity ordering.
export const SEVERITY_RANK = Object.freeze(SEVERITY_ORDER)
