<h1 align="center">Gemini MCP &amp; Task Auto Always Allow (+ Prompt Queue)</h1>

<p align="center">
  面向 Google Gemini 网页端（聊天模式与任务模式）的自动权限审批 + 消息排队油猴脚本：自动放行权限卡片、支持生成中回车消息排队（逐条发送 / 与上条合并自由混排）、SPA 切会话状态重置与多标签运行总览。
</p>

<p align="center">
  <a href="https://raw.githubusercontent.com/myh333777/gemini-auto-allow-userscript/main/gemini-mcp-auto-allow.user.js"><img src="https://img.shields.io/badge/%E4%B8%80%E9%94%AE%E5%AE%89%E8%A3%85_Userscript-v3.0.0-2B5B84?style=for-the-badge&amp;logo=tampermonkey&amp;logoColor=white" alt="一键安装 Userscript v3.0.0"></a>
</p>

<p align="center">
  <a href="https://raw.githubusercontent.com/myh333777/gemini-auto-allow-userscript/main/gemini-mcp-auto-allow.user.js"><img src="https://img.shields.io/badge/Version-v3.0.0-3776AB?style=flat-square" alt="Version v3.0.0"></a>
  <img src="https://img.shields.io/badge/Target-gemini.google.com-4B5563?style=flat-square" alt="Target gemini.google.com">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-22C55E?style=flat-square" alt="License: MIT"></a>
</p>

## 核心功能（v3.0.0）

1. **全覆盖自动审批**
   - 同时监听 `remy-confirmation-card`、`remy-confirmation-card-v2`、`spark-waiting-for-user-banner` 以及 `[role="dialog"]` / `[role="alertdialog"]`（内置删除对话/清空记录类危险弹窗黑名单防误点）。
   - 放宽按钮前缀匹配，兼容带工具名/角标的按钮（如「始终允许 @mac3」「Always allow for ...」「允许一次 (shell)」），并优先排除「不允许 / Don't allow」。
   - 自动补发滞留在输入框里的审批文本，防止后台失焦态下点击后卡住不提交。
2. **输入消息排队（Prompt Queue）**
   - Gemini 回复生成中、等待审批或已有排队项时，在输入框直接打字按 **Enter**（或点击发送），内容会立刻收进**输入框正上方的排队浮层**，不再被吞掉或干等；空闲时按 `Alt + Enter` 也可强制先入队。
   - **合并 / 逐条自由混排**：
     - 顶部可一键切换默认行为：`✂️ 逐条发` 或 `🔗 合并上条`；
     - 队列中除第 1 条外，每一条都可单独点 `🔗 合并` / `✂️ 独立` 实时切换。相邻的 `🔗 合并` 条目会归入同一轮拼成一条发送，`✂️ 独立` 条目则等 Gemini 回复完上一轮再发。
   - 支持 **⏸ 暂停派发 / ▶ 继续派发**、**⚡ 立即发下轮**、**上移排序**、**双击/点击编辑**、**删除**，并按当前会话路径隔离持久化到 `sessionStorage`。
   - 派发时使用 Quill 兼容注入 + 发送校验重试，确保内容真正发出后再出队；有排队消息时优先发队列，不会被自动“继续”插队。
3. **SPA 切会话状态重置 + 独立开关**
   - 监听 `history.pushState` / `replaceState` / `popstate`，切换对话时自动重置连续“继续”计数并加载目标会话的排队列表。
   - 右下角控制台可独立开关「自动审批」「回退允许」「消息排队」「默认合并」「自动继续」「标签页标题状态」，所有设置持久化到 `localStorage`。
4. **多标签状态总览**
   - 通过 `BroadcastChannel` 跨标签同步同源 Gemini 标签页状态，点击右下角胶囊可一眼看到所有标签处于「运行中 / 卡审批 / 排队中 / 空闲 / 可能已冻结」。
   - 标签页标题自动附加状态前缀（`[⏳审批]`、`[📋排队N]`、`[⚡运行]`），不用切标签也能发现异常。

## 后台多标签防冻结建议

由于 Chromium 内核会对后台标签页启用「内存节省程序（Tab Freeze）」并节流定时器，若同时挂多个 Gemini 任务标签，建议在浏览器设置中将 `gemini.google.com` 加入始终保持活跃名单：

- **Chrome / Edge / Dia**：打开 `chrome://settings/performance` → 在「始终让这些网站保持活跃状态」中添加 `gemini.google.com`。

## 一键安装

1. 安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/)、[Violentmonkey](https://violentmonkey.github.io/) 或 [ScriptCat](https://docs.scriptcat.org/)。
2. 点击上方「一键安装 Userscript」按钮，或直接打开 [`gemini-mcp-auto-allow.user.js`](./gemini-mcp-auto-allow.user.js) 点击 **Raw** 安装。

## 安全提示

自动放行「始终允许」与「允许」会让 Gemini 在无人工确认的情况下调用已连接的 MCP 工具或执行命令。请仅在个人可控或隔离环境中长期启用。

## 致谢与许可证

- 早期思路参考 Greasyfork 脚本 [Gemini Spark MCP Auto Allow (#593120)](https://greasyfork.org/en/scripts/593120-gemini-spark-mcp-auto-allow)（MIT License）。
- 本项目基于 [MIT License](./LICENSE) 开源。
