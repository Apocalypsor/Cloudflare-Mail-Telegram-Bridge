# 部署

把 Telemail 部署起来要经过这些阶段：外部服务（GCP / MS Entra）→ Cloudflare 资源（D1 / KV / Queue）→ Worker + Pages → Telegram webhook + Mini App 注册。

## 1. 前置条件

- [Cloudflare](https://cloudflare.com) 账号
- [Telegram Bot](https://core.telegram.org/bots#how-do-i-create-a-bot) token（`@BotFather` 创建）
- 接收消息的 Telegram Chat ID（每个邮箱账号可配置不同的 Chat）
- **Gmail**：启用了 Gmail API 的 [Google Cloud](https://console.cloud.google.com) 项目
- **Outlook**：[Microsoft Entra ID](https://entra.microsoft.com) 应用注册
- **IMAP**：外部 IMAP Bridge 中间件（私有项目，可选）

安装依赖：

```sh
pnpm install
```

## 2. Google Cloud（Gmail）

### 2.1 启用 Gmail API

1. 打开 [Google Cloud Console](https://console.cloud.google.com)
2. 创建或选择一个项目
3. **APIs & Services → Library** → 搜索 **Gmail API** → 启用

### 2.2 OAuth2 凭据

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. 应用类型选 **Web application**
3. Authorized redirect URIs 填 `https://YOUR_WORKER_DOMAIN/oauth/gmail/callback`
4. 记录 **Client ID** 和 **Client Secret**

### 2.3 Pub/Sub Topic + Subscription

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

## 3. Microsoft Entra ID（Outlook，可选）

1. [Microsoft Entra ID](https://entra.microsoft.com) → Applications → App registrations → **New registration**
2. 名称随意，账户类型选 **Accounts in any organizational directory and personal Microsoft accounts**
3. Redirect URI 添加 **Web** 类型：`https://YOUR_WORKER_DOMAIN/oauth/outlook/callback`
4. 注册后记下 **Application (client) ID**
5. **Certificates & secrets → New client secret** → 记下 Value
6. **API permissions → Add a permission → Microsoft Graph → Delegated permissions** → 勾选 `Mail.ReadWrite`、`offline_access`、`User.Read`

## 4. Cloudflare 资源

> 下面所有 `pnpm wrangler …` 命令需要在 `worker/` 子包目录里执行（wrangler 只装在该子包），或者从仓库根用 `pnpm --filter telemail-worker exec wrangler …`。`wrangler.jsonc` 也在 `worker/` 下。

### 4.1 D1 数据库

```sh
pnpm wrangler d1 create gmail-tg-bridge
```

把返回的 `database_id` 填入 `wrangler.jsonc` 中 `d1_databases[0].database_id`。然后从仓库根跑：

```sh
pnpm migrate:worker:remote
```

### 4.2 KV 命名空间

```sh
pnpm wrangler kv namespace create EMAIL_KV
```

返回的 `id` 填入 `wrangler.jsonc` 中 `kv_namespaces[0].id`。用途：access_token 缓存、消息去重、OAuth state。

### 4.3 Queue

```sh
pnpm wrangler queues create gmail-tg-queue
```

`wrangler.jsonc` 中已经配好 producer / consumer 绑定。Queue 用于串行处理邮件，内置重试。

### 4.4 Secrets

所有 secret 的用途和"哪些必填 / 哪些可选"见 [ENVIRONMENT.md](./ENVIRONMENT.md)。最小集：

```sh
pnpm wrangler secret put TELEGRAM_BOT_TOKEN
pnpm wrangler secret put ADMIN_TELEGRAM_ID
pnpm wrangler secret put ADMIN_SECRET
pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET
# Gmail
pnpm wrangler secret put GMAIL_CLIENT_ID
pnpm wrangler secret put GMAIL_CLIENT_SECRET
pnpm wrangler secret put GMAIL_PUBSUB_TOPIC
pnpm wrangler secret put GMAIL_PUSH_SECRET
```

## 5. Worker 部署

```sh
pnpm deploy:worker
```

### 5.1 设置 Telegram Webhook

```sh
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR_WORKER_DOMAIN/api/telegram/webhook?secret=YOUR_TELEGRAM_WEBHOOK_SECRET",
    "allowed_updates": ["message", "channel_post", "callback_query", "message_reaction", "message_reaction_count"]
  }'
```

- `message`：`/start` 等命令、群/私聊里的服务消息（pin cleanup 等）
- `channel_post`：频道里的服务消息（频道 post 走这个 update type，不走 `message`）
- `callback_query`：星标按钮点击
- `message_reaction` / `message_reaction_count`：emoji reaction（群组/频道）

> **注意**：邮件转发到**频道**时，Bot 需被设为频道管理员才能接收 reaction 事件。

## 6. Pages 部署（Mini App 前端 + web 工具页）

方案：同域 Workers Routes。前端 SPA 和 Worker 共享一个自定义域名，通过 Workers Routes 按路径分流：

- `example.com/api/*`、`/oauth/*` → Worker
- 其它（`/`、`/mail/*`、`/preview`、`/junk-check`、`/login`、`/telegram-app/*`）→ Pages

同源，零 CORS。

### 6.1 创建 Pages 项目

1. Cloudflare Pages 创建项目，接入 Git 仓库
2. **Build command**: `corepack enable && pnpm install --filter telemail-page && pnpm --filter telemail-page build`
3. **Build output directory**: `page/dist`
4. 绑定自定义域名（和 Worker 同域）

### 6.2 配置 Workers Routes

Workers & Pages → 你的 Worker → Settings → Triggers → Routes，只保留：

```
example.com/api/*
example.com/oauth/*
```

其它路径自然落到 Pages。

### 6.3 配置 Bot / Mini App

BotFather：

- `/setdomain` 设为 `example.com`
- `/newapp` 注册 Mini App，Web App URL 填 `https://example.com/telegram-app`，short name 记下来

Worker 的 `WORKER_URL` 和 `TG_MINI_APP_SHORT_NAME` secret 分别填 `https://example.com` 和刚才的 short name：

```sh
pnpm wrangler secret put WORKER_URL
pnpm wrangler secret put TG_MINI_APP_SHORT_NAME
```

## 7. 添加邮箱账号

通过 Telegram Bot 管理：

1. 向 Bot 发送 `/start` → **账号管理** → **添加账号**
2. 选择账号类型（Gmail / Outlook / IMAP），按提示完成配置
3. Gmail / Outlook 需完成 OAuth 授权；IMAP 需填写服务器信息和密码
4. 授权成功后自动创建 webhook 订阅，新邮件实时推送到 Telegram

后续 Cron Trigger 会自动维护：每分钟分发到期提醒；每小时检查 IMAP 中间件健康并重试失败的 LLM 摘要；每天凌晨（UTC 0 点）自动续订所有账号的推送通知。
