# Telemail

一个 Cloudflare Worker，监控 **Gmail / Outlook / IMAP** 收件箱，把新邮件转发到 Telegram 聊天——支持**多账号**、附件、AI 摘要、Mini App 稍后提醒。

- **Gmail**：Google Cloud Pub/Sub 推送通知实时接收
- **Outlook**：Microsoft Graph webhook 订阅实时接收
- **IMAP**：内置 IMAP Bridge 中间件（`middleware/`），通过 IMAP IDLE 实时推送

## 技术栈

- **Runtime**：Cloudflare Workers（后端）+ Cloudflare Pages（Mini App 前端 + web 工具页）
- **后端**：[Elysia](https://elysiajs.com)（CloudflareAdapter）+ [grammY](https://grammy.dev) + Cloudflare D1 / KV / Queue / Cron
- **前端**：[Vite](https://vite.dev) + React 19 + [TanStack Router](https://tanstack.com/router) + [TanStack Query](https://tanstack.com/query) + [HeroUI](https://heroui.com) + [Eden treaty](https://elysiajs.com/eden/treaty/overview)（端到端类型安全 RPC）+ [TypeBox](https://github.com/sinclairzx81/typebox)
- **邮件解析**：[postal-mime](https://github.com/postalsys/postal-mime)；HTML → Markdown：[turndown](https://github.com/mixmark-io/turndown) → Telegram MarkdownV2
- **AI 摘要**：任何 OpenAI-compatible API（可选）
- **i18n**：[i18next](https://www.i18next.com)（当前仅中文）

## 部署架构

单自定义域名，Cloudflare Workers Routes 按路径分流：

- `example.com/api/*`、`/oauth/*` → Worker
- 其它 UI 路径（`/`、`/mail/*`、`/preview`、`/junk-check`、`/login`、`/telegram-app/*`）→ Pages

同源零 CORS；前端 ky 用相对路径调 `/api/*`，Worker 端 `X-Telegram-Init-Data` 头验签。

CI/CD（`.github/workflows/ci.yml`）：push to `main` → 按 path filter 自动部署改动的 workspace（worker `wrangler deploy` / page `wrangler pages deploy --branch=main` / middleware 多 arch docker 镜像 push 到 GHCR）。PR 自动出 preview deploys（worker version preview URL + Pages preview branch + docker build-only），URL 会 sticky comment 到 PR 上。

## 文档

- **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)** —— 从 0 部署到 Cloudflare（GCP / MS Entra / D1 / KV / Queue / Workers + Pages / Bot webhook）
- **[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)** —— 本地开发命令、前端调试流程、i18n
- **[docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md)** —— 所有 secrets、Bindings、Cron、D1 schema 的参考

## 功能速览

<details>
<summary><strong>邮件接收 + 投递</strong>（点击展开）</summary>

三种邮箱类型通过各自的 Provider 类（`GmailProvider` / `OutlookProvider` / `ImapProvider`）统一处理，最终都汇入同一个 Cloudflare Queue：

- **Gmail**：Google Cloud Pub/Sub 向 `/api/gmail/push` 发送推送通知 → `GmailProvider.enqueue()` 根据 `emailAddress` 查找账号，调用 Gmail History API 拉取新消息 ID → 批量入队。
- **Outlook**：Microsoft Graph webhook 向 `/api/outlook/push` 发送变更通知 → `OutlookProvider.enqueue()` 根据 `subscriptionId` 查找账号，从通知中提取消息 ID → 批量入队。
- **IMAP**：外部 IMAP Bridge 轮询检测新邮件 → `/api/imap/push` → `ImapProvider.enqueue()` 验证后入队。

Queue Consumer 拉取原始 RFC 2822 邮件（Gmail REST / Outlook Graph / IMAP Bridge），postal-mime 解析 → 格式化 → 发送到账号对应的 Telegram Chat。附件随文一起：1 个走 `sendDocument`，多个走 `sendMediaGroup`（caption 挂第一个上）。处理失败 Queue 自动重试（max 3 次）。

</details>

<details>
<summary><strong>Telegram 消息交互</strong>（点击展开）</summary>

每条邮件消息附带 inline keyboard：⭐ 星标 / 🚫 垃圾 / 📥 归档 / 🔄 刷新。星标同时自动标记已读 + 置顶（取消星标 → 取消置顶）；标记垃圾移到垃圾邮件文件夹 + 删除 Telegram 消息；归档移出收件箱（Gmail 需先在账号详情指定标签）；刷新先和远端对账（邮件被移到垃圾 / 归档 / 删除 → 清理 TG 消息），仍在收件箱才重新拉取 + LLM 分析。

配置 `WORKER_URL` 后额外出现 ⏰ 提醒 + 👁 查看原文。私聊里直接打开 Mini App；群聊走 `t.me/<bot>/<short>?startapp=...` deep link（需配 `TG_MINI_APP_SHORT_NAME`）。Mini App 里能看邮件预览（带星标 / 归档 / 删除等 FAB），设提醒，浏览未读 / 星标 / 垃圾 / 归档列表。

频道 / 群组里对邮件消息加 emoji reaction 会自动标记对应邮件为已读。

</details>

<details>
<summary><strong>AI 摘要 + 垃圾检测</strong>（点击展开）</summary>

配好 `LLM_API_URL` / `LLM_API_KEY` / `LLM_MODEL` 后，新邮件发到 Telegram 后会异步调用 LLM 生成摘要和标签，编辑原消息替换正文；标签以 `#Tag` 形式附在末尾。垃圾检测高置信度（≥ 0.8）自动加 `#Junk` 标签（不会自动移动或删除）。

</details>

<details>
<summary><strong>定时任务</strong>（点击展开）</summary>

单个 `* * * * *` Cron Trigger：

- 每分钟：分发到期的 Mini App 提醒
- 每小时（minute=0）：检查 IMAP Bridge 健康、重试失败的 LLM 摘要
- 每天 UTC 0 点（额外）：为所有已授权账号续订推送通知（Gmail watch / Outlook Graph subscription）

</details>

## 多账号

- Gmail / Outlook / IMAP 三种混用
- 每个账号可以配**不同的 Telegram Chat ID**（不同邮箱转不同聊天 / 频道）
- 所有 Gmail 账号共享同一个 GCP 项目；所有 Outlook 账号共享同一个 Entra ID 应用；所有账号共享同一个 Telegram Bot
- 账号信息存 D1，通过 Telegram Bot 管理（`/start` → 账号管理）
- 支持**临时禁用**：推送 / cron / 列表跳过该账号，IMAP 额外通知 bridge 断开连接；配置保留随时可恢复

## Bot 命令

| 命令        | 说明             |
| ----------- | ---------------- |
| `/start`    | 打开管理面板     |
| `/help`     | 查看帮助信息     |
| `/accounts` | 查看我的邮箱账号 |
| `/sync`     | 同步所有邮箱     |
| `/unread`   | 查看未读邮件     |
| `/starred`  | 查看星标邮件     |
| `/junk`     | 查看垃圾邮件     |
| `/archived` | 查看归档邮件     |

命令菜单通过 `setMyCommands` API 自动注册到 Telegram（webhook 收到消息时异步触发，KV 版本号不变则跳过）。修改 `worker/src/bot/commands.ts` 的 `BOT_COMMANDS` 后递增 `BOT_COMMANDS_VERSION` 即可，部署后发任意消息给 Bot 生效。

管理员另有几条不出现在公开菜单里的命令（`/users`、`/secrets` 等），定义在 `commands.ts` 的 `ADMIN_COMMANDS`，`/help` 里管理员可见。

## 许可证

[AGPL-3.0-or-later](./LICENSE) © 2026 Apocalypsor
