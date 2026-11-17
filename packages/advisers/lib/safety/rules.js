/**
 * Content-safety rule matrix (local, offline, zero-dependency).
 *
 * This module is DATA + a tiny compiler. It contains the 14-category violation
 * matrix used by `lib/safety/classifier.js`, the narrow block allowlist, and a
 * deterministic ruleset digest for audit reasons.
 *
 * Design constraints (see docs/CONTENT-SAFETY.md):
 * - block is intentionally narrow: only child sexual exploitation, terrorism
 *   operations, direct illegal instruction, weaponized malware, and bulk
 *   personal-data exfiltration may produce `action: 'block'`.
 * - self-harm is never blocked; it maps to a crisis hint (`action: 'warn'`).
 * - ordinary office text must stay `allow` (zero disturbance).
 * - the rule set is overridable with a JSON object, but a JSON override can
 *   never widen the block surface and can never disable the child-safety
 *   hard-block rules.
 * - no network, no third-party dependencies; only node:crypto for digests.
 */

import { createHash } from 'node:crypto'

export const RULESET_VERSION = 'advisers-content-1'

/** Actions a rule/result may carry. `allow` is only ever a classifier result. */
export const ACTIONS = Object.freeze(['allow', 'warn', 'confirm', 'redact', 'block'])
export const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical'])

/**
 * Categories that are allowed to carry a block rule at all. Inside these
 * categories only rules explicitly marked `blockable` may block.
 */
export const BLOCK_CATEGORIES = Object.freeze(['sexual', 'terrorism', 'illegal', 'malware', 'pii'])

/**
 * The 14-category matrix. Legal references are pointers for reviewers, not a
 * compliance claim; see docs/CONTENT-SAFETY.md for the honest scope statement.
 */
export const CATEGORIES = Object.freeze([
  {
    id: 'political',
    labelZh: '危害国家安全类',
    labelEn: 'state security',
    basis: '《网络信息内容生态治理规定》6(一)(二)(三)；《生成式人工智能服务管理暂行办法》4(一)',
    defaultAction: 'confirm',
    blockScope: '不 block（窄口径外）；仅 confirm/warn',
  },
  {
    id: 'terrorism',
    labelZh: '恐怖主义与极端主义',
    labelEn: 'terrorism and extremism',
    basis: '《网络信息内容生态治理规定》6(五)；《生成式人工智能服务管理暂行办法》4(一)',
    defaultAction: 'block',
    blockScope: '仅操作指引/袭击实施类 block 规则',
  },
  {
    id: 'hate',
    labelZh: '仇恨与歧视',
    labelEn: 'hate and discrimination',
    basis: '《网络信息内容生态治理规定》6(六)(七)；《生成式人工智能服务管理暂行办法》4(二)',
    defaultAction: 'confirm',
    blockScope: '不 block；明确煽动走 confirm',
  },
  {
    id: 'sexual',
    labelZh: '淫秽色情（含儿童性剥削）',
    labelEn: 'sexual content (incl. child sexual exploitation)',
    basis: '《网络信息内容生态治理规定》6(九)；《未成年人网络保护条例》',
    defaultAction: 'warn',
    blockScope: '仅 CSAM 硬拦规则 block；成人色情 warn/confirm',
  },
  {
    id: 'violence',
    labelZh: '暴力与凶杀',
    labelEn: 'violence',
    basis: '《网络信息内容生态治理规定》6(五)(九)',
    defaultAction: 'warn',
    blockScope: '不 block；直接暴力教唆走 illegal 类别',
  },
  {
    id: 'selfharm',
    labelZh: '自伤与自杀（危机响应）',
    labelEn: 'self-harm (crisis response)',
    basis: '《网络信息内容生态治理规定》6(五)；危机干预优先于阻断',
    defaultAction: 'warn',
    blockScope: '永不 block；只触发 crisis 提示',
  },
  {
    id: 'minors',
    labelZh: '未成年人保护',
    labelEn: 'minor protection',
    basis: '《未成年人网络保护条例》',
    defaultAction: 'confirm',
    blockScope: '不 block；收紧其它类别（无年龄核验）',
  },
  {
    id: 'pii',
    labelZh: '个人信息与隐私',
    labelEn: 'personal data and privacy',
    basis: '《个人信息保护法》；《网络信息内容生态治理规定》6(十)',
    defaultAction: 'redact',
    blockScope: '仅批量外泄规则 block；单条 PII 一律 redact',
  },
  {
    id: 'deepfake',
    labelZh: '深度合成与冒充',
    labelEn: 'deep synthesis and impersonation',
    basis: '《互联网信息服务深度合成管理规定》；《人工智能生成合成内容标识办法》',
    defaultAction: 'confirm',
    blockScope: '不 block；confirm + 标识提示',
  },
  {
    id: 'fraud',
    labelZh: '欺诈与商业违法',
    labelEn: 'fraud and commercial illegality',
    basis: '《网络信息内容生态治理规定》6(九)；《广告法》',
    defaultAction: 'warn',
    blockScope: '不 block；明确诈骗话术 confirm',
  },
  {
    id: 'malware',
    labelZh: '恶意代码与网络攻击',
    labelEn: 'malware and cyberattack',
    basis: '《网络安全法》；《刑法》第285/286条',
    defaultAction: 'confirm',
    blockScope: '仅武器化载荷 block；双用途安全研究 confirm/warn',
  },
  {
    id: 'illegal',
    labelZh: '违法犯罪教唆',
    labelEn: 'illegal instruction',
    basis: '《网络信息内容生态治理规定》6(九)；《刑法》相关条款',
    defaultAction: 'confirm',
    blockScope: '仅直接教唆/操作指引 block',
  },
  {
    id: 'harassment',
    labelZh: '侮辱诽谤与网络暴力',
    labelEn: 'harassment and cyberbullying',
    basis: '《网络信息内容生态治理规定》6(十)；《网络暴力信息治理规定》',
    defaultAction: 'warn',
    blockScope: '不 block；confirm/warn 并保留证据',
  },
  {
    id: 'injection',
    labelZh: '提示注入与越权指令',
    labelEn: 'prompt injection',
    basis: '工程安全风险（非法规类别）',
    defaultAction: 'warn',
    blockScope: '不 block；warn 并加固系统提示',
  },
])

export const CATEGORY_IDS = Object.freeze(CATEGORIES.map((category) => category.id))

export const CATEGORY_BY_ID = Object.freeze(
  CATEGORIES.reduce((map, category) => {
    map[category.id] = category
    return map
  }, {}),
)

/** Category-level replacement tokens for redaction; safe to print. */
export const PII_KINDS = Object.freeze({
  PHONE: '手机号',
  ID_CARD: '身份证号',
  BANK_CARD: '银行卡号',
  EMAIL: '邮箱',
  SECRET: '密钥/凭据',
  ADDRESS: '详细住址',
})

const ACTION_RANK = Object.freeze({ allow: 0, redact: 1, warn: 2, confirm: 3, block: 4 })

export function actionRank(action) {
  return ACTION_RANK[action] ?? 0
}

// ---------------------------------------------------------------------------
// rule construction helpers
// ---------------------------------------------------------------------------

function asPattern(input) {
  if (input instanceof RegExp) return input
  if (typeof input === 'string') return new RegExp(input, 'u')
  throw new TypeError('rule pattern must be a RegExp or a string')
}

function asPatternSafe(input, ruleId) {
  try {
    return asPattern(input)
  } catch (error) {
    throw new TypeError('rule ' + ruleId + ': invalid pattern: ' + error.message)
  }
}

function toPatternSource(pattern) {
  const flags = (pattern.flags || '').replace(/[gy]/g, '')
  return { source: pattern.source, flags }
}

/**
 * Build a regex rule. `patterns` are RegExp literals (or JSON strings); a hit
 * occurs when any pattern matches the rule's selected view(s).
 */
function R(id, category, subtype, code, severity, action, confidence, patterns, extra = {}) {
  return {
    id,
    category,
    subtype,
    code,
    severity,
    action,
    confidence,
    blockable: action === 'block',
    hardBlock: false,
    negationSensitive: true,
    views: ['compact'],
    detector: null,
    piiKind: null,
    group: null,
    patterns: (patterns || []).map(asPattern),
    ...extra,
  }
}

/** Build a PII detection rule (consumed by redact.js, not by regex scanning). */
function PII(id, piiKind, pattern, extra = {}) {
  return R(id, 'pii', 'personal_data', 'PII', 'medium', 'redact', 0.92, [pattern], {
    detector: 'pii',
    piiKind,
    views: ['original'],
    negationSensitive: false,
    ...extra,
  })
}

// ---------------------------------------------------------------------------
// built-in rules
// ---------------------------------------------------------------------------

const BUILTIN_RULES = [
  // -- political security ---------------------------------------------------
  R('R-POL-01', 'political', 'subversion', 'POLITICAL', 'high', 'confirm', 0.72, [
    /(颠覆|推翻).{0,8}(国家政权|政府|党的领导|社会主义制度)/u,
    /(煽动|组织).{0,6}(颠覆|政变)/u,
  ]),
  R('R-POL-02', 'political', 'separatism', 'POLITICAL', 'high', 'confirm', 0.7, [
    /(分裂|独立).{0,4}(国家|中国|西藏|新疆|台湾|香港)/u,
    /(西藏|新疆|台湾|香港).{0,4}(独立|建国)/u,
  ]),
  R('R-POL-03', 'political', 'national_symbols', 'POLITICAL', 'high', 'confirm', 0.72, [
    /(侮辱|焚烧|践踏|毁坏).{0,4}(国旗|国徽|国家领导人)/u,
  ]),
  R('R-POL-04', 'political', 'cult', 'POLITICAL', 'medium', 'confirm', 0.66, [
    /(法轮功|全能神|门徒会|邪教).{0,10}(宣传|传播|练习|加入|发展|组织)/u,
  ]),

  // -- terrorism ------------------------------------------------------------
  R('R-TERROR-OPS-01', 'terrorism', 'explosives_instruction', 'TERRORISM_OPERATIONS', 'critical', 'block', 0.97, [
    /(教我|告诉我|指导|如何|怎么|怎样|教程|步骤|配方|比例|方法|指南).{0,12}(制作|制造|自制|组装|合成|配置).{0,8}(炸弹|爆炸物|雷管|燃烧瓶|土制手雷|爆炸装置)/u,
    /(炸弹|爆炸物|雷管|燃烧瓶).{0,8}(配方|制作步骤|制作方法|教程|比例)/u,
  ]),
  R('R-TERROR-OPS-02', 'terrorism', 'attack_instruction', 'TERRORISM_OPERATIONS', 'critical', 'block', 0.97, [
    /(如何|怎么|怎样|教我|指导|步骤|教程).{0,10}(实施|发动|策划|执行).{0,6}(恐怖袭击|恐怖攻击|恐袭|爆炸袭击|劫机|枪击)/u,
  ]),
  R('R-TERROR-OPS-03', 'terrorism', 'recruitment_operations', 'TERRORISM_OPERATIONS', 'critical', 'block', 0.95, [
    /(恐怖分子|恐怖组织|极端组织|圣战组织).{0,10}(如何|教程|培训|招募|训练).{0,8}(爆炸|武器|袭击|作战)/u,
    /(加入|效忠|宣誓).{0,6}(恐怖组织|极端组织|圣战组织)/u,
  ]),
  R('R-TERROR-01', 'terrorism', 'praise', 'TERRORISM', 'high', 'confirm', 0.8, [
    /(恐怖袭击|恐怖主义|极端组织|圣战组织|恐怖分子).{0,10}(赞扬|支持|美化|崇拜|加入|招募|宣传)/u,
  ]),
  R('R-TERROR-02', 'terrorism', 'threat_intent', 'TERRORISM_OPERATIONS', 'critical', 'block', 0.96, [
    /(我要|我想|我准备|我打算|计划|准备).{0,8}(发动|实施|制造|进行).{0,6}(恐怖袭击|爆炸袭击|劫机|枪击|爆炸)/u,
    /(明天|今晚|今天).{0,8}(炸掉|袭击|血洗).{0,6}(地铁|机场|学校|商场|政府)/u,
  ]),

  // -- hate and discrimination ---------------------------------------------
  R('R-HATE-01', 'hate', 'dehumanizing', 'HATE', 'high', 'warn', 0.78, [
    /(劣等|低等|低贱|垃圾|寄生虫|蛀虫).{0,4}(民族|种族|人种|外来人口|黑人|穆斯林|残疾人|同性恋)/u,
    /(民族|种族|人种|黑人|穆斯林|残疾人|同性恋).{0,4}(劣等|低等|低贱|垃圾|寄生虫|蛀虫)/u,
  ]),
  R('R-HATE-02', 'hate', 'incitement', 'HATE', 'critical', 'confirm', 0.88, [
    /(杀光|灭绝|清洗|驱赶|驱逐|消灭).{0,6}(少数民族|维吾尔|藏族|回族|黑人|犹太人|穆斯林|同性恋|残疾人)/u,
    /(少数民族|维吾尔|藏族|回族|黑人|犹太人|穆斯林|同性恋|残疾人).{0,6}(杀光|灭绝|清洗|驱赶|驱逐|消灭)/u,
  ]),
  R('R-HATE-03', 'hate', 'slurs', 'HATE', 'high', 'warn', 0.8, [
    /(支那|黑鬼|阿三|白皮猪|绿畜|穆畜|基佬|死同性恋)/u,
  ]),
  R('R-HATE-04', 'hate', 'discrimination', 'HATE', 'medium', 'warn', 0.7, [
    /(禁止|不允许|拒绝).{0,6}(某民族|某宗教|少数民族|残疾人|外地人).{0,6}(进入|入内|入住|入学|就职)/u,
  ]),

  // -- sexual content (adult = warn/confirm; CSAM = narrow hard block) ------
  R('R-SEX-01', 'sexual', 'adult_services', 'ADULT_SEXUAL', 'medium', 'warn', 0.75, [
    /(色情网站|黄色网站|成人视频|看片|a片|av视频|裸聊|约炮|嫖娼|卖淫|性服务|特殊服务|招嫖|一夜情)/u,
  ]),
  R('R-SEX-02', 'sexual', 'explicit_acts', 'ADULT_SEXUAL', 'medium', 'warn', 0.72, [
    /(做爱|性交|口交|肛交|自慰|手淫|淫秽)/u,
  ]),
  R('R-SEX-03', 'sexual', 'porn_generation', 'ADULT_SEXUAL', 'medium', 'warn', 0.74, [
    /(生成|写|描述|创作).{0,6}(色情|淫秽|露骨|情色).{0,6}(小说|故事|内容|情节|描写|视频)/u,
  ]),
  R('R-SEX-04', 'sexual', 'non_consensual', 'ADULT_SEXUAL', 'high', 'confirm', 0.82, [
    /(偷拍|迷奸|下药|强奸|性侵).{0,8}(视频|照片|女性|女生|同事|同学|朋友)/u,
    /(传播|出售|分享).{0,6}(偷拍|私密|不雅).{0,4}(视频|照片)/u,
  ]),
  R('R-SEX-05', 'sexual', 'minor_sexualization', 'SEXUAL_MINOR', 'high', 'confirm', 0.85, [
    /(未成年|小学生|初中生|高中生).{0,8}(性感|诱惑|情趣|成人内容|色情)/u,
  ]),
  R('R-SEX-CSAM-01', 'sexual', 'csam', 'CSAM', 'critical', 'block', 0.98, [
    /(儿童|幼女|幼童|未成年|小学生|中学生|初中生|高中生|孩子).{0,10}(裸照|裸体|性行为|性交|口交|肛交|自慰|手淫|做爱|色情视频|色情照片|私密照片|私密视频|性器官)/u,
  ], { hardBlock: true }),
  R('R-SEX-CSAM-02', 'sexual', 'csam', 'CSAM', 'critical', 'block', 0.98, [
    /(制作|拍摄|录制|传播|贩卖|出售|交易|下载|观看|收藏|分享).{0,8}(儿童色情|儿童性剥削|幼女色情|未成年.{0,4}(裸照|色情|性行为视频))/u,
  ], { hardBlock: true }),
  R('R-SEX-CSAM-03', 'sexual', 'csam_solicitation', 'CSAM', 'critical', 'block', 0.97, [
    /(未成年|小学生|初中生|高中生|儿童|幼女).{0,10}(发|拍|给我看|展示|传给我).{0,6}(裸照|私密照|私密视频|身体照片|性器官)/u,
  ], { hardBlock: true }),
  R('R-SEX-CSAM-04', 'sexual', 'csam_terms', 'CSAM', 'critical', 'block', 0.96, [
    /(儿童色情|幼女视频|未成年裸照|幼齿资源|萝莉色情).{0,10}(资源|网站|视频|图片|下载|分享|群)/u,
  ], { hardBlock: true }),

  // -- violence (no block) --------------------------------------------------
  R('R-VIO-01', 'violence', 'homicide', 'VIOLENCE', 'high', 'warn', 0.76, [
    /(杀死|杀掉|砍死|枪杀|毒杀|分尸|碎尸|肢解|活埋)/u,
  ]),
  R('R-VIO-02', 'violence', 'torture', 'VIOLENCE', 'high', 'warn', 0.78, [
    /(虐待|折磨|拷打).{0,6}(动物|猫|狗|儿童|老人|妻子|丈夫)/u,
  ]),
  R('R-VIO-03', 'violence', 'gore', 'VIOLENCE', 'medium', 'warn', 0.7, [
    /(血腥|残肢|内脏|尸体照片|虐杀视频)/u,
  ]),
  R('R-VIO-04', 'violence', 'instruction', 'VIOLENCE', 'high', 'confirm', 0.82, [
    /(如何|怎么|教程|步骤).{0,8}(绑架|抢劫|投毒|制造车祸|持刀伤人)/u,
  ]),
  R('R-VIO-05', 'violence', 'animal_cruelty', 'VIOLENCE', 'medium', 'warn', 0.75, [
    /(虐杀|虐待).{0,4}(猫|狗|小动物|流浪动物)/u,
  ]),

  // -- self-harm: never block, crisis hint only ----------------------------
  R('R-SELF-01', 'selfharm', 'ideation', 'SELFHARM_CRISIS', 'high', 'warn', 0.8, [
    /(自杀|自尽|轻生|结束生命|了结自己|不想活|活不下去|想死|死了算了)/u,
  ], { crisis: true }),
  R('R-SELF-02', 'selfharm', 'method', 'SELFHARM_CRISIS', 'high', 'warn', 0.82, [
    /(割腕|上吊|跳楼|服毒|烧炭|吞药|安眠药.{0,4}(过量|一把))/u,
  ], { crisis: true }),
  R('R-SELF-03', 'selfharm', 'self_injury', 'SELFHARM_CRISIS', 'high', 'warn', 0.78, [
    /(自残|自伤|划伤自己|拿刀划|烫伤自己)/u,
  ], { crisis: true }),
  R('R-SELF-04', 'selfharm', 'method_request', 'SELFHARM_CRISIS', 'high', 'warn', 0.8, [
    /(怎么|如何|方法|教程|最快).{0,6}(自杀|结束生命|无痛苦地死)/u,
  ], { crisis: true }),

  // -- minors ---------------------------------------------------------------
  R('R-MINOR-01', 'minors', 'grooming', 'MINOR_PROTECTION', 'high', 'confirm', 0.85, [
    /(未成年|小学生|初中生|高中生|儿童).{0,8}(约见|见面|开房|过夜|恋爱|网恋|处对象|私奔)/u,
    /(加微信|加qq|私聊).{0,8}(未成年|小学生|初中生).{0,8}(见面|约会|发照片)/u,
  ]),
  R('R-MINOR-02', 'minors', 'risky_behaviour', 'MINOR_PROTECTION', 'medium', 'warn', 0.7, [
    /(未成年|小学生|初中生|高中生).{0,8}(抽烟|喝酒|纹身|贷款|打工|辍学|进酒吧|去网吧)/u,
  ]),
  R('R-MINOR-03', 'minors', 'adult_content_to_minors', 'MINOR_PROTECTION', 'high', 'confirm', 0.8, [
    /(给|向|让).{0,4}(未成年|儿童|小学生|初中生).{0,8}(看|发送|推荐|播放).{0,6}(色情|成人|暴力|恐怖)/u,
  ]),
  R('R-MINOR-04', 'minors', 'declared_minor', 'MINOR_PROTECTION', 'medium', 'warn', 0.7, [
    /(我|本人|我今年).{0,4}(未成年|(?:[0-9]|1[0-7])岁)/u,
  ]),
  R('R-MINOR-05', 'minors', 'exploitation', 'MINOR_PROTECTION', 'high', 'confirm', 0.82, [
    /(雇佣|使用|组织).{0,6}(童工|未成年.{0,4}(打工|劳动|直播|带货))/u,
  ]),

  // -- personal data: single hits redact; bulk exfiltration blocks ---------
  PII('R-PII-PHONE-01', 'PHONE', /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d(?:[-\s]?\d{4}){2}(?!\d)/gu),
  PII('R-PII-IDCARD-01', 'ID_CARD', /(?<![0-9A-Za-z])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9A-Za-z])/gu, {
    validator: 'idcard',
  }),
  PII('R-PII-BANKCARD-01', 'BANK_CARD', /(?<!\d)\d(?:[ -]?\d){15,18}(?!\d)/gu, { validator: 'bankcard' }),
  PII('R-PII-EMAIL-01', 'EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu),
  PII('R-PII-SECRET-01', 'SECRET', /(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/gu),
  PII('R-PII-SECRET-02', 'SECRET', /(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|pwd|private[_-]?key)[\w.-]*\s*[:=：]\s*["']?([A-Za-z0-9_\-./+=]{6,})["']?/giu, {
    group: 1,
  }),
  PII('R-PII-ADDRESS-01', 'ADDRESS', /[\u4e00-\u9fa5]{2,8}(?:省|自治区|市)[\u4e00-\u9fa5]{2,8}(?:市|区|县)[\u4e00-\u9fa5A-Za-z0-9]{1,20}(?:路|街道|街|巷|弄|胡同)[\u4e00-\u9fa5A-Za-z0-9]{0,10}号(?:[\u4e00-\u9fa5A-Za-z0-9]{1,10}(?:室|栋|单元|楼)[A-Za-z0-9]{0,10})?/gu),
  R('R-PII-BULK-01', 'pii', 'bulk', 'PII_BULK_EXFIL', 'critical', 'block', 0.95, [
    /(导出|下载|爬取|抓取|收集|打包|汇总|整理|出售|倒卖|提供|外发|泄露).{0,12}(全部|所有|全量|批量|上万|十万|百万|[0-9]+万|[0-9]{3,}条|大量|海量).{0,12}(身份证|手机号|手机号码|个人信息|客户资料|用户数据|通讯录|住址|隐私)/u,
    /(批量|大量|海量|全量).{0,12}(导出|下载|出售|倒卖|提供|收集|整理|发给).{0,12}(身份证|手机号|手机号码|个人信息|客户资料|用户数据|通讯录|住址|隐私)/u,
  ]),
  R('R-PII-BULK-02', 'pii', 'bulk', 'PII_BULK_EXFIL', 'critical', 'block', 0.94, [
    /(身份证|手机号|手机号码|个人信息|客户资料|用户数据|通讯录|住址|隐私).{0,20}(批量|大量|全部|所有|全量).{0,10}(导出|下载|出售|倒卖|提供|外发|泄露|发给)/u,
  ]),
  R('R-PII-BULK-03', 'pii', 'bulk', 'PII_BULK_EXFIL', 'critical', 'block', 0.9, [], {
    detector: 'pii-bulk',
    minPiiHits: 6,
    exfilPattern: /(导出|下载|爬取|抓取|收集|打包|汇总|整理|出售|倒卖|提供|外发|泄露|发给|上传)/u,
    quantityPattern: /(全部|所有|全量|批量|上万|十万|百万|[0-9]+万|[0-9]{3,}条|大量|海量)/u,
    views: ['compact'],
  }),

  // -- deep synthesis and impersonation ------------------------------------
  R('R-DEEP-01', 'deepfake', 'face_swap', 'DEEPFAKE', 'medium', 'warn', 0.72, [
    /(换脸|ai换脸|人脸替换|拟声|声音克隆|深度合成).{0,10}(视频|图片|直播|音频|语音)/u,
  ]),
  R('R-DEEP-02', 'deepfake', 'impersonation', 'DEEPFAKE', 'high', 'confirm', 0.82, [
    /(冒充|假冒|伪造).{0,6}(领导|老板|亲友|公检法|公安|检察院|法院|客服|银行|官方)/u,
  ]),
  R('R-DEEP-03', 'deepfake', 'forged_documents', 'DEEPFAKE', 'high', 'confirm', 0.84, [
    /(伪造|合成|生成|制作).{0,6}(身份证|护照|公文|印章|证件|合同|签名|人脸|指模)/u,
  ]),
  R('R-DEEP-04', 'deepfake', 'fake_news', 'DEEPFAKE', 'medium', 'confirm', 0.78, [
    /(生成|制作|编造).{0,8}(虚假|不实|谣言).{0,6}(新闻|通报|截图|视频|公告)/u,
  ]),
  R('R-DEEP-05', 'deepfake', 'voice_clone', 'DEEPFAKE', 'high', 'confirm', 0.8, [
    /(克隆|模仿|复制).{0,6}(他人的|某人的|别人的).{0,4}(声音|脸|形象)/u,
  ]),

  // -- fraud and commercial illegality -------------------------------------
  R('R-FRAUD-01', 'fraud', 'brushing_scam', 'FRAUD', 'medium', 'warn', 0.74, [
    /(刷单|返利|兼职刷单|高额回报|稳赚不赔|内部消息).{0,10}(加微信|转账|投资|充值|垫付|下载)/u,
  ]),
  R('R-FRAUD-02', 'fraud', 'impersonation_transfer', 'FRAUD', 'high', 'confirm', 0.84, [
    /(我是|冒充).{0,6}(你领导|你老板|公检法|公安局|客服|银行).{0,10}(转账|汇款|安全账户|验证码)/u,
    /(安全账户|资金审查|解冻).{0,10}(转账|汇款|保证金)/u,
  ]),
  R('R-FRAUD-03', 'fraud', 'fake_documents', 'FRAUD', 'high', 'confirm', 0.84, [
    /(代办|出售|办理|购买).{0,6}(身份证|银行卡|手机卡|营业执照|假证|发票|驾驶证|毕业证)/u,
  ]),
  R('R-FRAUD-04', 'fraud', 'gambling', 'FRAUD', 'medium', 'warn', 0.75, [
    /(赌博|博彩|六合彩|时时彩|棋牌).{0,8}(平台|网站|代理|充值|下注|返水)/u,
  ]),
  R('R-FRAUD-05', 'fraud', 'pyramid_scheme', 'FRAUD', 'medium', 'warn', 0.78, [
    /(传销|拉人头|发展下线|1040工程|资本运作).{0,8}(模式|项目|赚钱|投资|回报)/u,
  ]),
  R('R-FRAUD-06', 'fraud', 'money_laundering', 'FRAUD', 'high', 'warn', 0.78, [
    /(洗钱|跑分|刷流水).{0,8}(账户|银行卡|平台|渠道|佣金)/u,
  ]),
  R('R-FRAUD-07', 'fraud', 'refund_scam', 'FRAUD', 'medium', 'warn', 0.74, [
    /(中奖|退税|退款|客服理赔).{0,10}(转账|提供|验证码|银行卡|手续费)/u,
  ]),
  R('R-FRAUD-AD-01', 'fraud', 'absolute_ad_claims', 'FRAUD', 'low', 'warn', 0.62, [
    /(最好|最佳|最强|最优|最便宜|最先进|第一品牌|国家级|世界级|唯一).{0,6}(品牌|产品|服务|疗效|效果)/u,
  ]),

  // -- malware (weaponized = narrow block; dual-use = confirm/warn) --------
  R('R-MALWARE-01', 'malware', 'malware_authoring', 'MALWARE_WEAPONIZED', 'critical', 'block', 0.96, [
    /(编写|写一个|生成|开发|制作|给我|帮我写).{0,10}(勒索软件|勒索病毒|木马|病毒|后门|键盘记录器|窃密程序|挖矿木马|蠕虫)/u,
  ]),
  R('R-MALWARE-02', 'malware', 'av_evasion', 'MALWARE_WEAPONIZED', 'critical', 'block', 0.95, [
    /(免杀|绕过|bypass).{0,8}(杀毒|defender|av|edr|waf|沙箱|检测)/u,
  ]),
  R('R-MALWARE-03', 'malware', 'credential_theft', 'MALWARE_WEAPONIZED', 'critical', 'block', 0.95, [
    /(如何|怎么|教我|写一个|实现).{0,10}(窃取|盗取|抓取|截获|记录).{0,8}(密码|账号|凭证|cookie|token|银行卡|私钥)/u,
  ]),
  R('R-MALWARE-04', 'malware', 'exploit_weaponization', 'MALWARE_WEAPONIZED', 'critical', 'block', 0.94, [
    /(利用|使用).{0,6}(漏洞|0day|exp|exploit).{0,10}(攻击|入侵|提权|拿shell|上传|反弹)/u,
    /(编写|构造|制作).{0,8}(exploit|exp|攻击载荷|payload).{0,8}(利用|攻击|入侵)/u,
  ]),
  R('R-MALWARE-05', 'malware', 'phishing_kit', 'MALWARE_WEAPONIZED', 'critical', 'block', 0.94, [
    /(制作|搭建|生成|开发).{0,6}(钓鱼网站|钓鱼页面|钓鱼邮件|仿冒登录页)/u,
  ]),
  R('R-MALWARE-06', 'malware', 'ddos_weaponization', 'MALWARE_WEAPONIZED', 'critical', 'block', 0.93, [
    /(帮我|给我|教我|怎么|如何).{0,8}(ddos|拒绝服务攻击|压测|打死|打垮|打瘫).{0,6}(网站|服务器|对手|平台|目标)/u,
    /(发起|实施|进行).{0,6}(ddos|拒绝服务攻击|勒索攻击)/u,
  ]),
  R('R-MALWARE-07', 'malware', 'dual_use_research', 'MALWARE', 'low', 'warn', 0.65, [
    /(分析|研究|检测|防御|查杀|清理|溯源).{0,6}(病毒|木马|恶意软件|勒索软件|恶意样本)/u,
    /(渗透测试|安全评估|漏洞扫描|应急响应)/u,
  ]),
  R('R-MALWARE-08', 'malware', 'license_bypass', 'MALWARE', 'low', 'warn', 0.62, [
    /(绕过|破解|去除).{0,6}(付费|会员|授权|验证|激活|限制)/u,
  ]),

  // -- illegal instruction (direct incitement = narrow block) --------------
  R('R-ILLEGAL-DRUG-01', 'illegal', 'drug_synthesis', 'ILLEGAL_INSTRUCTION', 'critical', 'block', 0.96, [
    /(如何|怎么|怎样|教我|告诉我|求|想要|需要).{0,10}(制作|制造|合成|提炼|提纯|种植|加工).{0,6}(冰毒|海洛因|可卡因|摇头丸|k粉|大麻|毒品|麻黄碱)/u,
  ]),
  R('R-ILLEGAL-DRUG-02', 'illegal', 'drug_synthesis', 'ILLEGAL_INSTRUCTION', 'critical', 'block', 0.95, [
    /(制毒|制冰|提炼毒品|合成毒品).{0,10}(步骤|教程|配方|方法|工艺|流程)/u,
    /(冰毒|海洛因|可卡因|摇头丸|k粉|大麻|毒品).{0,8}(配方|制作步骤|制作方法|提取方法|合成方法|教程|工艺流程)/u,
  ]),
  R('R-ILLEGAL-WEAPON-01', 'illegal', 'weapon_making', 'ILLEGAL_INSTRUCTION', 'critical', 'block', 0.96, [
    /(如何|怎么|怎样|教我|告诉我|教程|步骤|图纸).{0,10}(制作|制造|改装|组装|自制).{0,8}(枪支|手枪|步枪|手雷|炸弹|爆炸物|消音器|弹药)/u,
  ]),
  R('R-ILLEGAL-WEAPON-02', 'illegal', 'weapon_making', 'ILLEGAL_INSTRUCTION', 'critical', 'block', 0.95, [
    /(改装|私制|自制).{0,6}(枪支|枪械|弹药|爆炸物|手枪).{0,10}(教程|方法|图纸|步骤|流程)/u,
  ]),
  R('R-ILLEGAL-CRIME-01', 'illegal', 'crime_instruction', 'ILLEGAL_INSTRUCTION', 'critical', 'block', 0.94, [
    /(如何|怎么|教我|指导|教程|步骤).{0,12}(洗钱|偷渡|贩毒|销赃|伪造证件|制假|绑架|抢劫)/u,
  ]),
  R('R-ILLEGAL-VIOLENCE-01', 'illegal', 'violence_instruction', 'ILLEGAL_INSTRUCTION', 'critical', 'block', 0.94, [
    /(我想|我要|我打算|教我|告诉我|指导我).{0,8}(杀人|绑架|抢劫|投毒|制造爆炸|砍人)/u,
    /(怎么|如何).{0,4}(杀人|投毒|绑架|抢劫).{0,4}(不|才).{0,4}(被发现|被抓|判刑)/u,
  ]),
  R('R-ILLEGAL-OTHER-01', 'illegal', 'contraband', 'ILLEGAL_INSTRUCTION', 'high', 'confirm', 0.82, [
    /(购买|出售|求购|收购).{0,6}(毒品|冰毒|海洛因|枪支|弹药|假币|假证|个人信息|银行卡)/u,
  ]),
  R('R-ILLEGAL-OTHER-02', 'illegal', 'counterfeit', 'ILLEGAL_INSTRUCTION', 'high', 'confirm', 0.84, [
    /(假币|假钞|伪钞).{0,8}(制作|购买|出售|使用|兑换)/u,
  ]),
  R('R-ILLEGAL-OTHER-03', 'illegal', 'smuggling', 'ILLEGAL_INSTRUCTION', 'high', 'confirm', 0.8, [
    /(偷渡|组织偷渡|蛇头).{0,8}(路线|费用|办理|联系方式)/u,
  ]),
  R('R-ILLEGAL-OTHER-04', 'illegal', 'evasion', 'ILLEGAL_INSTRUCTION', 'medium', 'warn', 0.72, [
    /(逃避|规避).{0,6}(海关|税务|监管|检查).{0,8}(方法|技巧|教程)/u,
  ]),
  R('R-ILLEGAL-OTHER-05', 'illegal', 'piracy', 'ILLEGAL_INSTRUCTION', 'low', 'warn', 0.64, [
    /(盗版|破解版|绿色版).{0,6}(软件|游戏|电影|课程).{0,6}(下载|资源|网站)/u,
  ]),

  // -- harassment -----------------------------------------------------------
  R('R-HARASS-01', 'harassment', 'doxxing', 'HARASSMENT', 'high', 'confirm', 0.85, [
    /(人肉|开盒|曝光).{0,8}(个人信息|隐私|住址|电话|身份证|家人|单位)/u,
  ]),
  R('R-HARASS-02', 'harassment', 'insults', 'HARASSMENT', 'medium', 'warn', 0.7, [
    /(去死|废物|垃圾|恶心|蠢货|傻逼|贱人).{0,4}(你|他|她|这人|东西)/u,
  ]),
  R('R-HARASS-03', 'harassment', 'defamation', 'HARASSMENT', 'medium', 'warn', 0.72, [
    /(造谣|诽谤|污蔑|编造).{0,8}(他人|同事|同学|公司|对方).{0,8}(谣言|丑闻|事实)/u,
  ]),
  R('R-HARASS-04', 'harassment', 'mobbing', 'HARASSMENT', 'medium', 'warn', 0.75, [
    /(网暴|网络暴力|辱骂|挂人|围攻).{0,8}(教程|组织|发动|评论|投诉)/u,
  ]),
  R('R-HARASS-05', 'harassment', 'threats', 'HARASSMENT', 'high', 'confirm', 0.8, [
    /(你|他|她).{0,4}(全家|家人).{0,4}(死|不得好死|遭报应)/u,
  ]),

  // -- prompt injection (engineering risk, never block) --------------------
  R('R-INJ-01', 'injection', 'instruction_override', 'PROMPT_INJECTION', 'high', 'warn', 0.8, [
    /(忽略|无视|忘记|跳过|不要遵守|取消|覆盖).{0,12}(之前|以上|前面|上述|所有|系统|安全).{0,8}(指令|提示|规则|要求|限制)/u,
  ], { views: ['compact', 'normalized'] }),
  R('R-INJ-02', 'injection', 'prompt_leak', 'PROMPT_INJECTION', 'high', 'warn', 0.8, [
    /(输出|打印|打印出来|显示|告诉我|泄露|重复|复述|repeat).{0,10}(系统提示|system prompt|开发者指令|初始指令|隐藏指令|第一条指令|prompt)/u,
    /(系统提示|system prompt|开发者指令|初始指令|隐藏指令|提示词|prompt).{0,12}(输出|打印|泄露|告诉我|重复|复述|贴出来|发出来)/u,
  ], { views: ['compact', 'normalized'] }),
  R('R-INJ-03', 'injection', 'jailbreak_role', 'PROMPT_INJECTION', 'high', 'warn', 0.8, [
    /(你现在是|扮演|进入|切换).{0,8}(开发者模式|管理员模式|无限制模式|dan|jailbreak|越狱|无规则)/u,
  ], { views: ['compact', 'normalized'] }),
  R('R-INJ-04', 'injection', 'secret_exfiltration', 'PROMPT_INJECTION', 'high', 'warn', 0.82, [
    /(把|将|输出|发送|给我|泄露).{0,10}(密钥|api.?key|token|密码|凭证|secret|私钥)/u,
    /(密钥|api.?key|token|密码|凭证|私钥).{0,20}(发我|给我|发出来|输出|贴出来)/u,
  ], { views: ['compact', 'normalized'] }),
  R('R-INJ-05', 'injection', 'tool_output_injection', 'PROMPT_INJECTION', 'high', 'warn', 0.78, [
    /(工具|tool|检索|网页|附件|文件).{0,10}(返回|输出|内容).{0,10}(是|视为|作为).{0,6}(指令|命令)/u,
  ], { views: ['compact', 'normalized'] }),
  R('R-INJ-06', 'injection', 'safety_bypass', 'PROMPT_INJECTION', 'high', 'warn', 0.8, [
    /(忽略|无视|绕过|关闭|禁用).{0,8}(安全|审核|内容|合规).{0,4}(规则|限制|策略|机制)/u,
  ], { views: ['compact', 'normalized'] }),
  R('R-INJ-07', 'injection', 'instruction_override_en', 'PROMPT_INJECTION', 'high', 'warn', 0.8, [
    /(do not|ignore|disregard|forget).{0,20}(previous|above|all|system).{0,10}(instructions|prompts|rules)/iu,
  ], { views: ['normalized', 'compact'] }),
  R('R-INJ-08', 'injection', 'privileged_command', 'PROMPT_INJECTION', 'high', 'warn', 0.78, [
    /(越权|提权|sudo|rm -rf|管理员权限|root 权限).{0,10}(执行|运行|命令|删除)/u,
    /(rm -rf|删除).{0,10}(审计日志|audit|系统文件|数据库|全部文件)/u,
  ], { views: ['normalized', 'compact'] }),
  R('R-INJ-09', 'injection', 'unrestricted_persona', 'PROMPT_INJECTION', 'high', 'warn', 0.78, [
    /(扮演|假装|你是).{0,10}(没有|不受|无需|不用).{0,6}(限制|规则|安全|审核)/u,
  ], { views: ['compact', 'normalized'] }),
]

// ---------------------------------------------------------------------------
// ruleset compilation (default + JSON override)
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set(['warn', 'confirm', 'redact', 'block'])
const VALID_VIEWS = new Set(['compact', 'normalized', 'both', 'original'])

function validateAction(action, where) {
  if (!VALID_ACTIONS.has(action)) {
    throw new TypeError(`${where}: unsupported action "${action}"`)
  }
  return action
}

function assertCategory(id, where) {
  if (!CATEGORY_BY_ID[id]) throw new TypeError(`${where}: unknown category "${id}"`)
  return id
}

function assertRuleId(id, where) {
  if (typeof id !== 'string' || !/^R-[A-Z0-9][A-Z0-9-]{1,40}$/.test(id)) {
    throw new TypeError(`${where}: invalid rule id "${id}"`)
  }
  return id
}

function normalizeViews(views, fallback) {
  if (views == null) return fallback
  const list = Array.isArray(views) ? views : [views]
  if (!list.length) throw new TypeError('views must not be empty')
  for (const view of list) {
    if (!VALID_VIEWS.has(view)) throw new TypeError(`unsupported view "${view}"`)
  }
  if (list.includes('both')) return ['compact', 'normalized']
  if (list.includes('original')) return ['compact']
  return [...new Set(list)]
}

function compileScanPattern(pattern, ruleId) {
  try {
    const flags = (pattern.flags || 'u').replace(/[gyd]/g, '')
    return new RegExp(pattern.source, flags.includes('u') ? flags : `${flags}u`)
  } catch (error) {
    throw new TypeError(`rule ${ruleId}: invalid pattern: ${error.message}`)
  }
}

function compileRule(rule) {
  const where = `rule ${rule.id}`
  assertRuleId(rule.id, 'ruleset')
  assertCategory(rule.category, where)
  if (!SEVERITIES.includes(rule.severity)) throw new TypeError(`${where}: invalid severity "${rule.severity}"`)
  const action = validateAction(rule.action, where)
  if (action === 'block') {
    if (!BLOCK_CATEGORIES.includes(rule.category)) throw new TypeError(`${where}: category "${rule.category}" is not block-eligible`)
    if (!rule.blockable) throw new TypeError(`${where}: block rule must be blockable`)
  }
  if (rule.detector && !['pii', 'pii-bulk'].includes(rule.detector)) {
    throw new TypeError(`${where}: unsupported detector "${rule.detector}"`)
  }
  const confidence = Number(rule.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError(`${where}: confidence must be a number in [0, 1]`)
  }
  const patterns = (rule.patterns || []).map((pattern) => compileScanPattern(asPattern(pattern), rule.id))
  if (!patterns.length && !rule.detector) throw new TypeError(`${where}: rule has no patterns`)
  return Object.freeze({
    id: rule.id,
    category: rule.category,
    subtype: rule.subtype || 'general',
    code: rule.code || 'CONTENT_RISK',
    severity: rule.severity,
    action,
    blockable: Boolean(rule.blockable),
    hardBlock: Boolean(rule.hardBlock),
    crisis: Boolean(rule.crisis),
    confidence,
    negationSensitive: rule.negationSensitive !== false,
    views: normalizeViews(rule.views, ['compact']),
    detector: rule.detector || null,
    piiKind: rule.piiKind || null,
    validator: rule.validator || null,
    group: Number.isInteger(rule.group) ? rule.group : null,
    minPiiHits: Number.isInteger(rule.minPiiHits) ? rule.minPiiHits : null,
    exfilPattern: rule.exfilPattern instanceof RegExp ? rule.exfilPattern : null,
    quantityPattern: rule.quantityPattern instanceof RegExp ? rule.quantityPattern : null,
    patterns,
  })
}

function canonicalRule(rule) {
  return {
    id: rule.id,
    category: rule.category,
    subtype: rule.subtype,
    code: rule.code,
    severity: rule.severity,
    action: rule.action,
    blockable: rule.blockable,
    hardBlock: rule.hardBlock,
    crisis: rule.crisis,
    confidence: rule.confidence,
    views: rule.views,
    detector: rule.detector,
    piiKind: rule.piiKind,
    validator: rule.validator,
    group: rule.group,
    minPiiHits: rule.minPiiHits,
    exfil: rule.exfilPattern ? rule.exfilPattern.source : null,
    quantity: rule.quantityPattern ? rule.quantityPattern.source : null,
    patterns: rule.patterns.map((pattern) => toPatternSource(pattern)),
  }
}

function digestOf(version, rules) {
  const canonical = { version, rules: [...rules].sort((a, b) => a.id.localeCompare(b.id)).map(canonicalRule) }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

function compileRuleset(rules, version) {
  const compiled = rules.map(compileRule).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return Object.freeze({
    __compiled: true,
    version,
    digest: digestOf(version, compiled),
    categories: CATEGORIES,
    blockCategories: BLOCK_CATEGORIES,
    rules: Object.freeze(compiled),
  })
}

export const DEFAULT_RULESET = compileRuleset(BUILTIN_RULES, RULESET_VERSION)
export const RULESET_DIGEST = DEFAULT_RULESET.digest

function compileOverride(override, baseRules, version) {
  const byId = new Map(baseRules.map((rule) => [rule.id, rule]))
  const disabled = new Set()
  if (override.disabledRules != null) {
    if (!Array.isArray(override.disabledRules)) throw new TypeError('disabledRules must be an array')
    for (const rawId of override.disabledRules) {
      const id = assertRuleId(rawId, 'disabledRules')
      const rule = byId.get(id)
      if (rule?.hardBlock) {
        throw new TypeError(`disabledRules: hard-block rule ${id} (child sexual exploitation) cannot be disabled`)
      }
      disabled.add(id)
    }
  }

  if (override.rules != null) {
    if (!Array.isArray(override.rules)) throw new TypeError('rules must be an array')
    for (const entry of override.rules) {
      if (!entry || typeof entry !== 'object') throw new TypeError('rules entries must be objects')
      const id = assertRuleId(entry.id, 'rules')
      const existing = byId.get(id)
      const next = existing ? { ...existing } : {
        id,
        category: entry.category,
        subtype: entry.subtype || 'custom',
        code: entry.code || 'CUSTOM',
        severity: entry.severity || 'low',
        action: entry.action || 'warn',
        confidence: entry.confidence == null ? 0.6 : entry.confidence,
        blockable: false,
        hardBlock: false,
        crisis: false,
        negationSensitive: true,
        views: entry.views || ['compact'],
        detector: null,
        piiKind: null,
        validator: null,
        group: null,
        minPiiHits: null,
        exfilPattern: null,
        quantityPattern: null,
        patterns: [],
      }
      if (existing) {
        if (existing.hardBlock) {
          throw new TypeError(`rules: hard-block rule ${id} (child sexual exploitation) cannot be overridden`)
        }
        if (entry.category != null && entry.category !== existing.category) {
          throw new TypeError(`rules: category of ${id} cannot be changed`)
        }
        if (entry.patterns != null) next.patterns = entry.patterns.map((pattern) => asPatternSafe(pattern, id))
        if (entry.severity != null) next.severity = entry.severity
        if (entry.action != null) next.action = validateAction(entry.action, `rules ${id}`)
        if (entry.confidence != null) next.confidence = entry.confidence
      } else {
        assertCategory(entry.category, `rules ${id}`)
        next.category = entry.category
        next.action = validateAction(next.action, `rules ${id}`)
        if (next.action === 'block') {
          throw new TypeError(`rules: JSON override cannot add block rules (${id}); block is a built-in narrow allowlist`)
        }
        if (entry.blockable || entry.hardBlock) {
          throw new TypeError(`rules: JSON override cannot mark ${id} blockable/hardBlock`)
        }
        next.patterns = (entry.patterns || []).map((pattern) => asPatternSafe(pattern, id))
        if (!next.patterns.length) throw new TypeError(`rules ${id}: patterns must be a non-empty array`)
      }
      byId.set(id, next)
    }
  }

  const categoryActions = override.categoryActions || {}
  if (typeof categoryActions !== 'object' || Array.isArray(categoryActions)) {
    throw new TypeError('categoryActions must be an object')
  }
  for (const [category, action] of Object.entries(categoryActions)) {
    assertCategory(category, 'categoryActions')
    if (action === 'block') throw new TypeError('categoryActions: JSON override cannot set block')
    validateAction(action, `categoryActions.${category}`)
  }

  const finalRules = [...byId.values()].filter((rule) => !disabled.has(rule.id)).map((rule) => {
    const targetAction = categoryActions[rule.category]
    if (!targetAction || rule.hardBlock) return rule
    if (actionRank(targetAction) < actionRank(rule.action)) return { ...rule, action: targetAction }
    return rule
  })

  return compileRuleset(finalRules, version)
}

/**
 * Resolve a ruleset: default built-ins, or a JSON override object/string.
 *
 * Override shape (all keys optional):
 * {
 *   "version": "advisers-content-1",
 *   "disabledRules": ["R-SEX-01"],
 *   "rules": [{ "id": "R-X-01", "category": "fraud", "patterns": ["..."], "action": "warn", "severity": "low" }],
 *   "categoryActions": { "fraud": "warn" }   // downgrade only, never "block"
 * }
 *
 * JSON overrides can narrow or add warning/confirm/redact rules, but cannot add
 * block rules and cannot disable/override the CSAM hard-block rules.
 */
export function resolveRuleset(override) {
  if (override == null) return DEFAULT_RULESET
  if (typeof override === 'string') {
    let parsed
    try {
      parsed = JSON.parse(override)
    } catch (error) {
      throw new TypeError(`ruleset override is not valid JSON: ${error.message}`)
    }
    return resolveRuleset(parsed)
  }
  if (typeof override !== 'object' || Array.isArray(override)) {
    throw new TypeError('ruleset override must be an object or a JSON string')
  }
  if (override.__compiled) return override
  const version = override.version == null ? RULESET_VERSION : String(override.version)
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(version)) {
    throw new TypeError('ruleset version must match /^[a-z0-9][a-z0-9._-]{2,39}$/')
  }
  return compileOverride(override, BUILTIN_RULES, version)
}

/** Loader-friendly alias: parse + resolve in one step (still pure, no fs). */
export function loadRuleset(source) {
  return resolveRuleset(source)
}
