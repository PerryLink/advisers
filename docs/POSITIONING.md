# Positioning (2026-11-14, post-competitive-verification)

## One line

**给技术型独立顾问的本地可审计承诺账 + 中文 Office 交付引擎。**

- 本地数据面：SQLite 在本机，核心功能不需要任何云账号；默认不出网。
- 承诺账：who owes whom / due / evidence / 人工 accept / 回执；不是 TODO 清单。
- 中文承诺语义：中文抽取 + Asia/Shanghai 相对日期解析；不是“界面上有中文”。
- Office 交付：DOCX/XLSX/PPTX + `verify --content` + `deliveries/receipt` + 证据包；
  不是“能生成文件”而已。
- CLI 是产品本体；DSH 是薄适配器。

## What the 2026 market already commoditized (do not claim as moat)

- 邮件/日历/AI 行动项：Gemini in Gmail、Copilot in Outlook、Fyxer Spaces、Superhuman.
- Office/PDF generation：Claude Cowork/Claude Code built-in skills、Copilot、飞书/WPS.
- 会议转写/行动项：Otter/Fireflies/Granola/Fathom/飞书妙记.
- 提醒：Todoist/滴答/Motion/飞书 aily/Kimi.
- CLI 入口：飞书 CLI（MIT, 18 domains, individual developer path）、钉钉 CLI
  (Apache-2.0)、企微 CLI+MCP（10 人以下也可用）、石墨/FlowUs.
- “开源/本地”本身：OpenClaw/Ollama+Open WebUI/Khoj/Jan/LM Studio.

## What is actually defensible

1. **承诺账语义**：没有竞品做 who-owes-whom + due + external evidence + 人工 accept
   + receipt 的一等对象；Fyxer Spaces 最接近，但云/英文/无本地审计/无 Office 验收。
2. **本地可自证**：`advisers privacy --prove` + hash-chain audit + secret matter
   fail-closed + 文件写入边界；Cowork 全云执行，Claude/OpenClaw 也不是本地账本。
3. **可验收交付**：`verify --content` + `deliveries --pack`（SHA256SUMS + DOCX
   receipt）；竞品能产文件，但不给确定性校验/回执。
4. **中文承诺质量**：唯一做中文承诺/相对日期/交付验收的产品；但**必须用独立人工
   金标证明**，不能把“界面中文”当护城河。

## Say / don't say

| Say | Don't say |
|---|---|
| 本地数据面、默认不出网、核心无需云账号 | “完全离线/数据绝对不出机”（模型调用在云） |
| 单机零租户、可审计、可迁移 | “零租户 CLI”（飞书个人开发者/钉钉开源/企微小团队已填平） |
| 承诺账 + 证据包 + 可验收交付 | “全能 AI 秘书/聊天助理” |
| 中文承诺语义（待独立金标） | “中文护城河/中文界面唯一” |
| 能产 + 能验收 Office | “竞品不能产 Office” |
| 轻量义务跟踪 + 导出/对接 | “轻量 CLM” |

## Explicit non-goals

完整 CLM/e-sign/CA 牌照；AI 硬件/常驻录音/屏幕全量记忆；插件市场军备；团队/SSO/
私有化；全功能 GUI/移动 App；自动代发/自动改期；通用聊天/情感陪伴；coding-agent
全能竞赛。理由见 `01-research/advisers-competitive-2026-11-14/99-SYNTHESIS.md` §8。

## Pricing / channel (research recommendation, not a commitment)

MIT core free; optional local pro/support subscription at a personal price point
(roughly $10–40/month), not per-seat enterprise. Channel: independent-consultant
communities, open source, DSH/agent ecosystem; make `.ics` reminders and evidence
packs the customer-visible artifacts.
