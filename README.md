# Telemail

一个 Cloudflare Worker，监控 **Gmail / Outlook / IMAP** 收件箱，并将新邮件转发到 Telegram 聊天——支持**多账号**、附件和可选的 AI 摘要。

- **Gmail**: 通过 Google Cloud Pub/Sub 推送通知实时接收
- **Outlook**: 通过 Microsoft Graph webhook 订阅实时接收
- **IMAP**: 通过外部 IMAP Bridge 中间件轮询接收（私有项目，不包含在本仓库中）

## 技术栈

- **Runtime**: Cloudflare Workers
- **Framework**: [Hono](https://hono.dev) (路由 + JSX 服务端渲染)
- **Database**: Cloudflare D1 (多账号信息存储)
- **UI**: Tailwind CSS (build-time, inline `<style>`)
- **邮件解析**: [postal-mime](https://github.com/nickytonline/postal-mime)
- **格式化**: HTML → Markdown ([turndown](https://github.com/mixmark-io/turndown)) → Telegram MarkdownV2
- **Telegram Bot**: [grammY](https://grammy.dev) (webhook 接收 + inline keyboard + reaction)
- **AI 摘要**: OpenAI compatible API (可选)

## 工作原理

### 邮件接收

三种邮箱类型通过不同方式接收新邮件通知，最终都汇入同一个 **Cloudflare Queue** 进行统一处理：

- **Gmail**: Google Cloud Pub/Sub 向 `/api/gmail/push` 发送推送通知 → Worker 根据 `emailAddress` 在 D1 中查找账号 → 调用 Gmail API `history.list` 拉取新消息 ID → 逐条入队。
- **Outlook**: Microsoft Graph webhook 向 `/api/outlook/push` 发送变更通知 → Worker 根据 `subscriptionId` 在 KV 中查找账号 → 调用 Graph API 拉取新消息 → 逐条入队。
- **IMAP**: 外部 IMAP Bridge 中间件轮询检测新邮件 → 调用 `/api/imap/push` 推送 `accountId` + `messageId` → 直接入队。

### 邮件处理（Queue Consumer）

1. Queue Consumer 按账号类型拉取原始 RFC 2822 邮件（Gmail REST API / Outlook Graph API / IMAP Bridge），使用 postal-mime 解析。
2. 格式化后的消息（发件人、时间、主题、正文）发送到**账号配置的 Telegram Chat**。
3. 附件作为真实文件附在同一条 Telegram 消息中：
   - **1 个附件** → `sendDocument` + 标题
   - **多个附件** → `sendMediaGroup`，标题放在第一个文件上
4. （可选）如果配置了 LLM API，会异步生成 AI 摘要和标签（单词、首字母大写），编辑原消息替换正文为摘要，标签以 `#Tag` 形式附在末尾。
5. 每条消息附带 ⭐ **星标按钮**和 🚫 **垃圾按钮**（inline keyboard）。星标同时自动标记已读；标记垃圾会将邮件移到垃圾邮件文件夹并删除 Telegram 消息。
6. （可选）配置 `WORKER_URL` 后，每条消息附带 📧 **查看原文**按钮，点击可在浏览器中查看邮件原始 HTML。预览页提供悬浮操作按钮（FAB）：收件箱邮件可标记为垃圾，垃圾邮件可移回收件箱或删除。链接使用 HMAC-SHA256 签名防遍历，HTML 内容缓存 7 天。
7. 在频道/群组中对消息添加 **emoji reaction** 可自动将对应邮件标记为已读。
8. LLM 检测到高置信度垃圾邮件（≥ 0.8）时自动在 Telegram 消息中添加 `#Junk` 标签，不会自动移动或删除。
9. 消息发送前会按 `messageId` 做幂等去重，避免重复投递到 Telegram。
10. 处理失败时 Queue 自动重试（最多 3 次）；达到上限后消息丢弃。

### 定时任务（Cron Trigger）

- **每小时**: 检查 IMAP Bridge 中间件健康状态，异常时上报到 Observability Hub。
- **每天凌晨（UTC 0 点）**: 自动为所有已授权的 **Gmail 账号**续订 watch（watch 7 天后过期）、**Outlook 账号**续订 Graph subscription。
- **每天早 9 点和晚 6 点**（Eastern Time）: 向每个 Telegram Chat 发送邮件摘要通知，包含各账号的未读和垃圾邮件数量。全部为零时跳过，不打扰。

正文会自动截断以适应 Telegram 的字符限制（纯文本消息 4096 字符，附件标题 1024 字符）。

## 多账号支持

- 支持 **Gmail**、**Outlook**、**IMAP** 三种邮箱类型，可混合使用。
- 每个邮箱账号可以配置**不同的 Telegram Chat ID**，实现不同邮箱转发到不同的聊天/频道。
- 所有 Gmail 账号共享同一个 GCP 项目；所有 Outlook 账号共享同一个 Entra ID 应用。
- 所有账号**共享同一个 Telegram Bot**。
- 账号信息存储在 **D1 数据库**中，通过 Telegram Bot 管理。

## 前置条件

- 一个 [Cloudflare](https://cloudflare.com) 账号
- 一个 [Telegram Bot](https://core.telegram.org/bots#how-do-i-create-a-bot) Token
- 接收消息的 Telegram Chat ID（每个邮箱账号可配置不同的 Chat ID）
- **Gmail**: 启用了 Gmail API 的 [Google Cloud](https://console.cloud.google.com) 项目
- **Outlook**: [Microsoft Entra ID](https://entra.microsoft.com) 应用注册
- **IMAP**: 外部 IMAP Bridge 中间件（私有项目，可选）

## 配置步骤

### 1. 安装依赖

```sh
pnpm install
```

### 2. Google Cloud 配置

#### 2a. 启用 Gmail API

1. 打开 [Google Cloud Console](https://console.cloud.google.com)
2. 创建或选择一个项目
3. 进入 **APIs & Services → Library**，搜索 **Gmail API** 并启用

#### 2b. 创建 OAuth2 凭据

1. 进入 **APIs & Services → Credentials**
2. 点击 **Create Credentials → OAuth client ID**
3. 应用类型选择 **Web application**
4. Authorized redirect URIs 添加 `https://YOUR_WORKER_DOMAIN/oauth/google/callback`
5. 记录 `Client ID` 和 `Client Secret`

#### 2c. 创建 Pub/Sub Topic 和 Subscription

```sh
# 创建 topic（所有 Gmail 账号共享同一个 topic）
gcloud pubsub topics create gmail-push

# 授权 Gmail 向此 topic 发布消息
gcloud pubsub topics add-iam-policy-binding gmail-push \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

# 部署 Worker 后，创建 push subscription（URL 中替换为你的 Worker 域名和密钥）
gcloud pubsub subscriptions create gmail-push-sub \
  --topic=gmail-push \
  --push-endpoint="https://YOUR_WORKER_DOMAIN/api/gmail/push?secret=YOUR_PUSH_SECRET" \
  --ack-deadline=30
```

### 2d. Microsoft Entra ID 配置（Outlook，可选）

1. 打开 [Microsoft Entra ID](https://entra.microsoft.com) → Applications → App registrations → **New registration**
2. 名称随意，账户类型选 **Accounts in any organizational directory and personal Microsoft accounts**
3. Redirect URI 添加 **Web** 类型：`https://YOUR_WORKER_DOMAIN/oauth/microsoft/callback`
4. 注册后记下 **Application (client) ID**
5. 进入 **Certificates & secrets** → New client secret → 记下 Value
6. 进入 **API permissions** → Add a permission → Microsoft Graph → Delegated permissions → 勾选 `Mail.ReadWrite`、`offline_access`、`User.Read`

### 3. 创建 D1 数据库

```sh
pnpm wrangler d1 create gmail-tg-bridge
```

将返回的 `database_id` 填入 `wrangler.jsonc` 中 `d1_databases[0].database_id`。

然后执行数据库迁移：

```sh
pnpm wrangler d1 migrations apply gmail-tg-bridge --remote
```

### 3b. 创建 KV 命名空间

```sh
pnpm wrangler kv namespace create EMAIL_KV
```

将返回的 `id` 填入 `wrangler.jsonc` 中 `kv_namespaces[0].id`。KV 用于 access_token 缓存、消息去重和 OAuth state 存储。

### 3c. 创建 Queue

```sh
pnpm wrangler queues create gmail-tg-queue
```

Queue 用于处理 Gmail history 同步和邮件发送，内置重试。`wrangler.jsonc` 中已配置好 producer 和 consumer 绑定。

### 4. 配置 Secrets

```sh
# ── 必填 ──
pnpm wrangler secret put TELEGRAM_BOT_TOKEN        # Telegram Bot Token
pnpm wrangler secret put ADMIN_TELEGRAM_ID          # 管理员 Telegram user ID
pnpm wrangler secret put ADMIN_SECRET               # 自定义密钥，用于 HMAC 签名（session cookie、邮件查看链接）
pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET    # 自定义密钥，用于验证 Telegram webhook

# ── Gmail（使用 Gmail 时必填）──
pnpm wrangler secret put GMAIL_CLIENT_ID            # Google OAuth2 Client ID
pnpm wrangler secret put GMAIL_CLIENT_SECRET        # Google OAuth2 Client Secret
pnpm wrangler secret put GMAIL_PUBSUB_TOPIC         # 例如 projects/my-project/topics/gmail-push
pnpm wrangler secret put GMAIL_PUSH_SECRET          # 自定义密钥，用于验证 Pub/Sub push

# ── Outlook（使用 Outlook 时必填）──
pnpm wrangler secret put MS_CLIENT_ID               # Microsoft Entra ID Application (client) ID
pnpm wrangler secret put MS_CLIENT_SECRET           # Microsoft Entra ID Client Secret
pnpm wrangler secret put MS_WEBHOOK_SECRET          # 自定义密钥，用于验证 Graph webhook
```

### 5. AI 摘要（可选）

配置以下三个环境变量即可启用 AI 摘要功能，使用任何 OpenAI compatible API：

```sh
pnpm wrangler secret put LLM_API_URL    # API base URL，包含 /v1（例如 https://api.openai.com/v1）
pnpm wrangler secret put LLM_API_KEY    # API key
pnpm wrangler secret put LLM_MODEL      # 模型名称（例如 gpt-4o-mini）
```

兼容 OpenAI、Groq、OpenRouter、vLLM、Ollama（`http://host:11434/v1`）等任何提供 `/chat/completions` 端点的服务。

三个变量都配置后，新邮件发送到 Telegram 后会异步生成摘要并编辑原消息。

### 6. 查看邮件原文（可选）

配置 `WORKER_URL` 后，Telegram 消息会附带"📧 查看原文"按钮，点击可在浏览器中查看邮件原始 HTML：

```sh
pnpm wrangler secret put WORKER_URL  # Worker 对外 URL，例如 https://gmail-tg-bridge.xxx.workers.dev
```

链接使用 HMAC-SHA256（基于 `ADMIN_SECRET` + `messageId` + `chatId`）签名，防止未授权遍历。HTML 内容缓存在 KV 中，7 天后自动过期。

### 7. 部署

```sh
pnpm deploy   # 自动先运行 build:css 生成 Tailwind CSS，再部署
```

### 8. 设置 Telegram Webhook

部署完成后，设置 Telegram Bot 的 webhook 指向 Worker：

```sh
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR_WORKER_DOMAIN/api/telegram/webhook?secret=YOUR_TELEGRAM_WEBHOOK_SECRET",
    "allowed_updates": ["message", "callback_query", "message_reaction", "message_reaction_count"]
  }'
```

- `message`：接收 `/start` 等 Bot 命令
- `callback_query`：接收星标按钮点击
- `message_reaction` / `message_reaction_count`：接收 emoji reaction（群组/频道）

> **注意**：如果邮件转发到**频道**，Bot 需要被设为频道管理员才能接收 reaction 事件。

### 9. 添加邮箱账号

通过 Telegram Bot 管理账号：

1. 向 Bot 发送 `/start`，点击「账号管理」→「添加账号」
2. 选择账号类型（Gmail / Outlook / IMAP），按提示完成配置
3. Gmail / Outlook 需要完成 OAuth 授权；IMAP 需要填写服务器信息和密码
4. 授权成功后自动创建 webhook 订阅，新邮件会实时推送到 Telegram

Cron Trigger 每小时检查 IMAP 中间件健康；每天凌晨（UTC 0 点）自动续订 Gmail watch 和 Outlook Graph subscription；每天早 9 点和晚 6 点发送邮件摘要通知。

## Bot 命令

| 命令        | 说明                   |
| ----------- | ---------------------- |
| `/start`    | 打开管理面板           |
| `/help`     | 查看帮助信息           |
| `/accounts` | 查看我的邮箱账号       |
| `/unread`   | 查看未读邮件           |
| `/starred`  | 查看星标邮件           |
| `/junk`     | 查看垃圾邮件           |
| `/users`    | 查看用户列表（管理员） |

命令菜单通过 `setMyCommands` API 自动注册到 Telegram，在 webhook 收到消息时异步触发（KV 版本号未变时跳过）。命令列表定义在 `src/bot/index.ts` 的 `BOT_COMMANDS` 数组中，修改后递增 `BOT_COMMANDS_VERSION` 即可，部署后发任意消息给 Bot 即生效。

## 开发

```sh
pnpm dev        # 先 build:css 再启动本地开发服务器
pnpm build:css  # 单独生成 Tailwind CSS（输出到 src/assets/tailwind.ts）
pnpm test           # 运行测试
pnpm cf-typegen # 根据 wrangler.jsonc 重新生成 TypeScript 类型
```

### Path Aliases

所有跨目录导入使用 TypeScript path alias，避免 `../../` 相对路径：

| Alias           | 对应目录           |
| --------------- | ------------------ |
| `@/*`           | `src/*`            |
| `@utils/*`      | `src/utils/*`      |
| `@services/*`   | `src/services/*`   |
| `@bot/*`        | `src/bot/*`        |
| `@db/*`         | `src/db/*`         |
| `@handlers/*`   | `src/handlers/*`   |
| `@components/*` | `src/components/*` |
| `@assets/*`     | `src/assets/*`     |

由 `tsconfig.json` 定义，Wrangler 构建时自动解析。

## 项目结构

```text
src/
  index.ts             # Worker 入口（fetch/queue/scheduled 分发）
  constants.ts         # 常量：API URL、KV key 前缀、TTL、Telegram 限制等
  types.ts             # 类型定义：Env, Account, QueueMessage, etc.
  styles.css           # Tailwind CSS v4 入口
  handlers/
    hono/
      index.tsx        # Hono app 入口：error handler、favicon、挂载子路由
      routes.ts        # 路由路径常量
      telegram.tsx     # Telegram webhook 路由
      auth.tsx         # Telegram Login 路由（登录页 + callback）
      preview.tsx      # HTML 预览 + 邮件原文查看 + 邮件操作 API（移到收件箱/垃圾/回收站）
      middleware.ts    # Secret/Bearer token/Telegram Login 验证中间件
      email/
        gmail/         # Gmail push + OAuth 路由
        outlook/       # Outlook push + OAuth 路由
        imap/          # IMAP 相关路由
    queue.ts           # Queue consumer（重试/ack/retry）
  components/
    layout.tsx         # 共享 Layout、Card、BackLink 组件 (Tailwind CSS inline)
    login.tsx          # Telegram Login 登录页组件
    oauth.tsx          # OAuth 授权页、回调结果页、错误页
    preview.tsx        # HTML 预览页组件
  assets/
    favicon.ts         # Base64 编码的 favicon
    tailwind.ts        # [生成] Tailwind CSS 常量（pnpm build:css 生成，已 gitignore）
    theme.ts           # 主题色常量（slate/blue 色系，用于非 Tailwind 上下文的内联 CSS）
  bot/
    index.ts           # grammY Bot 创建 + botInfo KV 缓存 + 用户注册/审批流程
    auth.ts            # 管理员身份检查
    keyboards.ts       # Inline keyboard 定义（主菜单）
    formatters.ts      # 账号详情/用户列表文本格式化
    state.ts           # Bot 输入状态管理（KV 存储，5 分钟 TTL）
    handlers/
      accounts.ts      # 账号 CRUD + 所有者分配（admin）
      admin.ts         # 用户管理 + 失败邮件管理
      input.ts         # 文本输入处理（Chat ID、IMAP 配置）
      reaction.ts      # Emoji reaction → 标记已读
      star.ts          # 星标/取消星标 inline button callback
      junk.ts          # 标记为垃圾邮件 inline button callback
  db/
    accounts.ts        # D1 数据库 CRUD（accounts 表）
    users.ts           # 用户管理（upsert、审批、查询）
    kv.ts              # KV 辅助函数（access_token 缓存、history_id、邮件 HTML 缓存）
    message-map.ts     # Telegram ↔ Email 消息映射（星标状态）
    failed-emails.ts   # LLM 失败邮件记录
  services/
    bridge.ts          # 邮件→Telegram 投递编排（拉取/解析/发送/LLM 摘要）
    digest.ts          # 邮件摘要定时通知（早9晚6，按 chat 分组发送未读/垃圾数量）
    email/
      gmail/           # Gmail OAuth2 + REST API + watch + history
      outlook/         # Outlook OAuth2 + Graph API + subscription
      imap/            # IMAP Bridge 通信
      provider.ts      # EmailProvider 接口（多类型分发：星标/已读/垃圾/回收站/列表）
      mail-content.ts  # 邮件内容获取（Gmail API 格式）
    keyboard.ts        # 邮件操作 inline keyboard 构建
    llm.ts             # LLM 邮件分析（验证码 + 摘要 + 标签，纯数据返回）
    message-actions.ts # 消息操作（星标切换、标记已读、清空垃圾邮件）
    telegram.ts        # Telegram API 封装（发送/编辑/附件/速率限制/MarkdownV2 回退）
  utils/
    async.ts           # delay 工具函数
    base64url.ts       # Base64url 编解码
    format.ts          # 邮件正文格式化：HTML→Markdown→Telegram MarkdownV2
    hash.ts            # HMAC-SHA256 token 生成/验证（邮件原文链接、CORS 代理签名）
    session.ts         # Telegram Login 验证 + session cookie 签名/验证
    markdown-v2.ts     # MarkdownV2 转义与最长合法前缀解析
    observability.ts   # 错误结构化日志 + Observability Hub
scripts/
  build-css.mjs        # Tailwind CSS 构建脚本（生成 src/assets/tailwind.ts）
migrations/            # D1 数据库迁移（10 个文件）
wrangler.jsonc         # Cloudflare Worker 配置（D1 + KV + Queue + Cron）
```

## 环境变量

| Secret / 变量             | 说明                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`      | Telegram Bot Token                                          |
| `ADMIN_TELEGRAM_ID`       | 管理员 Telegram user ID，用于鉴权                           |
| `ADMIN_SECRET`            | 自定义密钥，用于 HMAC 签名（session cookie、邮件链接）      |
| `TELEGRAM_WEBHOOK_SECRET` | 自定义密钥，用于验证 Telegram webhook                       |
| `GMAIL_CLIENT_ID`         | Google OAuth2 Client ID（所有账号共享）                     |
| `GMAIL_CLIENT_SECRET`     | Google OAuth2 Client Secret（所有账号共享）                 |
| `GMAIL_PUBSUB_TOPIC`      | Pub/Sub topic 全名（所有账号共享）                          |
| `GMAIL_PUSH_SECRET`       | 自定义密钥，附加在 push URL 中用于验证                      |
| `LLM_API_URL`             | OpenAI compatible API base URL（可选）                      |
| `LLM_API_KEY`             | LLM API key（可选）                                         |
| `LLM_MODEL`               | LLM 模型名称（可选）                                        |
| `WORKER_URL`              | Worker 对外 URL（可选，启用"查看原文"按钮）                 |
| `MS_CLIENT_ID`            | Microsoft Entra ID Application (client) ID（Outlook，可选） |
| `MS_CLIENT_SECRET`        | Microsoft Entra ID Client Secret（Outlook，可选）           |
| `MS_WEBHOOK_SECRET`       | 自定义密钥，验证 Graph webhook（Outlook，可选）             |
| `IMAP_BRIDGE_URL`         | IMAP Bridge 中间件 URL（IMAP，私有项目，可选）              |
| `IMAP_BRIDGE_SECRET`      | IMAP Bridge 中间件共享密钥（IMAP，私有项目，可选）          |

每个邮箱账号的 `type`、`refresh_token`、`chat_id` 等信息存储在 D1 数据库的 `accounts` 表中，通过 Telegram Bot 管理。

## API 端点

**页面路由（GET / HTML）：**

| 方法 | 路径                                | 鉴权     | 说明                                  |
| ---- | ----------------------------------- | -------- | ------------------------------------- |
| GET  | `/favicon.png`                      | -        | Favicon                               |
| GET  | `/login`                            | -        | Telegram Login 登录页                 |
| GET  | `/preview`                          | Session  | HTML→Telegram MarkdownV2 预览工具     |
| GET  | `/mail/:id?accountId=X&t=TOKEN`     | HMAC     | 查看邮件原文 HTML（含操作 FAB 按钮）  |
| GET  | `/oauth/google?account=ID`          | Session  | 指定账号的 Google OAuth 授权说明页    |
| GET  | `/oauth/google/start?account=ID`    | Session  | 发起指定账号的 Google OAuth           |
| GET  | `/oauth/google/callback`            | KV state | Google OAuth 回调                     |
| GET  | `/oauth/microsoft?account=ID`       | Session  | 指定账号的 Microsoft OAuth 授权说明页 |
| GET  | `/oauth/microsoft/start?account=ID` | Session  | 发起指定账号的 Microsoft OAuth        |
| GET  | `/oauth/microsoft/callback`         | KV state | Microsoft OAuth 回调                  |

**API 路由（均以 `/api` 开头）：**

| 方法 | 路径                               | 鉴权    | 说明                              |
| ---- | ---------------------------------- | ------- | --------------------------------- |
| POST | `/api/telegram/webhook?secret=XXX` | Secret  | Telegram Bot webhook              |
| POST | `/api/gmail/push?secret=XXX`       | Secret  | Gmail Pub/Sub push 回调           |
| POST | `/api/outlook/push?secret=XXX`     | Secret  | Outlook Graph webhook             |
| POST | `/api/preview`                     | Session | HTML 格式化预览（JSON 请求/响应） |
| POST | `/api/mail/:id/move-to-inbox`      | HMAC    | 将垃圾邮件移回收件箱并重投递到 TG |
| POST | `/api/mail/:id/mark-as-junk`       | HMAC    | 标记为垃圾邮件并删除 TG 消息      |
| POST | `/api/mail/:id/trash`              | HMAC    | 移到回收站                        |
| GET  | `/api/imap/accounts`               | Bearer  | IMAP 中间件拉取账号列表           |
| POST | `/api/imap/push`                   | Bearer  | IMAP 中间件推送新邮件通知         |

## Telegram 消息格式

```text
发件人:  Name <email@example.com>
时  间:  2026/2/22 10:30:00
主  题:  Subject line

（正文内容，过长时自动截断）
```

启用 AI 摘要后，消息会被编辑为：

```text
发件人:  Name <email@example.com>
时  间:  2026/2/22 10:30:00
主  题:  Subject line

🤖 AI 摘要

（AI 生成的摘要内容）

#Github  #Verification  #Security
```

标签为单词、首字母大写，最多 3 个，与邮件语言一致。

附件会作为可下载文件附在同一条消息中。

## 许可证

私有
