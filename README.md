# Telemail

一个 Cloudflare Worker，通过 **Gmail API + Google Cloud Pub/Sub** 推送通知监控 Gmail 收件箱，并将新邮件转发到 Telegram 聊天——支持**多账号**、附件和可选的 AI 摘要。

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

1. Gmail 检测到收件箱中有新邮件，通过 Google Cloud Pub/Sub 发送推送通知。
2. Pub/Sub 向 Worker 的 `/api/gmail/push` 端点发送 HTTP POST 请求。
3. Worker 根据通知中的 `emailAddress` **在 D1 数据库中查找对应账号**。
4. 找到账号后，Pub/Sub 通知入 **Cloudflare Queue** 的 `sync` 消息（携带 `accountId`）。
5. `sync` 消息调用 Gmail API `history.list` 拉取新消息 ID，再批量投递 `message` 消息到同一个 Queue。
6. Queue Consumer 逐条拉取原始 RFC 2822 邮件，使用 postal-mime 解析。
7. 格式化后的消息（发件人、时间、主题、正文）发送到**账号配置的 Telegram Chat**。
8. 附件作为真实文件附在同一条 Telegram 消息中：
   - **1 个附件** → `sendDocument` + 标题
   - **多个附件** → `sendMediaGroup`，标题放在第一个文件上
9. （可选）如果配置了 LLM API，会异步生成 AI 摘要和标签，编辑原消息替换正文为摘要。
10. 每条消息附带 ⭐ **星标按钮**（inline keyboard），点击可在 Gmail 中加/取消星标。
11. （可选）配置 `WORKER_URL` 后，每条消息附带 📧 **查看原文**按钮，点击可在浏览器中查看邮件原始 HTML。链接使用 HMAC-SHA256 签名防遍历，HTML 内容缓存 7 天。
12. 在频道/群组中对消息添加 **emoji reaction** 可自动将对应 Gmail 邮件标记为已读。
13. 消息发送前会按 `messageId` 做幂等去重，避免重复投递到 Telegram。
14. 处理失败时 Queue 自动重试（最多 3 次）；达到上限后消息丢弃。
15. Cron Trigger 每 6 天自动为**所有已授权账号**续订 Gmail watch（watch 7 天后过期）。

正文会自动截断以适应 Telegram 的字符限制（纯文本消息 4096 字符，附件标题 1024 字符）。

## 多账号支持

- 每个 Gmail 账号可以配置**不同的 Telegram Chat ID**，实现不同邮箱转发到不同的聊天/频道。
- 所有账号**共享同一个 GCP 项目**（OAuth Client ID/Secret 和 Pub/Sub Topic）。
- 所有账号**共享同一个 Telegram Bot**。
- 账号信息（email、chat_id、refresh_token、history_id）存储在 **D1 数据库**中。
- 通过 Web Dashboard 管理账号：添加、删除、OAuth 授权、Watch 续订。

## 前置条件

- 一个 [Cloudflare](https://cloudflare.com) 账号
- 一个启用了 Gmail API 的 [Google Cloud](https://console.cloud.google.com) 项目
- 一个或多个 Gmail / Google Workspace 账号
- 一个 [Telegram Bot](https://core.telegram.org/bots#how-do-i-create-a-bot) Token
- 接收消息的 Telegram Chat ID（每个 Gmail 账号可配置不同的 Chat ID）

## 配置步骤

### 1. 安装依赖

```sh
npm install
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

### 3. 创建 D1 数据库

```sh
npx wrangler d1 create gmail-tg-bridge
```

将返回的 `database_id` 填入 `wrangler.jsonc` 中 `d1_databases[0].database_id`。

然后执行数据库迁移：

```sh
npx wrangler d1 migrations apply gmail-tg-bridge --remote
```

### 3b. 创建 KV 命名空间

```sh
npx wrangler kv namespace create EMAIL_KV
```

将返回的 `id` 填入 `wrangler.jsonc` 中 `kv_namespaces[0].id`。KV 用于 access_token 缓存、消息去重和 OAuth state 存储。

### 3c. 创建 Queue

```sh
npx wrangler queues create gmail-tg-queue
```

Queue 用于处理 Gmail history 同步和邮件发送，内置重试。`wrangler.jsonc` 中已配置好 producer 和 consumer 绑定。

### 4. 配置 Secrets

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN        # Telegram Bot Token
npx wrangler secret put TELEGRAM_BOT_USERNAME      # Telegram Bot 用户名（不含 @），用于 Login Widget
npx wrangler secret put ADMIN_TELEGRAM_ID          # 管理员 Telegram user ID
npx wrangler secret put ADMIN_SECRET               # 自定义密钥，用于 HMAC 签名（session cookie、邮件查看链接）
npx wrangler secret put GMAIL_CLIENT_ID            # Google OAuth2 Client ID
npx wrangler secret put GMAIL_CLIENT_SECRET        # Google OAuth2 Client Secret
npx wrangler secret put GMAIL_PUBSUB_TOPIC         # 例如 projects/my-project/topics/gmail-push
npx wrangler secret put GMAIL_PUSH_SECRET          # 自定义密钥，用于验证 Pub/Sub push
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET    # 自定义密钥，用于验证 Telegram webhook
```

### 5. AI 摘要（可选）

配置以下三个环境变量即可启用 AI 摘要功能，使用任何 OpenAI compatible API：

```sh
npx wrangler secret put LLM_API_URL    # API base URL，包含 /v1（例如 https://api.openai.com/v1）
npx wrangler secret put LLM_API_KEY    # API key
npx wrangler secret put LLM_MODEL      # 模型名称（例如 gpt-4o-mini）
```

兼容 OpenAI、Groq、OpenRouter、vLLM、Ollama（`http://host:11434/v1`）等任何提供 `/chat/completions` 端点的服务。

三个变量都配置后，新邮件发送到 Telegram 后会异步生成摘要并编辑原消息。

### 6. 查看邮件原文（可选）

配置 `WORKER_URL` 后，Telegram 消息会附带"📧 查看原文"按钮，点击可在浏览器中查看邮件原始 HTML：

```sh
npx wrangler secret put WORKER_URL  # Worker 对外 URL，例如 https://gmail-tg-bridge.xxx.workers.dev
```

链接使用 HMAC-SHA256（基于 `ADMIN_SECRET` + `messageId` + `chatId`）签名，防止未授权遍历。HTML 内容缓存在 KV 中，7 天后自动过期。

### 7. 部署

```sh
npm run deploy   # 自动先运行 build:css 生成 Tailwind CSS，再部署
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

### 9. 添加 Gmail 账号

1. 打开 `https://YOUR_WORKER_DOMAIN/`，通过 **Telegram Login Widget** 登录（仅 `ADMIN_TELEGRAM_ID` 对应的用户可登录）
2. 在 "Add Account" 表单中填写 Gmail 地址和 Telegram Chat ID，点击"添加账号"
3. 点击账号旁边的"授权"按钮，完成 Google OAuth 授权
4. 授权成功后，点击 "Watch" 或 "Renew All Watches" 激活 Gmail 推送通知

之后 Cron Trigger 会每 6 天自动为所有已授权账号续订 watch。

## 开发

```sh
npm run dev        # 先 build:css 再启动本地开发服务器
npm run build:css  # 单独生成 Tailwind CSS（输出到 src/assets/tailwind.ts）
npm test           # 运行测试
npm run cf-typegen # 根据 wrangler.jsonc 重新生成 TypeScript 类型
```

## 项目结构

```text
src/
  index.ts             # Worker 入口（fetch/queue/scheduled 分发）
  constants.ts         # TTL/时间格式等常量
  types.ts             # 类型定义：Env, Account, QueueMessage, etc.
  styles.css           # Tailwind CSS v4 入口
  handlers/
    hono/
      index.tsx        # Hono app 入口：error handler、favicon、Telegram Login、home/dashboard、挂载子路由
      routes.ts        # 路由路径常量
      middleware.ts    # 共享中间件（requireSession + requireSecret for push）
      telegram.tsx     # Telegram webhook 路由
      gmail.tsx        # Gmail push + watch 路由
      accounts.tsx     # 账号 CRUD 路由
      oauth.tsx        # Google OAuth 路由
      preview.tsx      # HTML 预览路由
      mail.tsx         # 邮件原文查看路由（HMAC 验证 + KV 缓存）
    queue.ts           # Queue consumer（重试/ack/retry）
  components/
    layout.tsx         # 共享 Layout、Card、BackLink 组件 (Tailwind CSS inline)
    home.tsx           # 登录页（Telegram Login Widget）、Dashboard（账号管理）、HTML 预览页
    oauth.tsx          # OAuth 授权页、回调结果页、错误页
  assets/
    favicon.ts         # Base64 编码的 favicon
    tailwind.ts        # [生成] Tailwind CSS 常量（npm run build:css 生成，已 gitignore）
  bot/
    index.ts           # grammY Bot 创建 + botInfo KV 缓存
    keyboards.ts       # Inline keyboard 定义（星标/已星标）
    handlers/
      reaction.ts      # Emoji reaction → Gmail 标记已读
      star.ts          # 星标/取消星标 inline button callback
  db/
    accounts.ts        # D1 数据库 CRUD（accounts 表）
    kv.ts              # KV 辅助函数（access_token 缓存、去重、history_id）
    message-map.ts     # Telegram ↔ Gmail 消息映射（星标状态）
  services/
    bridge.ts          # Gmail→Telegram 业务流程编排（多账号 sync/message/AI 摘要/标签）
    gmail.ts           # Gmail OAuth2 + REST API + watch + history + star/read
    llm.ts             # OpenAI compatible API 调用（AI 摘要 + 标签生成）
    mail-content.ts    # 邮件内容获取与 HTML 缓存
    message-actions.ts # 消息操作（星标、已读等）
    oauth.ts           # OAuth 流程逻辑（按账号的 token 交换、state 管理）
    observability.ts   # 错误结构化日志 + Observability Hub
    telegram.ts        # Telegram 发送/编辑：text、attachments、caption、reply_markup
  utils/
    base64url.ts       # Base64url 编解码
    format.ts          # 邮件正文格式化：HTML→Markdown→Telegram MarkdownV2
    hash.ts            # HMAC-SHA256 token 生成/验证（邮件原文链接）
    markdown-v2.ts     # MarkdownV2 转义与最长合法前缀解析
    session.ts         # Session cookie 创建/验证（HMAC-SHA256 签名）
    telegram-login.ts  # Telegram Login Widget 数据解析与 HMAC 验证
    verification.ts    # 验证码提取
scripts/
  build-css.mjs        # Tailwind CSS 构建脚本（生成 src/assets/tailwind.ts）
migrations/
  0001_create_accounts.sql     # D1 数据库迁移：创建 accounts 表
  0002_email_nullable.sql      # D1 数据库迁移：email 字段改为可空
  0003_create_message_map.sql  # D1 数据库迁移：Telegram↔Gmail 消息映射表
wrangler.jsonc         # Cloudflare Worker 配置（D1 + KV + Queue + Cron）
```

## 环境变量

| Secret / 变量             | 说明                                                   |
| ------------------------- | ------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`      | Telegram Bot Token                                     |
| `TELEGRAM_BOT_USERNAME`   | Telegram Bot 用户名（不含 @），用于 Login Widget       |
| `ADMIN_TELEGRAM_ID`       | 管理员 Telegram user ID，用于 Telegram Login 鉴权      |
| `ADMIN_SECRET`            | 自定义密钥，用于 HMAC 签名（session cookie、邮件链接） |
| `GMAIL_CLIENT_ID`         | Google OAuth2 Client ID（所有账号共享）                |
| `GMAIL_CLIENT_SECRET`     | Google OAuth2 Client Secret（所有账号共享）            |
| `GMAIL_PUBSUB_TOPIC`      | Pub/Sub topic 全名（所有账号共享）                     |
| `GMAIL_PUSH_SECRET`       | 自定义密钥，附加在 push URL 中用于验证                 |
| `TELEGRAM_WEBHOOK_SECRET` | 自定义密钥，用于验证 Telegram webhook                  |
| `LLM_API_URL`             | OpenAI compatible API base URL（可选）                 |
| `LLM_API_KEY`             | LLM API key（可选）                                    |
| `LLM_MODEL`               | LLM 模型名称（可选）                                   |
| `WORKER_URL`              | Worker 对外 URL（可选，启用"查看原文"按钮）            |

每个 Gmail 账号的 `refresh_token`、`chat_id`、`history_id` 存储在 D1 数据库的 `accounts` 表中，通过 Web Dashboard 管理。

## API 端点

管理页面通过 **Telegram Login Widget** 登录，使用 session cookie 鉴权（标注 🔒 的路由）。

**页面路由（GET / HTML）：**

| 方法 | 路径                             | 鉴权     | 说明                                 |
| ---- | -------------------------------- | -------- | ------------------------------------ |
| GET  | `/`                              | -        | 登录页（Telegram Login）/ Dashboard  |
| GET  | `/auth/telegram`                 | -        | Telegram Login 回调（验证+创建会话） |
| GET  | `/logout`                        | -        | 登出（清除 session cookie）          |
| GET  | `/favicon.png`                   | -        | Favicon                              |
| GET  | `/preview`                       | Session  | HTML→Telegram MarkdownV2 预览        |
| GET  | `/mail/:id?t=HMAC_TOKEN`         | HMAC     | 查看邮件原文 HTML                    |
| GET  | `/oauth/google?account=ID`       | Session  | 指定账号的 OAuth 授权说明页          |
| GET  | `/oauth/google/start?account=ID` | Session  | 发起指定账号的 Google OAuth          |
| GET  | `/oauth/google/callback`         | KV state | OAuth 回调                           |

**API 路由（POST，均以 `/api` 开头）：**

| 方法 | 路径                                 | 鉴权    | 说明                   |
| ---- | ------------------------------------ | ------- | ---------------------- |
| POST | `/api/accounts`                      | Session | 添加 Gmail 账号        |
| POST | `/api/accounts/:id/edit`             | Session | 编辑 Gmail 账号        |
| POST | `/api/accounts/:id/delete`           | Session | 删除 Gmail 账号        |
| POST | `/api/accounts/:id/watch`            | Session | 为指定账号续订 watch   |
| POST | `/api/accounts/:id/clear-cache`      | Session | 清除指定账号的 KV 缓存 |
| POST | `/api/gmail/watch`                   | Admin   | 为所有账号续订 watch   |
| POST | `/api/clear-all-kv`                  | Admin   | 清除所有 KV 数据       |
| POST | `/api/preview`                       | Session | 预览转换 API           |
| POST | `/api/telegram/webhook?secret=XXX`   | Secret  | Telegram Bot webhook   |
| POST | `/api/gmail/push?secret=XXX`         | Secret  | Pub/Sub push 回调      |

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
```

附件会作为可下载文件附在同一条消息中。

## 许可证

私有
