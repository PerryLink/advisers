#!/usr/bin/env node
/**
 * eval/run-office-real.mjs — 20 份“真实感”Office 文档的缺陷审阅集（realistic synthetic）。
 *
 * ⚠️ 重要声明（请勿删除）
 * - 本文件生成的 20 份文档是 **realistic synthetic**：结构与业务语气接近真实合同/周报/
 *   预算表/会议纪要/报价单，但内容全部是合成的，**不是任何客户或公司的真实文档**，
 *   也不是从真实文档脱敏而来。
 * - 因此本 eval 只能用于本仓内部回归。**不得把结果用于对外 benchmark、宣传、
 *   排行榜或与第三方产品对比的宣称。**
 * - 每份文档恰好注入 1 个可在文本中复查的缺陷：10 类 × 2 = 20。
 * - 生成过程不联网、不读取 API key；只有真实模型审阅阶段才调用本地 CLI。
 *
 * 覆盖（跨业务类型）：合同/协议、周报、预算表、会议纪要、报价单、项目计划、
 * 任务清单、KPI 表、对账单、回款台账、交付确认单。
 * 格式分布：14 份 docx + 4 份 xlsx + 2 份 pptx（xlsx ≥ 4；pptx 为会议纪要）。
 *
 * 用法：
 *   node eval/run-office-real.mjs --dry-run
 *       只生成文档与 manifest（无 key 时自动进入 dry-run），打印清单后清理临时目录。
 *   DEEPSEEK_API_KEY=... node eval/run-office-real.mjs
 *       生成文档，逐份调用 `advisers review <file> --request "..."`（临时 ADVISERS_HOME，
 *       单例超时 180s），解析退出码与 blocker，输出逐例 PASS/FAIL + JSON 汇总。
 *   ADVISERS_API_KEY=... LIMIT=4 node eval/run-office-real.mjs
 *       只跑前 4 例（LIMIT 环境变量或 --limit N）。
 *   node eval/run-office-real.mjs --dry-run --keep
 *       保留临时目录，打印其绝对路径便于人工查看生成的文档。
 *   node eval/run-office-real.mjs --json /tmp/office-real.json
 *       额外把 JSON 汇总写到指定文件（默认只打印到 stdout）。
 *
 * 判定：PASS = CLI 输出中存在 `[blocker]` finding；FAIL = CLI 正常退出（exit 0）但没有
 * blocker；ERROR = 超时 / 非预期退出码 / review 输出不是合法 JSON / CLI 自身报错。
 * expectedKeyword 只用于额外报告“是否命中预期缺陷关键词”，不影响 PASS/FAIL 口径。
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildDocx, buildPptx, buildXlsx, officeToText, readOffice } from '../packages/office/dist/index.js'

const DISCLAIMER = 'realistic synthetic documents; not real customer data; internal regression only; must not be used for external benchmarks or marketing claims'
const CLI_PATH = fileURLToPath(new URL('../packages/advisers/bin/advisers.js', import.meta.url))
const REVIEW_TIMEOUT_MS = 180_000

const DEFECT_TYPES = [
  ['sum', '合计错误'],
  ['placeholder', '占位符'],
  ['client', '客户名错'],
  ['date', '日期矛盾'],
  ['owner', '负责人缺失'],
  ['unit', '单位错误'],
  ['missing_total', '缺合计行'],
  ['percent', '百分比错误'],
  ['duplicate', '重复客户行'],
  ['contradiction', '金额/日期与正文矛盾'],
]

/** 20 个 case。spec 直接对应 packages/office/dist 的 DocxSpec / XlsxSpec / PptxSpec。 */
const CASES = [
  {
    id: 'sum-1',
    kind: 'quote',
    kindLabel: '报价单',
    format: 'docx',
    defectType: 'sum',
    defectLabel: '合计错误',
    expectedKeyword: ['合计', '120,000', '110,000'],
    expectedFinding: '报价合计行写 110,000，但分项 48,000 + 72,000 应为 120,000',
    request: '报价单合计应为 120,000 元（设计 48,000 + 开发 72,000），请检查合计行是否正确。',
    mustInclude: ['110,000'],
    spec: {
      title: '网站改版项目报价单',
      subtitle: '报价编号：BJ-2026-1118 · 报价有效期：30 天',
      sections: [
        { heading: '客户信息', paragraphs: ['客户：华星科技有限公司', '联系人：王工（138****6721）', '项目：官网及移动端改版'] },
        {
          heading: '报价明细',
          table: {
            headers: ['项目', '说明', '数量', '单价（元）', '小计（元）'],
            rows: [
              ['UI 设计', '首页及 12 个内页设计', '1', '48,000', '48,000'],
              ['前端开发', '响应式页面开发与联调', '1', '72,000', '72,000'],
              ['合计', '', '', '', '110,000'],
            ],
          },
        },
        { heading: '付款与交付', paragraphs: ['合同签订后支付 40%，验收通过后支付 60%。', '开发周期 30 个自然日，含 2 轮修改。'] },
        { heading: '说明', bullets: ['报价含 6% 增值税，不含第三方字体与图库授权费用。', '超出 2 轮的修改按 800 元/人天另行计费。'] },
      ],
    },
  },
  {
    id: 'sum-2',
    kind: 'budget',
    kindLabel: '预算表',
    format: 'xlsx',
    defectType: 'sum',
    defectLabel: '合计错误',
    expectedKeyword: ['合计', '100,000', '95000'],
    expectedFinding: '预算合计写 95,000，但 32,000 + 45,000 + 23,000 应为 100,000',
    request: '预算表合计应为 100,000 元（32,000 + 45,000 + 23,000），请检查合计行是否正确。',
    mustInclude: ['95000'],
    spec: {
      sheet: '2027Q1 预算',
      freezeHeader: true,
      columns: [
        { header: '科目', key: 'item', width: 16 },
        { header: '预算金额（元）', key: 'amount', width: 18 },
        { header: '备注', key: 'note', width: 26 },
      ],
      rows: [
        { item: '差旅费', amount: 32000, note: '客户现场支持 4 次' },
        { item: '外包服务', amount: 45000, note: '数据清洗与测试' },
        { item: '软件订阅', amount: 23000, note: '监控与协作工具' },
        { item: '合计', amount: 95000, note: '' },
      ],
    },
  },
  {
    id: 'placeholder-1',
    kind: 'agreement',
    kindLabel: '服务协议',
    format: 'docx',
    defectType: 'placeholder',
    defectLabel: '占位符',
    expectedKeyword: ['TODO', '待补充', '占位'],
    expectedFinding: '验收标准仍保留“TODO 待补充”占位符',
    request: '对外发送前检查协议中是否还有 TODO、待补充等占位符。',
    mustInclude: ['TODO 待补充'],
    spec: {
      title: '数据服务协议',
      subtitle: '合同编号：HX-DS-2026-0118',
      sections: [
        { heading: '合同双方', paragraphs: ['甲方：华星科技有限公司', '乙方：远山数据服务有限公司'] },
        {
          heading: '服务内容',
          paragraphs: [
            '乙方向甲方提供客户主数据清洗、去重与接口维护服务。',
            '服务期：2026-12-01 至 2027-11-30。',
            '验收标准：TODO 待补充具体验收指标、抽样比例与验收人。',
          ],
        },
        { heading: '费用与支付', paragraphs: ['年度服务费：人民币 18 万元（含税）。', '甲方在收到合规发票后 15 个工作日内支付。'] },
        { heading: '违约责任', paragraphs: ['任一方违约的，应赔偿守约方因此遭受的直接损失。'] },
      ],
    },
  },
  {
    id: 'placeholder-2',
    kind: 'minutes',
    kindLabel: '会议纪要',
    format: 'pptx',
    defectType: 'placeholder',
    defectLabel: '占位符',
    expectedKeyword: ['TODO', '待补充', '占位'],
    expectedFinding: '待办事项里的客户通知话术仍是“TODO 待补充”占位符',
    request: '这是会议草稿，发出前检查是否还有 TODO、待补充等占位符。',
    mustInclude: ['TODO 待补充'],
    spec: {
      title: '客户上线方案讨论会（草稿）',
      subtitle: '2026-11-18 · 内部讨论稿',
      slides: [
        { title: '会议信息', bullets: ['时间：2026-11-18 14:00-15:30', '地点：5 号会议室', '主持：李经理', '记录：陈老师'] },
        { title: '讨论结论', bullets: ['上线窗口暂定 2026-11-27 22:00。', '灰度比例先按 10% 放量，观察 24 小时。'] },
        {
          title: '待办事项',
          bullets: [
            '回滚方案：王工负责，2026-11-21 前给出。',
            '客户通知话术：TODO 待补充，下次会议确认。',
            '监控看板：陈老师负责，2026-11-22 前完成。',
          ],
        },
      ],
    },
  },
  {
    id: 'client-1',
    kind: 'contract',
    kindLabel: '合同',
    format: 'docx',
    defectType: 'client',
    defectLabel: '客户名错',
    expectedKeyword: ['华兴', '客户名', '华星'],
    expectedFinding: '甲方是“华星科技有限公司”，但合同标的写成“华兴科技有限公司”',
    request: '客户名应为“华星科技有限公司”，检查文中是否出现“华兴”误写。',
    mustInclude: ['华兴科技有限公司'],
    spec: {
      title: '软件采购合同',
      subtitle: '合同编号：HX-2026-1105',
      sections: [
        { heading: '合同双方', paragraphs: ['甲方：华星科技有限公司（以下简称“甲方”）', '乙方：远山数据服务有限公司（以下简称“乙方”）'] },
        { heading: '鉴于', paragraphs: ['甲方拟采购客户数据管理平台，乙方具备相应开发与交付能力，双方经协商一致订立本合同。'] },
        {
          heading: '合同标的',
          paragraphs: [
            '乙方向甲方交付“华兴科技有限公司客户数据平台”一套，包含数据接入、客户画像与权限管理三个模块。',
            '交付形式：私有化部署，含安装包与部署文档。',
          ],
        },
        { heading: '合同价款', paragraphs: ['合同总价：人民币 120 万元（含税）。'] },
      ],
    },
  },
  {
    id: 'client-2',
    kind: 'quote',
    kindLabel: '报价单',
    format: 'docx',
    defectType: 'client',
    defectLabel: '客户名错',
    expectedKeyword: ['华兴', '客户名', '华星'],
    expectedFinding: '报价明细的客户是“华星”，但说明段落写成“华兴”',
    request: '报价单客户名应为“华星科技有限公司”，检查是否把客户名误写成“华兴”。',
    mustInclude: ['华兴科技有限公司'],
    spec: {
      title: '年度运维服务报价明细',
      subtitle: '报价编号：BJ-2026-1120',
      sections: [
        {
          heading: '报价明细',
          table: {
            headers: ['客户', '服务项', '数量', '单价（元）', '小计（元）'],
            rows: [
              ['华星科技有限公司', '应用系统运维', '12 个月', '8,000', '96,000'],
              ['华星科技有限公司', '数据库巡检', '12 个月', '2,000', '24,000'],
              ['合计', '', '', '', '120,000'],
            ],
          },
        },
        { heading: '说明', paragraphs: ['本报价仅对华兴科技有限公司有效，有效期至 2026-12-31。', '报价含 6% 增值税。'] },
      ],
    },
  },
  {
    id: 'date-1',
    kind: 'minutes',
    kindLabel: '会议纪要',
    format: 'pptx',
    defectType: 'date',
    defectLabel: '日期矛盾',
    expectedKeyword: ['2026-11-26', '日期', '矛盾', '上次会议'],
    expectedFinding: '本次会议是 2026-11-19，但“上次会议”写成未来的 2026-11-26',
    request: '会议日期应为 2026-11-19，检查纪要中是否出现与会议日期矛盾的上次会议日期。',
    mustInclude: ['2026-11-26'],
    spec: {
      title: '项目周例会纪要',
      subtitle: '2026-11-19 · 客户数据平台二期',
      slides: [
        { title: '会议信息', bullets: ['会议时间：2026-11-19 14:00-15:00', '会议地点：3 号会议室', '主持：李经理', '记录：陈老师', '上次会议：2026-11-26'] },
        { title: '进度回顾', bullets: ['接口联调完成 80%，剩余 2 个接口待联调。', '数据迁移脚本已提交测试环境。'] },
        { title: '下一步', bullets: ['2026-11-25 前完成剩余接口联调（负责人：王工）。', '2026-11-21 提交上线方案（负责人：陈老师）。'] },
        { title: '风险', bullets: ['第三方短信通道额度不足，已提交扩容申请。'] },
      ],
    },
  },
  {
    id: 'date-2',
    kind: 'plan',
    kindLabel: '项目计划',
    format: 'docx',
    defectType: 'date',
    defectLabel: '日期矛盾',
    expectedKeyword: ['日期', '矛盾', '2026-11-20', '完成'],
    expectedFinding: '项目开始日期是 2026-12-01，但计划完成日期写成更早的 2026-11-20',
    request: '项目完成日期应晚于开始日期（开始为 2026-12-01），检查日期是否矛盾。',
    mustInclude: ['项目计划完成日期：2026-11-20'],
    spec: {
      title: '客户数据平台二期实施计划',
      subtitle: '版本 V1.0 · 2026-11-18',
      sections: [
        { heading: '项目周期', paragraphs: ['项目开始日期：2026-12-01。', '项目计划完成日期：2026-11-20。'] },
        {
          heading: '里程碑',
          table: {
            headers: ['阶段', '交付物', '计划完成'],
            rows: [
              ['需求确认', '需求说明书', '2026-12-10'],
              ['开发联调', '测试报告', '2026-12-28'],
              ['上线验收', '验收单', '2027-01-15'],
            ],
          },
        },
        { heading: '资源与风险', paragraphs: ['开发投入 4 人，测试投入 1 人。', '主要风险：客户侧接口人变更导致联调延期。'] },
      ],
    },
  },
  {
    id: 'owner-1',
    kind: 'minutes',
    kindLabel: '会议纪要',
    format: 'docx',
    defectType: 'owner',
    defectLabel: '负责人缺失',
    expectedKeyword: ['负责人', '缺失', '行动项', '空白'],
    expectedFinding: '行动项“准备上线检查清单”的负责人列为空',
    request: '每个行动项都必须有负责人，检查行动项表格中是否有一项缺失负责人。',
    mustInclude: ['准备上线检查清单'],
    spec: {
      title: '上线评审会纪要',
      subtitle: '2026-11-18 10:00 · 客户数据平台二期',
      sections: [
        { heading: '会议信息', paragraphs: ['时间：2026-11-18 10:00-11:00', '地点：线上会议', '记录：陈老师'] },
        { heading: '评审结论', paragraphs: ['上线窗口定于 2026-11-27 22:00。', '灰度比例先 10%，观察 24 小时后再全量。'] },
        {
          heading: '行动项',
          table: {
            headers: ['事项', '负责人', '截止日期'],
            rows: [
              ['确认回滚方案', '王工', '2026-11-21'],
              ['准备上线检查清单', '', '2026-11-22'],
              ['通知客户上线时间', '陈老师', '2026-11-20'],
            ],
          },
        },
        { heading: '其他', paragraphs: ['以上行动项在下次例会逐项确认完成情况。'] },
      ],
    },
  },
  {
    id: 'owner-2',
    kind: 'task',
    kindLabel: '任务清单',
    format: 'docx',
    defectType: 'owner',
    defectLabel: '负责人缺失',
    expectedKeyword: ['负责人', '缺失', '日志采集'],
    expectedFinding: '“日志采集接入”任务的负责人列为空',
    request: '任务清单中每项都必须有负责人，检查是否有任务缺失负责人。',
    mustInclude: ['日志采集接入'],
    spec: {
      title: 'Q4 系统运维任务清单',
      subtitle: '更新日期：2026-11-19',
      sections: [
        {
          heading: '任务清单',
          table: {
            headers: ['任务', '负责人', '截止日期', '状态'],
            rows: [
              ['数据库备份策略调整', '王工', '2026-11-22', '进行中'],
              ['日志采集接入', '', '2026-11-25', '未开始'],
              ['季度安全扫描', '陈老师', '2026-11-28', '未开始'],
            ],
          },
        },
        { heading: '说明', paragraphs: ['以上任务每周一晨会同步进度，逾期任务需在晨会上说明原因。'] },
      ],
    },
  },
  {
    id: 'unit-1',
    kind: 'contract',
    kindLabel: '合同',
    format: 'docx',
    defectType: 'unit',
    defectLabel: '单位错误',
    expectedKeyword: ['单位', '万元', '120 元', '大写'],
    expectedFinding: '合同金额写成“120 元”，但大写是“壹拾贰万元整”，单位错误',
    request: '合同金额单位应为万元，检查金额数字与大写是否一致（120 元 vs 壹拾贰万元）。',
    mustInclude: ['人民币 120 元（大写：壹拾贰万元整）'],
    spec: {
      title: '软件开发合同',
      subtitle: '合同编号：HX-RJ-2026-1112',
      sections: [
        { heading: '合同双方', paragraphs: ['甲方：华星科技有限公司', '乙方：远山数据服务有限公司'] },
        { heading: '开发内容', paragraphs: ['乙方为甲方开发客户数据管理平台，包含需求调研、开发、测试与上线支持。', '交付周期：自合同生效之日起 90 个自然日。'] },
        { heading: '合同价款', paragraphs: ['合同总价：人民币 120 元（大写：壹拾贰万元整）。', '该价格包含全部开发费用、税费及一年免费维护。'] },
        { heading: '支付方式', paragraphs: ['合同签订后支付 40%，验收通过后支付 60%。'] },
      ],
    },
  },
  {
    id: 'unit-2',
    kind: 'contract',
    kindLabel: '合同',
    format: 'docx',
    defectType: 'unit',
    defectLabel: '单位错误',
    expectedKeyword: ['单位', '大写', '万元', '壹拾贰元'],
    expectedFinding: '合同总价为 120 万元，但大写写成“壹拾贰元整”，大写金额单位错误',
    request: '合同总价为 120 万元，大写应为“壹佰贰拾万元整”，检查大写金额是否漏写“万”单位。',
    mustInclude: ['壹拾贰元整'],
    spec: {
      title: '数据运维服务合同',
      subtitle: '合同编号：HX-YW-2026-1117',
      sections: [
        { heading: '合同双方', paragraphs: ['甲方：华星科技有限公司', '乙方：远山数据服务有限公司'] },
        { heading: '服务内容', paragraphs: ['乙方为甲方提供客户数据平台 7×24 小时运维与季度巡检服务。', '服务期：2027-01-01 至 2027-12-31。'] },
        { heading: '合同价款', paragraphs: ['合同总价：人民币 120 万元（大写：壹拾贰元整）。', '该价格包含全年运维人力、监控工具及季度巡检费用。'] },
        { heading: '付款方式', paragraphs: ['按季度支付，每季度支付人民币 30 万元。'] },
      ],
    },
  },
  {
    id: 'missing_total-1',
    kind: 'quote',
    kindLabel: '报价单',
    format: 'docx',
    defectType: 'missing_total',
    defectLabel: '缺合计行',
    expectedKeyword: ['合计', '缺失', '76,000', '76000'],
    expectedFinding: '报价明细只有 3 个分项，没有合计行（应为 15,000 + 45,000 + 16,000 = 76,000）',
    request: '报价单必须有合计行，请检查是否缺失合计及其金额（应为 76,000 元）。',
    mustInclude: ['16,000'],
    mustExclude: ['合计'],
    spec: {
      title: '数据迁移服务报价单',
      subtitle: '报价编号：BJ-2026-1115',
      sections: [
        { heading: '客户信息', paragraphs: ['客户：华星科技有限公司', '项目：历史数据迁移与校验'] },
        {
          heading: '报价明细',
          table: {
            headers: ['项目', '数量', '单价（元）', '小计（元）'],
            rows: [
              ['数据梳理', '1', '15,000', '15,000'],
              ['迁移脚本开发', '1', '45,000', '45,000'],
              ['迁移演练', '2', '8,000', '16,000'],
            ],
          },
        },
        { heading: '付款方式', paragraphs: ['预付 50%，验收通过后支付 50%。'] },
        { heading: '有效期', paragraphs: ['报价有效期至 2026-12-20。'] },
      ],
    },
  },
  {
    id: 'missing_total-2',
    kind: 'budget',
    kindLabel: '预算表',
    format: 'xlsx',
    defectType: 'missing_total',
    defectLabel: '缺合计行',
    expectedKeyword: ['合计', '缺失', '103,000', '103000'],
    expectedFinding: '活动预算只有 3 行明细，没有合计行（应为 60,000 + 25,000 + 18,000 = 103,000）',
    request: '预算表必须有合计行，请检查是否缺失合计及金额（应为 103,000 元）。',
    mustInclude: ['18000'],
    mustExclude: ['合计'],
    spec: {
      sheet: '活动预算',
      freezeHeader: true,
      columns: [
        { header: '科目', key: 'item', width: 18 },
        { header: '金额（元）', key: 'amount', width: 16 },
        { header: '备注', key: 'note', width: 26 },
      ],
      rows: [
        { item: '场地租赁', amount: 60000, note: '3 天' },
        { item: '设备租赁', amount: 25000, note: '音响与投影' },
        { item: '物料制作', amount: 18000, note: '背景板与手册' },
      ],
    },
  },
  {
    id: 'percent-1',
    kind: 'weekly',
    kindLabel: '周报',
    format: 'docx',
    defectType: 'percent',
    defectLabel: '百分比错误',
    expectedKeyword: ['完成率', '80%', '百分比', '60%'],
    expectedFinding: '接口联调完成率写 60%，但 32/40 应为 80%',
    request: '接口联调完成率应为 80%（32/40），检查百分比计算是否正确。',
    mustInclude: ['60%'],
    spec: {
      title: '项目周报（2026-11-09 至 2026-11-15）',
      subtitle: '客户数据平台二期 · 项目经理：李经理',
      sections: [
        { heading: '本周进展', bullets: ['完成接口联调 8 个，累计完成 32/40。', '修复线上缺陷 12 个，遗留 3 个。', '更新部署文档 10 篇，全部评审通过。'] },
        {
          heading: '关键指标',
          table: {
            headers: ['指标', '目标', '本周', '完成率'],
            rows: [
              ['接口联调', '40 个', '32 个', '60%'],
              ['缺陷修复', '15 个', '12 个', '80%'],
              ['文档更新', '10 篇', '10 篇', '100%'],
            ],
          },
        },
        { heading: '下周计划', bullets: ['完成剩余 8 个接口联调。', '组织上线评审会。'] },
      ],
    },
  },
  {
    id: 'percent-2',
    kind: 'kpi',
    kindLabel: 'KPI 表',
    format: 'xlsx',
    defectType: 'percent',
    defectLabel: '百分比错误',
    expectedKeyword: ['执行率', '55%', '百分比', '45%'],
    expectedFinding: '市场推广执行率写 45%，但 66/120 应为 55%',
    request: '市场推广预算执行率应为 55%（66/120），检查百分比是否错误。',
    mustInclude: ['45%'],
    spec: {
      sheet: 'Q4 预算执行',
      freezeHeader: true,
      columns: [
        { header: '指标', key: 'item', width: 16 },
        { header: '年度预算（万元）', key: 'budget', width: 20 },
        { header: '已使用（万元）', key: 'used', width: 18 },
        { header: '执行率', key: 'rate', width: 12 },
      ],
      rows: [
        { item: '市场推广', budget: 120, used: 66, rate: '45%' },
        { item: '差旅', budget: 60, used: 30, rate: '50%' },
        { item: '培训', budget: 20, used: 16, rate: '80%' },
        { item: '合计', budget: 200, used: 112, rate: '56%' },
      ],
    },
  },
  {
    id: 'duplicate-1',
    kind: 'statement',
    kindLabel: '对账单',
    format: 'docx',
    defectType: 'duplicate',
    defectLabel: '重复客户行',
    expectedKeyword: ['重复', '客户', '华星', 'HX-2026-001'],
    expectedFinding: '同一客户同一合同（华星科技 / HX-2026-001）在对账单中出现两次',
    request: '同一客户同一合同不应重复列示，检查对账单是否有重复客户行。',
    mustInclude: ['HX-2026-001'],
    spec: {
      title: '11 月客户对账单',
      subtitle: '对账期间：2026-11-01 至 2026-11-30',
      sections: [
        {
          heading: '对账明细',
          table: {
            headers: ['客户', '合同编号', '应收（元）', '已收（元）', '余额（元）'],
            rows: [
              ['华星科技有限公司', 'HX-2026-001', '120,000', '120,000', '0'],
              ['远山制造有限公司', 'YS-2026-014', '80,000', '40,000', '40,000'],
              ['华星科技有限公司', 'HX-2026-001', '120,000', '60,000', '60,000'],
              ['合计', '', '320,000', '220,000', '100,000'],
            ],
          },
        },
        { heading: '说明', paragraphs: ['上表余额为截至 2026-11-30 的未收金额。', '如有异议，请在 3 个工作日内回复。'] },
      ],
    },
  },
  {
    id: 'duplicate-2',
    kind: 'receivables',
    kindLabel: '回款台账',
    format: 'xlsx',
    defectType: 'duplicate',
    defectLabel: '重复客户行',
    expectedKeyword: ['重复', '客户', '华星', 'HX-2026-001'],
    expectedFinding: '同一客户同一合同（华星科技 / HX-2026-001）在回款台账中出现两次',
    request: '台账中同一客户同一合同不应重复出现，检查是否有重复客户行。',
    mustInclude: ['HX-2026-001'],
    spec: {
      sheet: '回款台账',
      freezeHeader: true,
      columns: [
        { header: '客户', key: 'client', width: 22 },
        { header: '合同编号', key: 'contract', width: 16 },
        { header: '合同金额（元）', key: 'amount', width: 16 },
        { header: '已回款（元）', key: 'received', width: 14 },
        { header: '回款日期', key: 'date', width: 14 },
      ],
      rows: [
        { client: '华星科技有限公司', contract: 'HX-2026-001', amount: 120000, received: 120000, date: '2026-11-10' },
        { client: '远山制造有限公司', contract: 'YS-2026-014', amount: 80000, received: 40000, date: '2026-11-12' },
        { client: '华星科技有限公司', contract: 'HX-2026-001', amount: 120000, received: 60000, date: '2026-11-14' },
        { client: '合计', contract: '', amount: 320000, received: 220000, date: '' },
      ],
    },
  },
  {
    id: 'contradiction-1',
    kind: 'contract',
    kindLabel: '合同',
    format: 'docx',
    defectType: 'contradiction',
    defectLabel: '金额/日期与正文矛盾',
    expectedKeyword: ['首付', '48', '矛盾', '付款'],
    expectedFinding: '合同总价 120 万元，首付款 40% 应为 48 万元，但写成 60 万元',
    request: '首付款应为合同总价的 40%（即 48 万元），检查金额与正文是否矛盾。',
    mustInclude: ['即人民币 60 万元'],
    spec: {
      title: '技术开发合同',
      subtitle: '合同编号：HX-JS-2026-1106',
      sections: [
        { heading: '合同双方', paragraphs: ['甲方：华星科技有限公司', '乙方：远山数据服务有限公司'] },
        { heading: '合同价款', paragraphs: ['合同总价为人民币 120 万元（含税）。', '该价格包含需求调研、开发、测试与上线支持。'] },
        { heading: '付款方式', paragraphs: ['合同签订后 5 个工作日内，甲方支付合同总价的 40%，即人民币 60 万元；验收通过后支付剩余 60%。'] },
        { heading: '交付与验收', paragraphs: ['乙方应于 2027-01-31 前完成全部交付。', '验收以双方签署的验收单为准。'] },
      ],
    },
  },
  {
    id: 'contradiction-2',
    kind: 'confirmation',
    kindLabel: '验收确认单',
    format: 'docx',
    defectType: 'contradiction',
    defectLabel: '金额/日期与正文矛盾',
    expectedKeyword: ['矛盾', '2026-11-20', '2026-12-15', '验收日期', '交付日期'],
    expectedFinding: '正文验收日期为 2026-11-20，但平台主体交付日期为 2026-12-15，验收早于交付',
    request: '正文记载验收日期为 2026-11-20，交付清单中平台主体的交付日期为 2026-12-15（晚于验收日期）。请检查验收日期与交付日期是否矛盾。',
    mustInclude: ['验收日期：2026-11-20'],
    spec: {
      title: '客户数据平台二期验收确认单',
      subtitle: '合同编号：HX-2026-001 · 确认日期：2026-11-22',
      sections: [
        { heading: '项目信息', paragraphs: ['项目名称：客户数据平台二期', '验收日期：2026-11-20。', '验收结论：通过。'] },
        {
          heading: '交付清单',
          table: {
            headers: ['交付物', '版本', '交付日期'],
            rows: [
              ['客户数据平台二期（含部署包、说明文档）', 'V2.0', '2026-12-15'],
              ['数据库迁移脚本', 'V1.3', '2026-11-18'],
              ['上线操作手册', 'V1.0', '2026-11-19'],
            ],
          },
        },
        { heading: '确认意见', paragraphs: ['验收范围覆盖合同约定的全部功能。', '最终验收以验收单签署日期为准。'] },
      ],
    },
  },
]

const BUILDERS = { docx: buildDocx, xlsx: buildXlsx, pptx: buildPptx }

function parseArgs(argv) {
  const opts = { dryRun: false, keep: false, help: false, json: undefined, limit: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--keep') opts.keep = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--json') opts.json = argv[++i]
    else if (arg.startsWith('--json=')) opts.json = arg.slice('--json='.length)
    else if (arg === '--limit') opts.limit = Number(argv[++i])
    else if (arg.startsWith('--limit=')) opts.limit = Number(arg.slice('--limit='.length))
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function help() {
  console.log(`用法: node eval/run-office-real.mjs [--dry-run] [--keep] [--limit N] [--json <path>]

  --dry-run   只生成 20 份文档与 manifest（不调用模型；无 key 时自动生效）
  --keep      保留临时生成目录（默认结束后删除）
  --limit N   只跑前 N 例；也可用环境变量 LIMIT（默认 20）
  --json P    额外把 JSON 汇总写到 P

真实审阅需要 DEEPSEEK_API_KEY 或 ADVISERS_API_KEY。文档为 realistic synthetic，
不是真实客户文档，不得用于对外 benchmark 宣称。`)
}

async function generate(manifestEntries, docsDir) {
  await mkdir(docsDir, { recursive: true })
  for (const item of manifestEntries) {
    const buffer = await BUILDERS[item.format](item.spec)
    await writeFile(join(docsDir, item.file), buffer)
    const doc = await readOffice(buffer)
    const text = officeToText(doc, 20_000)
    const missing = (item.mustInclude || []).filter((needle) => !text.includes(needle))
    const leaked = (item.mustExclude || []).filter((needle) => text.includes(needle))
    if (missing.length || leaked.length) {
      throw new Error(`${item.id}: generated document failed offline self-check (missing=${JSON.stringify(missing)}, leaked=${JSON.stringify(leaked)})`)
    }
    item.path = join(docsDir, item.file)
    item.bytes = buffer.length
    item.textChars = text.length
    item.selfCheck = 'ok'
  }
}

function printManifest(entries, docsDir) {
  console.log(`\n[manifest] 生成 ${entries.length} 份 realistic synthetic 文档到：${docsDir}`)
  console.log('[manifest] 声明：合成文档，不是真实客户文档；仅限内部回归，不得用于对外 benchmark 宣称。')
  const idWidth = Math.max(5, ...entries.map((e) => e.id.length))
  const kindWidth = Math.max(4, ...entries.map((e) => `${e.format}/${e.kind}`.length))
  const defectWidth = Math.max(6, ...entries.map((e) => e.defectType.length))
  for (const e of entries) console.log(`  ${e.id.padEnd(idWidth)}  ${`${e.format}/${e.kind}`.padEnd(kindWidth)}  ${e.defectType.padEnd(defectWidth)}  ${String(e.bytes).padStart(6)}B  ${e.file}`)
  const byFormat = countBy(entries, (e) => e.format)
  const byDefect = countBy(entries, (e) => e.defectType)
  console.log(`[manifest] 格式分布: ${JSON.stringify(byFormat)}`)
  console.log(`[manifest] 缺陷分布: ${JSON.stringify(byDefect)}`)
}

function countBy(items, fn) {
  const out = {}
  for (const item of items) {
    const key = fn(item)
    out[key] = (out[key] || 0) + 1
  }
  return out
}

function parseReviewOutput(stdout, stderr) {
  const lines = String(stdout || '').split(/\r?\n/)
  const findings = []
  let summaryLine = ''
  for (const line of lines) {
    const match = line.match(/^\[(blocker|warn)\]\s*(.*)$/)
    if (match) {
      let message = match[2].trim()
      let evidence
      const marker = message.lastIndexOf('（原文：')
      if (marker !== -1 && message.endsWith('）')) {
        evidence = message.slice(marker + '（原文：'.length, -1)
        message = message.slice(0, marker).trim()
      }
      findings.push({ severity: match[1], message, evidence })
    } else if (line.trim() && !summaryLine) {
      summaryLine = line.trim()
    }
  }
  return {
    findings,
    blocker: findings.some((f) => f.severity === 'blocker'),
    summary: summaryLine,
    invalidJson: /review output was not valid JSON/i.test(String(stderr || '')),
  }
}

function classifyReview(item, raw, parsed) {
  const common = {
    exitCode: raw.exitCode,
    timedOut: raw.timedOut,
    blocker: parsed.blocker,
    keywordMatched: item.expectedKeyword.some((kw) => `${raw.stdout}\n${raw.stderr}`.includes(kw)),
    summary: parsed.summary,
    findings: parsed.findings,
  }
  if (raw.timedOut) return { ...common, status: 'ERROR', reason: `timeout after ${raw.timeoutMs}ms` }
  if (parsed.blocker) return { ...common, status: 'PASS' }
  if (parsed.invalidJson) return { ...common, status: 'ERROR', reason: 'review output was not valid JSON' }
  if (raw.exitCode === 0) return { ...common, status: 'FAIL', reason: 'no blocker reported' }
  const detail = String(raw.stderr || '').split(/\r?\n/).filter(Boolean).join(' | ').slice(0, 500)
  return { ...common, status: 'ERROR', reason: `unexpected exit ${raw.exitCode}${detail ? `: ${detail}` : ''}` }
}

function runCliReview({ file, request, apiKey, homeDir, timeoutMs }) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI_PATH, 'review', file, '--request', request],
      {
        env: {
          ...process.env,
          ADVISERS_HOME: homeDir,
          ADVISERS_API_KEY: apiKey,
          ADVISERS_OFFICE_LOCAL: '1',
          ADVISERS_CORE_LOCAL: '1',
        },
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : -1) : 0
        resolvePromise({
          exitCode,
          timedOut: Boolean(error && error.killed),
          timeoutMs,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        })
      },
    )
  })
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function formatFindings(findings, max = 3) {
  if (!findings.length) return '(none)'
  return findings.slice(0, max).map((f) => `[${f.severity}] ${f.message}`).join(' ; ')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { help(); return }

  const total = CASES.length
  const limited = opts.limit ?? Number(process.env.LIMIT || total)
  if (!Number.isInteger(limited) || limited < 1 || limited > total) throw new Error(`limit must be an integer between 1 and ${total} (got ${opts.limit ?? process.env.LIMIT})`)
  const selected = CASES.slice(0, limited)

  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ADVISERS_API_KEY
  const dryRun = opts.dryRun || !apiKey
  if (!opts.dryRun && !apiKey) console.error('[info] 未检测到 DEEPSEEK_API_KEY / ADVISERS_API_KEY，自动进入 --dry-run（只生成文档，不调用模型）。')

  const startedAt = new Date().toISOString()
  const tmpRoot = await mkdtemp(join(tmpdir(), 'advisers-office-real-'))
  const docsDir = join(tmpRoot, 'docs')
  const homesDir = join(tmpRoot, 'homes')
  let exitCode = 0
  try {
    const entries = selected.map((item) => ({
      id: item.id,
      kind: item.kind,
      kindLabel: item.kindLabel,
      format: item.format,
      defectType: item.defectType,
      defectLabel: item.defectLabel,
      file: `${item.id}.${item.format}`,
      path: undefined,
      bytes: 0,
      textChars: 0,
      selfCheck: 'pending',
      expectedKeyword: item.expectedKeyword,
      expectedFinding: item.expectedFinding,
      request: item.request,
      mustInclude: item.mustInclude,
      mustExclude: item.mustExclude || [],
      spec: item.spec,
    }))
    await generate(entries, docsDir)
    printManifest(entries, docsDir)

    if (dryRun) {
      console.log('\n[dry-run] 未调用真实模型；以上即文档清单与 manifest。')
      const drySummary = {
        mode: 'dry-run',
        startedAt,
        disclaimer: DISCLAIMER,
        docsDir,
        cases: entries.length,
        limit: limited,
        byFormat: countBy(entries, (e) => e.format),
        byDefectType: countBy(entries, (e) => e.defectType),
        manifest: entries.map(({ spec, mustInclude, mustExclude, ...rest }) => rest),
      }
      console.log(JSON.stringify(drySummary, null, 2))
      if (opts.json) {
        await writeFile(resolve(opts.json), `${JSON.stringify(drySummary, null, 2)}\n`)
        console.error(`[dry-run] JSON 汇总已写入 ${resolve(opts.json)}`)
      }
      return
    }

    await mkdir(homesDir, { recursive: true })
    const concurrency = Math.max(1, Math.min(Number(process.env.CONCURRENCY || 3) || 3, entries.length))
    console.error(`[run] 真实模型审阅 ${entries.length} 例（CLI: ${CLI_PATH}，超时 ${REVIEW_TIMEOUT_MS}ms，并发 ${concurrency}）`)
    const results = await mapLimit(entries, concurrency, async (entry) => {
      const homeDir = join(homesDir, entry.id)
      await mkdir(homeDir, { recursive: true })
      const caseStarted = Date.now()
      const raw = await runCliReview({ file: entry.path, request: entry.request, apiKey, homeDir, timeoutMs: REVIEW_TIMEOUT_MS })
      const parsed = parseReviewOutput(raw.stdout, raw.stderr)
      const result = {
        id: entry.id,
        kind: entry.kind,
        kindLabel: entry.kindLabel,
        format: entry.format,
        defectType: entry.defectType,
        defectLabel: entry.defectLabel,
        file: entry.file,
        path: entry.path,
        expectedKeyword: entry.expectedKeyword,
        expectedFinding: entry.expectedFinding,
        request: entry.request,
        durationMs: Date.now() - caseStarted,
        ...classifyReview(entry, raw, parsed),
      }
      console.error(`${result.status} ${result.id} [${result.format}/${result.kind}] blocker=${result.blocker ? 'yes' : 'no'} keyword=${result.keywordMatched ? 'yes' : 'no'} findings: ${formatFindings(result.findings)}`)
      return result
    })

    const passed = results.filter((r) => r.status === 'PASS').length
    const failed = results.filter((r) => r.status === 'FAIL').length
    const errors = results.filter((r) => r.status === 'ERROR').length
    const byDefectType = {}
    for (const type of DEFECT_TYPES.map(([key]) => key)) {
      const rows = results.filter((r) => r.defectType === type)
      if (!rows.length) continue
      byDefectType[type] = { total: rows.length, passed: rows.filter((r) => r.status === 'PASS').length }
    }
    const summary = {
      mode: 'real-model',
      startedAt,
      finishedAt: new Date().toISOString(),
      disclaimer: DISCLAIMER,
      reviewCommand: 'advisers review <file> --request "..."',
      timeoutMs: REVIEW_TIMEOUT_MS,
      limit: limited,
      cases: results.length,
      passed,
      failed,
      errors,
      blockers: results.filter((r) => r.blocker).length,
      keywordMatched: results.filter((r) => r.keywordMatched).length,
      byFormat: countBy(results, (r) => r.format),
      byDefectType,
      failures: results.filter((r) => r.status !== 'PASS').map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        expectedFinding: r.expectedFinding,
        findings: r.findings,
      })),
      results,
    }
    console.log(JSON.stringify(summary, null, 2))
    if (opts.json) {
      await writeFile(resolve(opts.json), `${JSON.stringify(summary, null, 2)}\n`)
      console.error(`[run] JSON 汇总已写入 ${resolve(opts.json)}`)
    }
    if (failed || errors) exitCode = 1
  } finally {
    if (opts.keep) console.error(`[cleanup] 保留临时目录：${tmpRoot}`)
    else {
      await rm(tmpRoot, { recursive: true, force: true })
      console.error(`[cleanup] 已删除临时目录：${tmpRoot}`)
    }
  }
  if (exitCode) process.exitCode = exitCode
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[fatal] ${error?.stack || error}`)
    process.exitCode = 1
  })
}

export { CASES, DEFECT_TYPES, classifyReview, parseReviewOutput }
