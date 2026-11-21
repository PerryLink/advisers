# 隐私与数据流说明（Privacy & Data-Flow Notice）

| 项目 | 内容 |
|---|---|
| 文档版本 | 2026.11.4（与 docs/TOS.md 同版本） |
| 生效日期 | 2026-11-21 |
| 适用对象 | Advisers 用户、部署者与集成方 |
| 运营者 | PerryLink（本项目维护者，GitHub: https://github.com/PerryLink）；联系与投诉渠道见第 12 节 |
| 语言效力 | 中文版为准；翻译仅供参考 |
| 性质 | 本说明不是《个人信息保护法》第 17 条意义上由运营者作出的个人信息处理规则——**运营者不通过本软件处理你的个人信息**；它是数据流、第三方处理与你的合规义务说明。 |
| 完整性校验 | 本文件正文的 SHA-256 由 packages/advisers/lib/tos/manifest.json 记录，并由 scripts/check-tos.mjs 在本地/CI 校验；随 npm 包分发于 packages/advisers/lib/tos/privacy.zh-CN.md。 |

## 1. 一句话结论

Advisers 默认在本机运行：**没有账号、没有遥测、没有云服务、没有运营者服务器、没有自动更新检查**。你的数据默认保存在你的设备上；**邮件、知识库与回款/支付记录默认只在本机处理**，交互式壳的输入历史仅保存在进程内存。只有在你主动启用模型、邮件同步、邮件正文模型抽取（显式 opt-in + 单独同意）、网页研究、通知、同步、桥接（bridge/Hermes 文件网关）、MCP/DSH/桌宠等能力时，相关内容才会发送给你配置的第三方服务商，受其条款与隐私政策约束。

## 2. 运营者的角色

2.1 运营者是本软件的发布者。**运营者不接收、不存储、不访问**你在本机账本、对话、附件、邮件、知识库、回款/支付记录、模型出网同意记录、邮件凭据、日历、研究记录、审计链与导出物中的任何数据；本软件不向你收集个人信息。

2.2 因此，运营者不是本软件运行中产生的个人信息的处理者；《个人信息保护法》第 17 条（告知）、第 21 条（委托处理）、第 23 条（向第三方提供）、第 31 条（未满 14 周岁）、第 38/39 条（跨境）等条款中针对“个人信息处理者”的义务，不因本软件的本地运行而由运营者承担。

2.3 例外：如果你主动通过 GitHub issue、邮件或其他渠道向维护者提交信息（例如错误日志、截图），该信息由相应平台与维护者仅为沟通、缺陷修复与安全响应目的处理；请勿提交客户数据、身份证号、手机号、合同正文或其他人的个人信息。我们会在不需要时删除或关闭相关 issue，但第三方平台的留存受其自身政策约束。公开仓库内容由平台运营方存储与处理，可能涉及跨境存储；如你不愿该等信息出境，请改用非公开渠道。

2.4 如果未来 Advisers 提供账号、云同步、遥测或其他由运营者控制的服务，运营者将成为相应个人信息处理者，并在上线前另行发布个人信息处理规则、取得必要同意、完成影响评估与跨境合规。

## 3. 本地数据清单

默认位置：`ADVISERS_HOME`（未设置时为 `~/.advisers`）；目录权限 0700，主要文件 0600（Windows 上由用户目录权限与 NTFS ACL 保护）。`ADVISERS_STORE=json` 时使用 `state.json` 回退存储。本版本（v2026.11.4）新增的表（`mail_*`、`kb_*`、`receivables`、`payments`）与既有表一样**默认明文**；`export --all`（按数据表清单导出）与 `backup`/`sync`（整库副本）会携带这些表，加密仅由 vault/export/sync 的可选加密提供。

| 数据类别 | 位置/表 | 用途 | 默认保留 | 你的控制方式 |
|---|---|---|---|---|
| 事项、参与人、事实、承诺、偏好、证据引用 | `state.db`（matters/facts/commitments/preferences 等） | 工作秘书的三本账 | 直到你删除 | `ls`/`memory`/`purge`/`forget` |
| 对话与摘要 | `turns`/`session_summaries`/`summary_versions` | 上下文、搜索、回顾 | 直到你删除 | `history`/`search`/`purge` |
| 研究记录 | `research_runs` | 引用与回顾 | 直到你删除 | `purge`（仅事项关联）/手动 |
| 模型调用元数据 | `model_calls` | 用量/成本/诊断（不含 prompt 正文） | 直到你删除 | `purge`/手动 |
| 邮件账号/同步状态 | `mail_accounts`/`mail_cursors`/`mail_sync_runs` | IMAP 只读账号元数据、同步游标与同步记录（**不含密码**） | 直到删除账号 | `mail account remove`/手动 |
| 邮件正文与元数据 | `mail_messages` | 本地规则抽取候选与回顾（正文、主题、发件人、附件元数据、正文哈希） | 正文默认 30 天（`retention_days` 可调；`mail purge` 清正文、留元数据与正文哈希；存在待处理候选时跳过） | `mail purge`/`mail dismiss`/`mail account remove` |
| 知识库文档与抽取文本 | `kb_documents`/`kb_chunks`/`kb_pages`/`kb_fact_links` 及 FTS 派生索引 | 本地知识库检索与确定性编译页 | 直到你删除 | `kb rm`（不可检索、留墓碑）/`kb purge --yes`（物理删）；**抽取文本明文入库、原文件不复制** |
| 日历 | `calendar_events` | 只读导入的日程 | 直到你删除 | 手动删除 `state.db` 或后续 `calendar` 命令 |
| 审计 | `audit`（HMAC 哈希链） | 检测自身记录被改写；不是第三方存证 | **不自动删除**；删行会断链 | `audit` 校验；如需重置需整体重置并自行承担可验证性损失 |
| 审计密钥 | `audit.key`（0600） | 审计链 HMAC | 直到你删除 | 手动 |
| 人格/配置 | `soul.md` 等（0600） | 设定与偏好 | 直到你删除 | `soul` 命令/手动 |
| 撤销备份 | `undo/<stamp>/file` | 覆盖前文件副本 | 无自动清理 | 手动删除 `~/.advisers/undo` |
| 迁移/同步/导入备份 | `state.db.before-migrate-*`、`state.db.before-sync-*`、`state.db.before-unseal-*`、`import-backup-*.db` | 迁移/替换前整库副本 | **无自动清理** | 手动删除（注意：含全部个人信息） |
| 加密库 | `state.db.vault` | `vault seal` 后的 AES-256-GCM 整库 | 直到你 unseal/删除 | `vault` 命令 |
| 同步快照 | 你指定目录中的 `advisers-<device>-<UTC>.enc.json` | 加密整库快照 | 无自动轮转 | 手动删除；建议定期轮转 |
| 导出物 | 你指定的 `--out` 或 stdout | 账本/对话/审计导出 | 无自动清理 | 使用 `--encrypted`；妥善保管 |
| 交付/回执 | 你指定的 out 目录 | 交付文件副本、回执、证据引用 | 无自动清理 | 对外交付前脱敏；接收方另行处理 |
| 提醒/日志 | `reminders.log`、scheduler 脚本 | 提醒与调度 | 无自动清理 | 手动 |
| 晨报归档 | `briefs/<localDay>.md`、`briefs/latest.md`（0600、目录 0700） | 晨报本地归档 | 默认 14 天（`--keep` 可调） | `--keep`/手动删除；`vault seal` 不加密该目录 |
| Pet Brief | `pet-brief.json` | 桌宠只读投影 | 覆盖/删除 | `pet-brief` 命令/手动 |
| 回款与支付 | `receivables`/`payments` | 内部记账辅助（金额、币种、日期、方式、备注、客户/事项关联） | 直到你作废/删除（`void` 为墓碑，不物理删除） | `receivable void`/`payment void`；**事项 purge 不删除客户域钱行** |
| 模型出网同意 | `consent.json`（0600、原子写） | 记录 surface/数据类别/服务商/端点/时间/渠道/撤回；与接受 TOS 的记录分开 | 直到撤回或删除 | `consent status`/`consent revoke`；更换 provider/baseURL 后失效 |
| 邮件凭据 | `credentials/imap/<account>.json`（0600、目录 0700、原子写） | `mail sync` 连接你配置的 IMAP 服务器 | 直到删除账号 | `mail account remove`；**不进数据库/导出/备份/同步/日志/命令行参数**；Windows 上 0600 由用户目录 ACL 尽力而为 |
| TUI 交互历史 | 仅进程内存（默认 ≤200 条） | 交互式壳的上下键历史 | 进程退出即消失、默认不落盘 | 无文件可删；终端 scrollback/截屏由你控制 |

**加密状态（重要）**：默认数据库**不加密**（明文 SQLite，含邮件正文、知识库抽取文本与回款/支付记录）。`advisers vault`、`advisers export --encrypted`、`advisers sync` 提供可选的 AES-256-GCM + scrypt 加密；口令只从环境变量读取，不写入磁盘、不写入日志；**口令丢失后数据不可恢复**。vault 不透明（sealed 时正常命令无库）、不防运行中进程或内存取证，也不是安全擦除工具。

## 4. 会出网的情形（完整清单）

除下表外，本软件**不会出网**；无遥测、无自动更新检查、无运营者端点。所有第三方接收方均由你配置或选择；运营者不控制其处理。第 11 行的 bridge 是**在 bridge 进程运行期间按轮询间隔持续工作**的通道：本软件只与你指定的本机目录交换 JSON 文件，不直接联网；对外发送由你的 Hermes 进程及其接入的消息平台完成。

| # | 功能 | 触发方式 | 接收方 | 发送/接收的数据 | 默认 | 你的控制 |
|---|---|---|---|---|---|---|
| 1 | 模型调用 | 设置 `ADVISERS_API_KEY` 后：`chat`、`capture`、`review`、`brief --deep`、`learn review` 及其他模型类命令 | 默认 DeepSeek（`https://api.deepseek.com`）；可用 `ADVISERS_BASE_URL`/`ADVISERS_PROVIDER`/`ADVISERS_MODEL` 修改 | messages/prompt/tool 输出；agent 可能把工作目录中非受保护文件内容带入上下文；模型返回结果 | **关**（无 key 不出网） | 不设 key；更换 provider；受保护事项（secrecy>0）fail-closed |
| 2 | 网页研究 | `research --web` / `--url`（显式 flag） | 同上（服务商服务器端 web 工具） | 查询词/URL；取回网页结果与引用 | 关 | 不运行该命令；secrecy>0 拒绝 |
| 3 | 邮件同步 | `mail sync`（本版本起的 IMAP 网络入口）；旧入口 `capture --from-imap` | 你配置的 IMAP 服务器（默认 993 隐式 TLS，143 仅显式 STARTTLS，失败即拒绝、不回落明文；只读 EXAMINE/FETCH） | 账号/密码（保存在 0600 凭据文件，或 TTY 隐藏输入/`--pass-stdin`；不写数据库/导出/备份/同步/日志/命令行参数）+ 邮件正文、主题、发件人与附件元数据回传本机 | 关（未添加账号不运行） | 不运行该命令；删除账号即删凭据；正文默认 30 天 |
| 4 | 通知 webhook | `ADVISERS_NOTIFY_WEBHOOK`（或显式 url） | 你配置的 URL | **仅**提醒计数、级别、到期日期（不含标题、客户名、动作、证据、quote） | **关** | 不设置该变量；指向可信端点 |
| 5 | 自定义通知命令 | `ADVISERS_NOTIFY_CMD` | 你指定的本地命令 | 提醒标题/正文（由该命令处理） | 关 | 不设置；自行审查命令 |
| 6 | 同步 | `sync push`/`pull`/`status --dir <dir>` | 你指定的目录（可能被 OneDrive/Dropbox/Syncthing/rsync 复制） | 加密整库快照；文件名含设备名与 UTC 时间 | 关 | 选择可信目录；定期删除旧快照；口令单独保管 |
| 7 | DSH 宿主 | `dsh-advisers` 工具（brief/office/today/who/evidence 等） | 宿主的模型/工具管线 | 账本视图、brief、生成请求 | 取决于宿主配置 | 阅读 DSH 宿主的隐私说明；不要在宿主中处理客户敏感信息 |
| 8 | MCP 客户端 | `advisers mcp --stdio` | 连接它的 MCP 客户端（Claude Code/Cursor/Copilot Studio 等）及其模型服务商 | today/commitments/who/evidence 等工具结果 | 关（stdio、本地） | 选择可信客户端；其可能把结果发给云模型 |
| 9 | 桌宠消费端 | 读取 `pet-brief.json` | 桌宠应用（如 Pearl，默认关闭） | 脱敏投影（启发式脱敏，非 NER；secrecy≥2 排除） | 关 | 不在他人可见屏幕展示；关闭功能 |
| 10 | OCR/时间戳/外部命令 | `ADVISERS_OCR_CMD`、timestamp adapter、`ADVISERS_NOTIFY_CMD` | 你指定的外部程序 | 取决于该程序 | 关 | 自行审查；外部程序可能联网 |
| 11 | 桥接（bridge / Hermes 文件网关） | `advisers bridge --dir <目录>`（需另装并配置 Hermes bridge-adapter；该命令属受门控命令，需先接受当前 TOS） | 你配置的 Hermes 进程及其接入的消息平台（Telegram、飞书、企业微信、Slack、Discord、Email 等，取决于 Hermes 配置）；模型调用时还包括模型服务商（默认 DeepSeek） | **收**：inbox JSON（消息文本、发送者标识、会话/线程 ID、附件元数据、回复关系）→ 本机账本与模型调用上下文；**发**：outbox JSON（回复文本、附件引用、幂等键）以**明文**写回该目录，由 Hermes 交给其接入平台；目录 0700、文件 0600 | **关**（需你显式运行 `advisers bridge`；不运行时本软件不经此通道） | 不运行该命令；审查 Hermes 及其平台配置；**不要把 bridge 目录放在同步盘/共享盘**（会被 OneDrive/Dropbox/Syncthing 等复制）；受保护事项（secrecy>0）模型调用 fail-closed |
| 12 | 邮件正文模型抽取 | `mail extract --model`（显式 flag + 已设置 `ADVISERS_API_KEY` + 就 `mail.extract` 单独同意） | 默认 DeepSeek（`https://api.deepseek.com`）；可用 `ADVISERS_BASE_URL`/`ADVISERS_PROVIDER` 修改 | 邮件正文摘录（≤8KB、无附件、无完整 header；untrusted 包装 + 本地安全/脱敏检查）；审计只记 surface/数据类别/服务商/计数/哈希，不写正文 | **关**（默认 `mail extract --local` 为 0 网络、0 模型） | 不使用 `--model`；`consent revoke`；更换 provider/baseURL 后同意失效；受保护事项（secrecy>0）fail-closed |

**关于 bridge（第 11 行）**：bridge 只与本机指定目录交换 JSON 文件，不直接建立网络连接；实际对外发送由你的 Hermes 进程及其接入的平台完成，受 Hermes 与该平台条款约束。inbox 内容会进入本机账本，并可能作为模型调用上下文发送给模型服务商（与第 1 行同口径）；outbox 是**明文 JSON**（回复文本、附件引用、幂等键），目录按 0700、文件按 0600 创建，但若该目录位于同步盘、共享盘或被其他程序读取，其中的明面对话内容会被复制到你未预期的位置。请将 bridge 目录指向本机受控路径，并自行评估 Hermes 侧的数据处理与留存。

**关于邮件（第 3、12 行）**：`mail sync` 只做 IMAP 只读同步，不发送、不代发、不修改服务器邮件；密码保存在本机 `credentials/imap/<account>.json`（0600、目录 0700、原子写），不进入数据库、导出、备份、同步、日志与命令行参数（`ADVISERS_IMAP_PASS` 仅作旧入口兼容）。默认 `mail extract --local` 只在本机按规则抽取，不调用模型、不出网；只有 `mail extract --model` 在显式 flag + 模型 Key + **单独同意**后才把正文摘录发送给模型服务商。邮件正文默认保留 30 天（`retention_days` 可调，`mail purge` 清理到期正文、保留元数据与正文哈希；存在待处理候选时跳过）。

**关于回款/支付**：`receivables`/`payments` 只在本机记录，默认不出网；金额不进交付回执包、MCP/DSH 投影与桌宠投影。这些记录不是对账单、发票、收据、会计凭证、完税凭证、审计证据或法律意见，也未与银行流水核验。

**关于默认服务商**：默认 DeepSeek。DeepSeek 是独立第三方，其处理受 [DeepSeek 开放平台服务协议](https://cdn.deepseek.com/policies/zh-CN/deepseek-open-platform-terms-of-service.html)、[DeepSeek 隐私政策](https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html) 及适用法律约束；运营者不是其处理者，也不代其作出留存/训练/删除承诺。请在启用前阅读其条款。

## 5. 第三方接收方与跨境

5.1 上述第三方可能包括：模型服务商（默认 DeepSeek；`mail extract --model` 发送正文摘录时同样适用）、IMAP 邮件服务商（`mail sync` 与旧 `capture --from-imap`）、你选择的同步盘/云服务、webhook 接收方、MCP 客户端、DSH 宿主、桌宠应用、你指定的外部命令，以及 bridge 场景下你的 Hermes 进程及其接入的消息平台。它们各自是独立的个人信息处理者或受托处理者（取决于其条款），运营者不控制其处理。

5.2 **跨境**：默认模型服务商为境内服务商，通常不构成向境外提供。若你把 `ADVISERS_BASE_URL`/`ADVISERS_PROVIDER` 指向境外服务商，或通过宿主/客户端/bridge（经 Hermes 接入的平台）把数据传输至境外，你应自行判断是否构成《个人信息保护法》第 38 条的跨境提供，履行第 39 条的告知与单独同意、第 55 条的个人信息保护影响评估（PIPIA），以及适用的安全评估/标准合同/认证义务；涉及重要数据的，还应遵守《数据安全法》《网络数据安全管理条例》《促进和规范数据跨境流动规定》。**邮件正文、知识库内容与回款/支付记录**一旦发送给境外模型或第三方服务，同样可能构成跨境提供；你配置的 IMAP 邮件服务器或模型服务商位于境外时，邮件的接收与发送也可能涉及跨境。不要把境内客户数据随意发送到境外模型。

## 6. 你的客户数据、委托处理与单独同意

6.1 若你处理客户、当事人、同事或其他第三人的个人信息，**你是该等信息的个人信息处理者（或受托处理者）**，应自行具备合法性基础（同意、合同、法定义务等），遵守最小必要、目的限制、告知、单独同意、影响评估与安全事件报告等义务。**邮件正文、知识库文档与回款/支付记录可能含客户、当事人或其他第三人的个人信息、商业秘密与财务信息**，适用相同的处理者义务；回款记录中的付款方、金额、银行账号、发票号等同样可能构成个人信息。

6.2 **委托处理**：当你把客户个人信息发送给模型服务商，可能构成《个人信息保护法》第 21 条的委托处理，或第 23 条的向其他处理者提供（取决于服务商条款与实际处理目的）。按 DeepSeek 开放平台协议第 3.5 条，你应就“委托我们处理个人信息”取得客户同意或具有其他合法性基础；如构成向第三方提供，还应依第 23 条告知接收方并取得**单独同意**。`mail extract --model` 把邮件正文摘录发送给模型服务商时同样适用；`mail sync` 从你的 IMAP 服务器取回邮件不改变你作为处理者的责任。知识库在本版本不调用模型，不构成对模型服务商的委托处理。

6.3 **职业保密**：律师、顾问、会计师、税务师等对其客户负有法定或约定保密义务（如《律师法》第 38 条及会计师、税务师行业规范）。第三方 AI 处理可能构成向第三方披露；在未取得客户授权/同意、未确认服务商保密与留存条款前，不要输入客户秘密、商业秘密、当事人隐私或受职业特权保护的信息——**邮件正文、知识库文档与回款记录中的客户信息同样受此约束**。优先选择企业级/零留存/本地模型方案；本版本的邮件本地抽取（`--local`）与知识库均不调用模型。

6.4 **敏感个人信息**：对话、邮件、会议、附件与知识库文档可能包含《个人信息保护法》第 28 条的敏感个人信息（医疗健康、金融账户、行踪轨迹、特定身份、不满 14 周岁未成年人信息等）。**回款/支付记录中的银行账号、开户行、发票号、金额与交易对手等可能构成“金融账户”类敏感个人信息**，应最小化记录（如仅保留账号后 4 位），避免在备注中写入完整账号或身份证号。只有在具有特定目的、充分必要性与严格保护措施时方可处理，并取得**单独同意**（第 29 条）、告知必要性与影响（第 30 条）。自伤/自杀等危机表达会触发本地提示与求助信息（12356/120/110），不阻断对话；相关原文默认留在本地账本，不写入审计摘要。

6.5 **未成年人**：本软件面向成年人的工作场景，**不向未成年人提供**；未满 18 周岁不得使用（经监护人同意并在监护人指导下使用的除外，监护人对其使用行为与后果承担责任）；**不满 14 周岁的儿童请勿使用**。本软件不做年龄核验，不收集未成年人个人信息。若你使用本软件处理未成年人（例如客户/当事人为未成年人）的个人信息，你应遵守《个人信息保护法》第 28/29/31 条、《未成年人保护法》第 72 条及《未成年人网络保护条例》第四章：取得监护人同意、制定专门处理规则、保障监护人查阅/复制/更正/删除权利，并在事件发生时依法告知与报告。

## 7. 保留、删除与你的权利

7.1 **保留**：本软件对账本、对话、知识库与回款/支付记录不设自动到期删除，上述本地数据保留到**你删除**或设备/文件被清除为止；例外：邮件正文的默认保留期为 30 天（`retention_days` 可调；到期后由你运行 `mail purge` 清理正文、保留元数据与正文哈希，存在待处理候选时跳过），晨报归档默认保留 14 天（`--keep` 可调，归档时自动轮转）。第三方服务商侧的保留按其条款。审计链为防篡改而设计，删除其行会破坏校验，因此审计默认保留。

7.2 **查阅/复制**：`advisers export --all`（可加 `--encrypted`）、`advisers privacy --json`、`advisers memory`、`advisers history`、`advisers search`、`advisers evidence show`、`advisers mail ls`/`mail show --body`、`advisers kb ls`/`kb show --chunks`、`advisers receivable ls`/`payment ls`、`advisers consent status`。

7.3 **删除**：`advisers purge <matter> --yes` 删除事项相关数据；`advisers forget <id>` 将偏好/事实标记为弃用/删除（**墓碑：正文可能保留**）；`advisers mail purge --older-than 30d` 清理到期邮件正文；`advisers mail account remove` 删除邮件账号（先删凭据，再询问是否清除正文）；`advisers kb rm <id>` 使知识库文档不可检索（留墓碑），`advisers kb purge <id> --yes` 物理删除文档与抽取文本；`advisers receivable void`/`payment void` 将回款/支付记录标记为作废（墓碑，不物理删除）。**注意：purge 是部分删除**，不会删除：审计链（含哈希与最小元数据）、数据库迁移/同步/导入备份（`state.db.before-*`、`import-backup-*.db`）、`undo` 文件副本、导出物、同步快照、交付物/回执包、日历事件、已完成承诺、事项参与人字段、非事项关联研究记录、客户域回款/支付行（事项 purge 不删除它们）、知识库/邮件的 FTS 派生索引、已归档晨报（默认 14 天），以及第三方服务商侧的副本。完整清除需你同时清理这些位置并向服务商行使删除权（如适用）。

7.4 **更正**：`advisers prefs correct`、`memory accept/reject`、事项/承诺编辑命令；第三方服务商侧更正按其流程。

7.5 **撤回同意/停止出网**：`advisers consent revoke` 撤回邮件模型出网的单独同意；取消 `ADVISERS_API_KEY`、`ADVISERS_NOTIFY_WEBHOOK`、sync 目录配置，`advisers mail account remove` 删除账号与凭据，停止 `advisers bridge`，或停止使用相应功能。**接受 TOS 的同意与模型出网的单独同意是两件事**：撤回前者按 TOS 第 18.1 条，撤回后者用 `consent revoke`；任一撤回后对应功能停止。本软件没有需要“撤回”的运营者侧同意（因为运营者不处理）。你对客户作出的同意，应由你按约定和法定程序撤回并停止处理。

7.6 **投诉**：见第 12 节；你也可以向网信、市场监管等部门投诉（如 12377、12315、12345，按当地实际渠道）。

## 8. 安全措施与边界

8.1 本软件采取：HOME 0700、主要文件 0600、SQLite `secure_delete=ON`、AES-256-GCM + scrypt 的可选 vault/export/sync 加密、HMAC 审计链、受保护事项（secrecy>0）模型/研究/导入 fail-closed、IMAP 只读且默认 993 隐式 TLS/143 仅显式 STARTTLS（不允许明文回落）、邮件凭据 0600/0700 原子写且不进数据库/导出/备份/同步/日志、邮件正文默认 30 天保留、模型出网同意记录 0600 原子写并按服务商/端点绑定、晨报归档 0600/0700、webhook 最小化 payload、MCP 只读为主且写操作需人工接受、bridge 目录 0700 与文件 0600（bridge 模型调用走同一 fail-closed 门）。

8.2 **边界**：默认数据库不加密；无法防御同机同用户的恶意程序、内存取证、已导出/已同步/已交付文件（含邮件正文、知识库抽取文本与回款记录）、第三方服务商侧、宿主/客户端侧、屏幕被他人看到、终端 scrollback/截屏、`~/.advisers/briefs/` 中的明文派生副本、交互式壳内存中的历史，以及你自己的误操作。`advisers privacy --prove` 只验证本地可验证事实（无遥测、默认不出网、审计链、受保护事项 fail-closed），**不是第三方认证、不是合规认证、不是等保/算法备案/大模型登记**。

8.3 **安全事件**：若发生个人信息泄露、篡改、丢失，作为处理者的你应依法履行告知与报告义务（《个人信息保护法》第 57 条、《数据安全法》第 29 条、《网络数据安全管理条例》及未成年人相关规定）。运营者仅在其自身接收的信息（你主动提交的 issue/邮件）范围内配合。发现软件漏洞请按仓库 [SECURITY.md](https://github.com/PerryLink/advisers/blob/main/SECURITY.md) 的私密渠道（GitHub Private Vulnerability Reporting）报告，勿在公开 issue 提交个人信息或客户数据。

## 9. 第三方链接

- [DeepSeek 开放平台服务协议](https://cdn.deepseek.com/policies/zh-CN/deepseek-open-platform-terms-of-service.html)
- [DeepSeek 内容安全指南](https://api-docs.deepseek.com/zh-cn/guides/safety)
- 你的 IMAP/同步盘/MCP 客户端/DSH 宿主/桌宠应用：请阅读其各自的服务条款与隐私政策。

## 10. 变更

本说明随 TOS 版本升级；实质变化会升级版本号并在仓库发布说明中公告。历史版本可在仓库 [docs/](https://github.com/PerryLink/advisers/tree/main/docs) 与 git 历史中查阅。中文版为准。

## 11. 适用法律

本说明适用中华人民共和国法律（不含冲突法规则），与 [服务条款](https://github.com/PerryLink/advisers/blob/main/docs/TOS.md) 的适用法律条款一致。

## 12. 联系与投诉

- 运营者：PerryLink（本项目维护者，GitHub: https://github.com/PerryLink）
- 联系与投诉：GitHub Issues（https://github.com/PerryLink/advisers/issues）；请勿在公开 issue 提交个人信息、客户数据或安全漏洞细节。
- 安全漏洞：GitHub Private Vulnerability Reporting（见 [SECURITY.md](https://github.com/PerryLink/advisers/blob/main/SECURITY.md)）。
- 我们将在 15 个工作日内首次回复。

---

**文档完 · v2026.11.4 · 2026-11-21**

如中英文版本存在冲突，以本中文版本为准。本文件任何部分被认定无效，不影响其余部分的效力。
