# gmail-tg-bridge

一个 Cloudflare Worker，通过 **Gmail API + Google Cloud Pub/Sub** 推送通知监控 Gmail 收件箱，并将新邮件转发到 Telegram 聊天——包括附件和可选的 AI 摘要。

## 技术栈

- **Runtime**: Cloudflare Workers
- **Framework**: [Hono](https://hono.dev) (路由 + JSX 服务端渲染)
- **UI**: Tailwind CSS (CDN)
- **邮件解析**: [postal-mime](https://github.com/nickytonline/postal-mime)
- **格式化**: HTML → Markdown ([turndown](https://github.com/mixmark-io/turndown)) → Telegram MarkdownV2
- **AI 摘要**: OpenAI compatible API (可选)

## 工作原理

1. Gmail 检测到收件箱中有新邮件，通过 Google Cloud Pub/Sub 发送推送通知。
2. Pub/Sub 向 Worker 的 `/gmail/push` 端点发送 HTTP POST 请求。
3. Worker 调用 Gmail API `history.list` 获取自上次检查点以来的新消息 ID。
4. Pub/Sub 通知先入 **Cloudflare Queue** 的 `sync` 消息，`max_concurrency: 1` 保证串行推进 Gmail `historyId`。
5. `sync` 消息会拉取新消息 ID，再批量投递 `message` 消息到同一个 Queue。
6. Queue Consumer 逐条拉取原始 RFC 2822 邮件，使用 postal-mime 解析。
7. 格式化后的消息（发件人、时间、主题、正文）发送到 Telegram。
8. 附件作为真实文件附在同一条 Telegram 消息中：
   - **1 个附件** → `sendDocument` + 标题
   - **多个附件** → `sendMediaGroup`，标题放在第一个文件上
9. （可选）如果配置了 LLM API，会异步生成 AI 摘要并编辑原消息替换正文为摘要。
10. 消息发送前会按 `messageId` 做幂等去重，避免重复投递到 Telegram。
11. 处理失败时 Queue 自动重试（最多 3 次）；达到上限后消息丢弃。
12. Cron Trigger 每 6 天自动续订 Gmail watch（watch 7 天后过期）。

正文会自动截断以适应 Telegram 的字符限制（纯文本消息 4096 字符，附件标题 1024 字符）。

## 前置条件

- 一个 [Cloudflare](https://cloudflare.com) 账号
- 一个启用了 Gmail API 的 [Google Cloud](https://console.cloud.google.com) 项目
- 一个 Gmail / Google Workspace 账号
- 一个 [Telegram Bot](https://core.telegram.org/bots#how-do-i-create-a-bot) Token
- 接收消息的 Telegram Chat ID

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

#### 2c. 获取 Refresh Token

使用 Worker 提供的页面生成并保存 `refresh_token`：

1. 确认 Google OAuth Client 的 **Authorized redirect URIs** 已包含：
   `https://YOUR_WORKER_DOMAIN/oauth/google/callback`
2. 部署 Worker 后，打开：
   `https://YOUR_WORKER_DOMAIN/oauth/google?secret=YOUR_WATCH_SECRET`
3. 点击页面上的"开始授权并生成 Refresh Token"，完成 Google 登录授权
4. 回调页会自动把 `refresh_token` 保存到 `EMAIL_KV`（键名：`gmail_refresh_token`）

> 说明：`/oauth/google` 入口使用和 `/gmail/watch` 相同的 `GMAIL_WATCH_SECRET` 做保护。

#### 2d. 创建 Pub/Sub Topic 和 Subscription

```sh
# 创建 topic
gcloud pubsub topics create gmail-push

# 授权 Gmail 向此 topic 发布消息
gcloud pubsub topics add-iam-policy-binding gmail-push \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

# 部署 Worker 后，创建 push subscription（URL 中替换为你的 Worker 域名和密钥）
gcloud pubsub subscriptions create gmail-push-sub \
  --topic=gmail-push \
  --push-endpoint="https://YOUR_WORKER_DOMAIN/gmail/push?secret=YOUR_PUSH_SECRET" \
  --ack-deadline=30
```

### 3. 创建 KV 命名空间

```sh
npx wrangler kv namespace create EMAIL_KV
```

将返回的 `id` 填入 `wrangler.jsonc` 中 `kv_namespaces[0].id`。

### 3b. 创建 Queue

```sh
npx wrangler queues create gmail-tg-queue
```

Queue 用于串行处理 Gmail history 同步和邮件发送，内置重试。`wrangler.jsonc` 中已配置好 producer 和 consumer 绑定。

### 4. 配置 Secret Store + Secrets

先将 Telegram 相关机密放到账号级 Secret Store（推荐）：

```sh
# 远程创建/更新（生产）
npx wrangler secrets-store secret create 2450ac7560a346fda9b2538762a5eb07 --name TELEGRAM_TOKEN --scopes workers --remote
npx wrangler secrets-store secret create 2450ac7560a346fda9b2538762a5eb07 --name TELEGRAM_MY_ID --scopes workers --remote

# 本地开发（不加 --remote）
npx wrangler secrets-store secret create 2450ac7560a346fda9b2538762a5eb07 --name TELEGRAM_TOKEN --scopes workers
npx wrangler secrets-store secret create 2450ac7560a346fda9b2538762a5eb07 --name TELEGRAM_MY_ID --scopes workers
```

`wrangler.jsonc` 已将以下绑定指向 Secret Store：

- `TG_TOKEN` -> `TELEGRAM_TOKEN`
- `CHAT_ID` -> `TELEGRAM_MY_ID`

其余配置继续使用 Worker Secrets：

```sh
npx wrangler secret put GMAIL_CLIENT_ID      # Google OAuth2 Client ID
npx wrangler secret put GMAIL_CLIENT_SECRET  # Google OAuth2 Client Secret
npx wrangler secret put GMAIL_PUBSUB_TOPIC   # 例如 projects/my-project/topics/gmail-push
npx wrangler secret put GMAIL_PUSH_SECRET    # 自定义密钥，用于验证 Pub/Sub push
npx wrangler secret put GMAIL_WATCH_SECRET   # 自定义密钥，用于保护 /gmail/watch
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

### 6. 部署

```sh
npm run deploy
```

### 7. 激活 Gmail Watch

部署后，发送一个 POST 请求来注册 Gmail push 通知：

```sh
curl -X POST "https://YOUR_WORKER_DOMAIN/gmail/watch?secret=YOUR_WATCH_SECRET"
```

之后 Cron Trigger 会每 6 天自动续订。

## 开发

```sh
npm run dev       # 启动本地开发服务器
npm test          # 运行测试
npm run cf-typegen # 根据 wrangler.jsonc 重新生成 TypeScript 类型
```

## 项目结构

```text
src/
  index.ts             # Worker 入口（fetch/queue/scheduled 分发）
  constants.ts         # 路由/TTL/时间格式等常量
  types.ts             # 类型定义：Env, QueueMessage, PubSubPushBody, etc.
  handlers/
    http.tsx           # Hono 路由、中间件、JSX 页面渲染
    queue.ts           # Queue consumer（重试/ack/retry）
  components/
    layout.tsx         # 共享 Layout、Card、BackLink 组件 (Tailwind CSS)
    home.tsx           # 首页、Dashboard、HTML 预览页
    oauth.tsx          # OAuth 授权页、回调结果页、错误页
  services/
    bridge.ts          # Gmail→Telegram 业务流程编排（sync/message/AI 摘要）
    gmail.ts           # Gmail OAuth2 + REST API + watch + history
    home.ts            # 预览页业务逻辑（HTML→MarkdownV2 转换）
    oauth.ts           # OAuth 流程逻辑（token 交换、state 管理）
    ollama.ts          # OpenAI compatible API 调用（AI 摘要）
    telegram.ts        # Telegram 发送/编辑：text、attachments、caption
    secrets.ts         # Secret Store 读取（TG_TOKEN / CHAT_ID）
    observability.ts   # 错误结构化日志 + Telegram 告警
  lib/
    format.ts          # 邮件正文格式化：HTML→Markdown→Telegram MarkdownV2
    markdown-v2.ts     # MarkdownV2 转义与最长合法前缀解析
wrangler.jsonc         # Cloudflare Worker 配置（KV + Queue + Cron）
```

## 环境变量

| Secret / 变量         | 说明                                         |
| --------------------- | -------------------------------------------- |
| `TG_TOKEN`            | Secret Store 绑定：`TELEGRAM_TOKEN`          |
| `CHAT_ID`             | Secret Store 绑定：`TELEGRAM_MY_ID`          |
| `GMAIL_CLIENT_ID`     | Google OAuth2 Client ID                      |
| `GMAIL_CLIENT_SECRET` | Google OAuth2 Client Secret                  |
| `GMAIL_PUBSUB_TOPIC`  | Pub/Sub topic 全名 (projects/xxx/topics/yyy) |
| `GMAIL_PUSH_SECRET`   | 自定义密钥，附加在 push URL 中用于验证       |
| `GMAIL_WATCH_SECRET`  | 自定义密钥，用于保护管理页面和 watch 端点    |
| `LLM_API_URL`         | OpenAI compatible API base URL（可选）       |
| `LLM_API_KEY`         | LLM API key（可选）                          |
| `LLM_MODEL`           | LLM 模型名称（可选）                         |

`refresh_token` 不再使用 Worker Secret，统一保存在 `EMAIL_KV` 的 `gmail_refresh_token` 键中。

## API 端点

| 方法 | 路径                             | 说明                          |
| ---- | -------------------------------- | ----------------------------- |
| GET  | `/`                              | 登录页 / Dashboard            |
| POST | `/`                              | 密钥登录                      |
| POST | `/gmail/push?secret=XXX`         | Pub/Sub push 回调             |
| POST | `/gmail/watch?secret=XXX`        | 手动注册/续订 watch           |
| GET  | `/preview?secret=XXX`            | HTML→Telegram MarkdownV2 预览 |
| POST | `/preview?secret=XXX`            | 预览转换 API                  |
| GET  | `/oauth/google?secret=XXX`       | OAuth 授权说明页              |
| GET  | `/oauth/google/start?secret=XXX` | 发起 Google OAuth             |
| GET  | `/oauth/google/callback`         | OAuth 回调                    |

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
