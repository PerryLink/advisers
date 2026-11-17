# 隐私与数据流说明（Privacy & Data-Flow Notice）

| 项目 | 内容 |
|---|---|
| 文档版本 | 2026.11.2（与 docs/TOS.md 同版本） |
| 生效日期 | 2026-11-17 |
| 适用对象 | Advisers 用户、部署者与集成方 |
| 运营者 | PerryLink（本项目维护者，GitHub: https://github.com/PerryLink）；联系与投诉渠道见第 12 节 |
| 语言效力 | 中文版为准；翻译仅供参考 |
| 性质 | 本说明不是《个人信息保护法》第 17 条意义上由运营者作出的个人信息处理规则——**运营者不通过本软件处理你的个人信息**；它是数据流、第三方处理与你的合规义务说明。 |
| 完整性校验 | 本文件正文的 SHA-256 由 packages/advisers/lib/tos/manifest.json 记录，并由 scripts/check-tos.mjs 在本地/CI 校验；随 npm 包分发于 packages/advisers/lib/tos/privacy.zh-CN.md。 |

## 1. 一句话结论

Advisers 默认在本机运行：**没有账号、没有遥测、没有云服务、没有运营者服务器、没有自动更新检查**。你的数据默认保存在你的设备上；只有在你主动启用模型、网页研究、邮件导入、通知、同步、MCP/DSH/桌宠等能力时，相关内容才会发送给你配置的第三方服务商，受其条款与隐私政策约束。

## 2. 运营者的角色

2.1 运营者是本软件的发布者。**运营者不接收、不存储、不访问**你在本机账本、对话、附件、邮件、日历、研究记录、审计链与导出物中的任何数据；本软件不向你收集个人信息。

2.2 因此，运营者不是本软件运行中产生的个人信息的处理者；《个人信息保护法》第 17 条（告知）、第 21 条（委托处理）、第 23 条（向第三方提供）、第 31 条（未满 14 周岁）、第 38/39 条（跨境）等条款中针对“个人信息处理者”的义务，不因本软件的本地运行而由运营者承担。

2.3 例外：如果你主动通过 GitHub issue、邮件或其他渠道向维护者提交信息（例如错误日志、截图），该信息由相应平台与维护者仅为沟通、缺陷修复与安全响应目的处理；请勿提交客户数据、身份证号、手机号、合同正文或其他人的个人信息。我们会在不需要时删除或关闭相关 issue，但第三方平台的留存受其自身政策约束。公开仓库内容由平台运营方存储与处理，可能涉及跨境存储；如你不愿该等信息出境，请改用非公开渠道。

2.4 如果未来 Advisers 提供账号、云同步、遥测或其他由运营者控制的服务，运营者将成为相应个人信息处理者，并在上线前另行发布个人信息处理规则、取得必要同意、完成影响评估与跨境合规。

## 3. 本地数据清单

默认位置：`ADVISERS_HOME`（未设置时为 `~/.advisers`）；目录权限 0700，主要文件 0600（Windows 上由用户目录权限与 NTFS ACL 保护）。`ADVISERS_STORE=json` 时使用 `state.json` 回退存储。

| 数据类别 | 位置/表 | 用途 | 默认保留 | 你的控制方式 |
|---|---|---|---|---|
| 事项、参与人、事实、承诺、偏好、证据引用 | `state.db`（matters/facts/commitments/preferences 等） | 工作秘书的三本账 | 直到你删除 | `ls`/`memory`/`purge`/`forget` |
| 对话与摘要 | `turns`/`session_summaries`/`summary_versions` | 上下文、搜索、回顾 | 直到你删除 | `history`/`search`/`purge` |
| 研究记录 | `research_runs` | 引用与回顾 | 直到你删除 | `purge`（仅事项关联）/手动 |
| 模型调用元数据 | `model_calls` | 用量/成本/诊断（不含 prompt 正文） | 直到你删除 | `purge`/手动 |
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
| Pet Brief | `pet-brief.json` | 桌宠只读投影 | 覆盖/删除 | `pet-brief` 命令/手动 |

**加密状态（重要）**：默认数据库**不加密**（明文 SQLite）。`advisers vault`、`advisers export --encrypted`、`advisers sync` 提供可选的 AES-256-GCM + scrypt 加密；口令只从环境变量读取，不写入磁盘、不写入日志；**口令丢失后数据不可恢复**。vault 不透明（sealed 时正常命令无库）、不防运行中进程或内存取证，也不是安全擦除工具。

## 4. 会出网的情形（完整清单）

除下表外，本软件**不会出网**；无遥测、无自动更新检查、无运营者端点。所有第三方接收方均由你配置或选择；运营者不控制其处理。

| # | 功能 | 触发方式 | 接收方 | 发送/接收的数据 | 默认 | 你的控制 |
|---|---|---|---|---|---|---|
| 1 | 模型调用 | 设置 `ADVISERS_API_KEY` 后：`chat`、`capture`、`review`、`brief --deep`、`learn review` 及其他模型类命令 | 默认 DeepSeek（`https://api.deepseek.com`）；可用 `ADVISERS_BASE_URL`/`ADVISERS_PROVIDER`/`ADVISERS_MODEL` 修改 | messages/prompt/tool 输出；agent 可能把工作目录中非受保护文件内容带入上下文；模型返回结果 | **关**（无 key 不出网） | 不设 key；更换 provider；受保护事项（secrecy>0）fail-closed |
| 2 | 网页研究 | `research --web` / `--url`（显式 flag） | 同上（服务商服务器端 web 工具） | 查询词/URL；取回网页结果与引用 | 关 | 不运行该命令；secrecy>0 拒绝 |
| 3 | 邮件导入 | `capture --from-imap` | 你配置的 IMAP 服务器（TLS，只读 EXAMINE/FETCH） | 用户名/密码（仅环境变量）+ 邮件内容回传本机 | 关 | 不设置 IMAP 环境变量 |
| 4 | 通知 webhook | `ADVISERS_NOTIFY_WEBHOOK`（或显式 url） | 你配置的 URL | **仅**提醒计数、级别、到期日期（不含标题、客户名、动作、证据、quote） | **关** | 不设置该变量；指向可信端点 |
| 5 | 自定义通知命令 | `ADVISERS_NOTIFY_CMD` | 你指定的本地命令 | 提醒标题/正文（由该命令处理） | 关 | 不设置；自行审查命令 |
| 6 | 同步 | `sync push`/`pull`/`status --dir <dir>` | 你指定的目录（可能被 OneDrive/Dropbox/Syncthing/rsync 复制） | 加密整库快照；文件名含设备名与 UTC 时间 | 关 | 选择可信目录；定期删除旧快照；口令单独保管 |
| 7 | DSH 宿主 | `dsh-advisers` 工具（brief/office/today/who/evidence 等） | 宿主的模型/工具管线 | 账本视图、brief、生成请求 | 取决于宿主配置 | 阅读 DSH 宿主的隐私说明；不要在宿主中处理客户敏感信息 |
| 8 | MCP 客户端 | `advisers mcp --stdio` | 连接它的 MCP 客户端（Claude Code/Cursor/Copilot Studio 等）及其模型服务商 | today/commitments/who/evidence 等工具结果 | 关（stdio、本地） | 选择可信客户端；其可能把结果发给云模型 |
| 9 | 桌宠消费端 | 读取 `pet-brief.json` | 桌宠应用（如 Pearl，默认关闭） | 脱敏投影（启发式脱敏，非 NER；secrecy≥2 排除） | 关 | 不在他人可见屏幕展示；关闭功能 |
| 10 | OCR/时间戳/外部命令 | `ADVISERS_OCR_CMD`、timestamp adapter、`ADVISERS_NOTIFY_CMD` | 你指定的外部程序 | 取决于该程序 | 关 | 自行审查；外部程序可能联网 |

**关于默认服务商**：默认 DeepSeek。DeepSeek 是独立第三方，其处理受 [DeepSeek 开放平台服务协议](https://cdn.deepseek.com/policies/zh-CN/deepseek-open-platform-terms-of-service.html)、[DeepSeek 隐私政策](https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html) 及适用法律约束；运营者不是其处理者，也不代其作出留存/训练/删除承诺。请在启用前阅读其条款。

## 5. 第三方接收方与跨境

5.1 上述第三方可能包括：模型服务商（默认 DeepSeek）、IMAP 邮件服务商、你选择的同步盘/云服务、webhook 接收方、MCP 客户端、DSH 宿主、桌宠应用、你指定的外部命令。它们各自是独立的个人信息处理者或受托处理者（取决于其条款），运营者不控制其处理。

5.2 **跨境**：默认模型服务商为境内服务商，通常不构成向境外提供。若你把 `ADVISERS_BASE_URL`/`ADVISERS_PROVIDER` 指向境外服务商，或通过宿主/客户端把数据传输至境外，你应自行判断是否构成《个人信息保护法》第 38 条的跨境提供，履行第 39 条的告知与单独同意、第 55 条的个人信息保护影响评估（PIPIA），以及适用的安全评估/标准合同/认证义务；涉及重要数据的，还应遵守《数据安全法》《网络数据安全管理条例》《促进和规范数据跨境流动规定》。不要把境内客户数据随意发送到境外模型。

## 6. 你的客户数据、委托处理与单独同意

6.1 若你处理客户、当事人、同事或其他第三人的个人信息，**你是该等信息的个人信息处理者（或受托处理者）**，应自行具备合法性基础（同意、合同、法定义务等），遵守最小必要、目的限制、告知、单独同意、影响评估与安全事件报告等义务。

6.2 **委托处理**：当你把客户个人信息发送给模型服务商，可能构成《个人信息保护法》第 21 条的委托处理，或第 23 条的向其他处理者提供（取决于服务商条款与实际处理目的）。按 DeepSeek 开放平台协议第 3.5 条，你应就“委托我们处理个人信息”取得客户同意或具有其他合法性基础；如构成向第三方提供，还应依第 23 条告知接收方并取得**单独同意**。

6.3 **职业保密**：律师、顾问、会计师等对其客户负有法定或约定保密义务（如《律师法》第 38 条）。第三方 AI 处理可能构成向第三方披露；在未取得客户授权/同意、未确认服务商保密与留存条款前，不要输入客户秘密、商业秘密、当事人隐私或受职业特权保护的信息。优先选择企业级/零留存/本地模型方案。

6.4 **敏感个人信息**：对话、邮件、会议、附件可能包含《个人信息保护法》第 28 条的敏感个人信息（医疗健康、金融账户、行踪轨迹、特定身份、不满 14 周岁未成年人信息等）。只有在具有特定目的、充分必要性与严格保护措施时方可处理，并取得**单独同意**（第 29 条）、告知必要性与影响（第 30 条）。自伤/自杀等危机表达会触发本地提示与求助信息（12356/120/110），不阻断对话；相关原文默认留在本地账本，不写入审计摘要。

6.5 **未成年人**：本软件面向成年人的工作场景，**不向未成年人提供**；未满 18 周岁不得使用（经监护人同意并在监护人指导下使用的除外，监护人对其使用行为与后果承担责任）；**不满 14 周岁的儿童请勿使用**。本软件不做年龄核验，不收集未成年人个人信息。若你使用本软件处理未成年人（例如客户/当事人为未成年人）的个人信息，你应遵守《个人信息保护法》第 28/29/31 条、《未成年人保护法》第 72 条及《未成年人网络保护条例》第四章：取得监护人同意、制定专门处理规则、保障监护人查阅/复制/更正/删除权利，并在事件发生时依法告知与报告。

## 7. 保留、删除与你的权利

7.1 **保留**：本软件不设自动到期删除。上述本地数据保留到**你删除**或设备/文件被清除为止；第三方服务商侧的保留按其条款。审计链为防篡改而设计，删除其行会破坏校验，因此审计默认保留。

7.2 **查阅/复制**：`advisers export --all`（可加 `--encrypted`）、`advisers privacy --json`、`advisers memory`、`advisers history`、`advisers search`、`advisers evidence show`。

7.3 **删除**：`advisers purge <matter> --yes` 删除事项相关数据；`advisers forget <id>` 将偏好/事实标记为弃用/删除（**墓碑：正文可能保留**）。**注意：purge 是部分删除**，不会删除：审计链（含哈希与最小元数据）、数据库迁移/同步/导入备份（`state.db.before-*`、`import-backup-*.db`）、`undo` 文件副本、导出物、同步快照、交付物/回执包、日历事件、已完成承诺、事项参与人字段、非事项关联研究记录，以及第三方服务商侧的副本。完整清除需你同时清理这些位置并向服务商行使删除权（如适用）。

7.4 **更正**：`advisers prefs correct`、`memory accept/reject`、事项/承诺编辑命令；第三方服务商侧更正按其流程。

7.5 **撤回同意/停止出网**：取消 `ADVISERS_API_KEY`、IMAP 环境变量、`ADVISERS_NOTIFY_WEBHOOK`、sync 目录配置，或停止使用相应功能；本软件没有需要“撤回”的运营者侧同意（因为运营者不处理）。你对客户作出的同意，应由你按约定和法定程序撤回并停止处理。对本说明与 [服务条款](https://github.com/PerryLink/advisers/blob/main/docs/TOS.md) 的同意，可按 TOS 第 18.1 条撤回。

7.6 **投诉**：见第 12 节；你也可以向网信、市场监管等部门投诉（如 12377、12315、12345，按当地实际渠道）。

## 8. 安全措施与边界

8.1 本软件采取：HOME 0700、主要文件 0600、SQLite `secure_delete=ON`、AES-256-GCM + scrypt 的可选 vault/export/sync 加密、HMAC 审计链、受保护事项（secrecy>0）模型/研究/导入 fail-closed、IMAP 只读、webhook 最小化 payload、MCP 只读为主且写操作需人工接受。

8.2 **边界**：默认数据库不加密；无法防御同机同用户的恶意程序、内存取证、已导出/已同步/已交付文件、第三方服务商侧、宿主/客户端侧、屏幕被他人看到、以及你自己的误操作。`advisers privacy --prove` 只验证本地可验证事实（无遥测、默认不出网、审计链、受保护事项 fail-closed），**不是第三方认证、不是合规认证、不是等保/算法备案/大模型登记**。

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

**文档完 · v2026.11.2 · 2026-11-17**

如中英文版本存在冲突，以本中文版本为准。本文件任何部分被认定无效，不影响其余部分的效力。
