<h1 align="center">Gemini MCP &amp; Task Auto Always Allow</h1>

<p align="center">
  面向 Google Gemini 网页端（聊天模式与任务模式）的自动权限审批油猴脚本，优先自动点击「始终允许」，并在无该选项时按需回退点击「允许 / 允许一次」。
</p>

<p align="center">
  <a href="https://raw.githubusercontent.com/myh333777/gemini-auto-allow-userscript/main/gemini-mcp-auto-allow.user.js"><img src="https://img.shields.io/badge/%E4%B8%80%E9%94%AE%E5%AE%89%E8%A3%85_Userscript-v2.0.0-2B5B84?style=for-the-badge&amp;logo=tampermonkey&amp;logoColor=white" alt="一键安装 Userscript v2.0.0"></a>
</p>

<p align="center">
  <a href="https://raw.githubusercontent.com/myh333777/gemini-auto-allow-userscript/main/gemini-mcp-auto-allow.user.js"><img src="https://img.shields.io/badge/Version-v2.0.0-3776AB?style=flat-square" alt="Version v2.0.0"></a>
  <img src="https://img.shields.io/badge/Target-gemini.google.com-4B5563?style=flat-square" alt="Target gemini.google.com">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-22C55E?style=flat-square" alt="License: MIT"></a>
</p>

## 解决的问题

新版 Gemini 网页端更新了权限审批组件，导致早期脚本（如仅匹配 `/spark*` 与 `remy-confirmation-card` 的脚本）失效：

| 维度 | 旧版界面 | 当前新版界面 | 本脚本适配策略 |
|---|---|---|---|
| 页面路由 | `/spark*` | `/app*`、`/u/*/app*`、`/spark*` | 匹配 `https://gemini.google.com/*` |
| 卡片元素 | `remy-confirmation-card` | `remy-confirmation-card-v2` | 同时监听 v1 与 v2 组件 |
| 按钮定位 | `gem-button[data-test-id=...]` | 已移除 `data-test-id` | 基于按钮启用状态与中英文文案识别 |
| 聊天模式 MCP 审批 | 两按钮（允许 / 拒绝） | 三按钮（不允许 / 允许一次 / 始终允许） | 优先点击「始终允许 / Always allow」 |
| 任务模式 / 运行命令 | 两按钮（允许 / 拒绝） | 两按钮（拒绝 / 允许） | 自动回退点击「允许 / Allow」（可配置） |

## 一键安装

1. 先在浏览器安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/)、[Violentmonkey](https://violentmonkey.github.io/) 或 [ScriptCat](https://docs.scriptcat.org/)。
2. 点击下方安装按钮，扩展会自动弹出脚本安装确认页（后续将通过 `@updateURL` 自动检查更新）：

[![点击一键安装 v2.0.0](https://img.shields.io/badge/%E7%82%B9%E5%87%BB%E4%B8%80%E9%94%AE%E5%AE%89%E8%A3%85-gemini--mcp--auto--allow.user.js-2B5B84?style=for-the-badge)](https://raw.githubusercontent.com/myh333777/gemini-auto-allow-userscript/main/gemini-mcp-auto-allow.user.js)

3. 手动安装备选：打开 [`gemini-mcp-auto-allow.user.js`](./gemini-mcp-auto-allow.user.js) 点击 **Raw**，或复制代码到脚本管理器中新建保存。

## 快速上手

1. 安装并启用脚本后，打开或刷新 `https://gemini.google.com/`（支持多账号路径 `/u/0/`、`/u/2/` 等）。
2. 当聊天模式或任务模式出现工具调用 / 命令执行确认卡片时，脚本会在约 `150ms` 后自动点击目标按钮，并在浏览器控制台输出日志：
   - `[Gemini Auto Allow] 已自动点击「始终允许」`
   - `[Gemini Auto Allow] 已自动点击「允许」`
3. 按钮点击优先级：
   1. `始终允许` / `总是允许` / `Always allow`
   2. `在此对话中允许` / `Allow for this chat`
   3. `允许一次` / `允许` / `Allow once` / `Allow`

## 可选配置

在脚本顶部可直接修改以下常量：

```javascript
const CLICK_DELAY_MS = 150;
// 若卡片没有“始终允许”，是否回退点击“在此对话中允许”或“允许 / 允许一次”
const FALLBACK_TO_CHAT_OR_ONCE = true;
```

- 如果你希望**只自动点击「始终允许」**，而把只有「拒绝 / 允许」的命令执行卡片留给人工确认，请将 `FALLBACK_TO_CHAT_OR_ONCE` 改为 `false`。

## 安全提示

自动放行「始终允许」与「运行命令 -> 允许」会让 Gemini 在无人工确认的情况下直接调用已连接的 MCP 工具或执行命令。请仅在个人可控或隔离环境中长期启用。

## 致谢与许可证

- 思路参考了 Greasyfork 上的早期脚本 [Gemini Spark MCP Auto Allow (#593120)](https://greasyfork.org/en/scripts/593120-gemini-spark-mcp-auto-allow)（MIT License）。
- 本项目基于 [MIT License](./LICENSE) 开源。
