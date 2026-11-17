# Legal notice code template（扩展点合规注释模板）

> 用途：给 Advisers 的代码扩展点、第三方扩展与衍生项目提供统一的法务提示注释。
> 版本：与 `docs/TOS.md` 同步（当前 **v2026.11.2**，清单见 `packages/advisers/lib/tos/manifest.json`）。
> 适用：新增或修改扩展点（Link/通知外发/Office 模板/工具注册/策略包/DLC 加载器/TTS 合成入口等）时，把对应语言的注释块放到实现文件顶部或扩展点入口处。
> 注意：注释不是运行期门禁；运行期确认与 manifest 校验由对应功能实现。**不得因为加了注释就省略同意门、审计与 AI 标识。**

## 1. 必填信息

| 字段 | 说明 | 示例 |
|---|---|---|
| `TOS_VERSION` | 注释所依据的 TOS 版本，必须与 `lib/tos/manifest.json` 的 `version` 一致 | `2026.11.2` |
| `EXTENSION_POINT` | 扩展点标识（稳定、可检索；未来可登记到扩展点注册表） | `ep:link.send`、`ep:office.template` |
| `LICENSE` | 该文件的许可证（软件类文件为 PolyForm NC 1.0.0） | `PolyForm-Noncommercial-1.0.0` |

## 2. JavaScript / TypeScript（主模板）

```js
/* ADVISERS-LEGAL-NOTICE v1
 * Extension point: <EXTENSION_POINT>
 * TOS: Advisers Terms of Service v<TOS_VERSION> (docs/TOS.md);
 *      license: PolyForm Noncommercial 1.0.0 (noncommercial use only; see LICENSE/LICENSING.md).
 *
 * By modifying, distributing, or loading this extension you agree to the TOS. You must:
 *  1) keep the content-safety review, local audit chain, and AI-generated-content labels intact;
 *  2) not use it to create or distribute unlawful, infringing, deceptive, harassing, or
 *     unlabeled synthetic content, or to impersonate any person;
 *  3) not remove, bypass, or weaken the consent/egress/permission checks of the host.
 * Third-party extensions are the responsibility of their authors, not of the Advisers maintainers.
 *
 * 本扩展点受 Advisers 服务条款 v<TOS_VERSION>（docs/TOS.md）与仓库 LICENSE 约束：
 *  1) 不得移除或绕过内容安全审核、本地审计链与 AI 生成内容标识；
 *  2) 不得用于生成/传播违法、侵权、欺诈、骚扰、冒充他人或未标识的合成内容；
 *  3) 不得绕过同意门、出网许可与权限边界；第三方扩展由作者自行负责。
 */
```

放置位置：扩展点实现文件顶部（推荐），或紧邻扩展点注册/导出语句之前。示例：

```js
/* ADVISERS-LEGAL-NOTICE v1
 * Extension point: ep:link.send
 * TOS: Advisers Terms of Service v2026.11.2 (docs/TOS.md);
 *      license: PolyForm Noncommercial 1.0.0 (noncommercial use only; see LICENSE/LICENSING.md).
 * ...
 */
export interface LinkProvider {
  send(message: OutboundMessage): Promise<void>
}
```

## 3. Python / Shell / 其他语言（等价变体）

```python
# ADVISERS-LEGAL-NOTICE v1
# Extension point: <EXTENSION_POINT>
# TOS: Advisers Terms of Service v<TOS_VERSION> (docs/TOS.md);
#      license: PolyForm Noncommercial 1.0.0 (noncommercial use only).
# Do not use this extension for unlawful/infringing/deceptive/harassing/unlabeled content.
# 本扩展点受 Advisers 服务条款约束；不得移除内容安全审核、审计与 AI 标识。
```

```sh
# ADVISERS-LEGAL-NOTICE v1
# Extension point: <EXTENSION_POINT> · TOS v<TOS_VERSION> (docs/TOS.md) · PolyForm-NC-1.0.0
# 不得用于违法/侵权/冒充/未标识内容；不得移除内容安全、审计与 AI 标识。
```

## 4. 单行变体（空间受限时）

```js
// ADVISERS-LEGAL-NOTICE v1 · ep:<EXTENSION_POINT> · TOS v<TOS_VERSION> (docs/TOS.md) · PolyForm-NC-1.0.0 · no unlawful/unlabeled use
```

## 5. 非代码资产（DLC / 内容包 manifest）

第三方扩展与内容包须在清单中声明法务字段（加载器校验；摘要由加载器计算，不接受清单自带值）：

```json
{
  "advisersPack": 1,
  "id": "com.example.voice-pack",
  "name": "示例内容包",
  "version": "1.0.0",
  "author": "Name <contact@example.com>",
  "license": "PolyForm-Noncommercial-1.0.0",
  "tosVersion": "2026.11.2",
  "permissions": ["fs.read", "net"],
  "contentSafety": { "reviewed": true, "languages": ["zh-CN"], "notes": "..." }
}
```

要求：缺 `author`、`license`、`tosVersion`、`permissions` 或内容安全声明的扩展应被拒绝加载；文件摘要与清单摘要不一致、或权限变更时，须重新确认。详见 `docs/TOS.md` 第 14 条。

## 6. 审查清单（提交 PR 前）

- [ ] 扩展点/实现文件含 `ADVISERS-LEGAL-NOTICE v1` 注释，且 `TOS_VERSION` 与 `lib/tos/manifest.json` 一致；
- [ ] 未移除或绕过内容安全审核、审计链、出网许可与 AI 标识；
- [ ] 对外发送/交付路径考虑发送者责任与标识义务；
- [ ] 第三方扩展声明了 manifest 法务字段，且默认禁用、加载前确认；
- [ ] 新增/修改的文本类文件同步 `docs/TOS.md`、`docs/DISCLAIMER.md`、`docs/SAFETY.md` 与 `lib/tos/` 副本，并运行 `node scripts/check-tos.mjs`。
