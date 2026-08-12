# 部署

部署顺序：外部服务（GCP / MS Entra）→ Cloudflare 资源（D1 / KV）→ Worker + Pages → Telegram webhook + Mini App 注册。

所有 Worker secrets、GitHub Actions secrets 和 bindings 的完整说明见 [ENVIRONMENT.md](./ENVIRONMENT.md)。

## 1. 前置条件

- [Cloudflare](https://cloudflare.com) 账号
- [Telegram Bot](https://core.telegram.org/bots#how-do-i-create-a-bot) token（`@BotFather` 创建）
- 接收消息的 Telegram Chat ID（每个邮箱账号可配置不同的 Chat）
- **Gmail**：启用了 Gmail API 的 [Google Cloud](https://console.cloud.google.com) 项目
- **Outlook**：[Microsoft Entra ID](https://entra.microsoft.com) 应用注册
- **IMAP**：邮箱服务支持 IMAP 读取，并能设置自动转发到 Cloudflare Email Routing 地址

安装依赖：

```sh
bun install
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
  --push-endpoint="https://YOUR_WORKER_DOMAIN/api/gmail/push?secret=<GMAIL_PUSH_SECRET>" \
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

`wrangler.jsonc` 在 `apps/worker/` 下。首次本地 setup：

```sh
cp apps/worker/wrangler.example.jsonc apps/worker/wrangler.jsonc
```

把下面创建出来的 D1 / KV ID 填进 `apps/worker/wrangler.jsonc`。如果用 GitHub Actions 部署，同步配置 repo secrets：`CF_D1_DATABASE_ID`、`CF_KV_NAMESPACE_ID`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。

### 4.1 D1 数据库

```sh
bun wrangler d1 create gmail-tg-bridge
```

首次建库后从仓库根跑：

```sh
bun migrate:worker:remote
```

以后有 D1 migration 时，优先让 migration 与新旧 Worker 都兼容。若 migration
会删除或重命名现有字段，先部署不再依赖旧字段的新 Worker，确认生效后再运行
`bun migrate:worker:remote`；新增兼容字段的 migration 可以先执行。

### 4.2 KV 命名空间

```sh
bun wrangler kv namespace create EMAIL_KV
```

### 4.3 Secrets

按 [ENVIRONMENT.md §Secrets](./ENVIRONMENT.md#secrets) 配置核心 secrets，并按你启用的 Gmail / Outlook / IMAP / 可选功能补齐对应小节。

## 5. Worker 部署

如果本次发布包含兼容性 migration，可以先跑：

```sh
bun migrate:worker:remote
```

```sh
bun deploy:worker
```

`wrangler deploy` 不会自动跑 D1 migrations。

删除或重命名字段时顺序相反：先 `bun deploy:worker`，确认新版本正常，再运行
`bun migrate:worker:remote`，避免旧 Worker 在部署窗口继续读写已经不存在的字段。
仓库的 GitHub Actions production job 已按这个顺序在 Worker 部署成功后自动执行
D1 migrations；以上命令用于手动部署。

### 5.1 设置 Telegram Webhook

```sh
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR_WORKER_DOMAIN/api/telegram/webhook?secret=<TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message", "channel_post", "callback_query", "message_reaction", "message_reaction_count"]
  }'
```

Forum supergroup 可用作“General 操作区 + Inbox 邮件区”：把 bot 设为管理员并授予“管理话题”权限后，在 General topic 里发送 `/start`，bot 会创建 `Inbox` topic，并返回 Chat ID / Inbox Topic ID。群聊里打开 Mini App 菜单需要配置 `TG_MINI_APP_SHORT_NAME`。

> **注意**：邮件转发到**频道**时，Bot 需被设为频道管理员才能接收 reaction 事件。

## 6. Pages 部署（Mini App 前端 + web 工具页）

前端 SPA 和 Worker 共享一个自定义域名，通过 Workers Routes 按路径分流：

- `example.com/api/*`、`/oauth/*` → Worker
- 其它（`/`、`/mail/*`、`/preview`、`/junk-check`、`/login`、`/telegram-app/*`）→ Pages

### 6.1 创建 Pages 项目

首次创建 Pages 项目（用 wrangler 一行就行）：

```sh
bun build:page
bun wrangler pages project create telemail-web --production-branch=main
bun wrangler pages deploy apps/page/dist --project-name=telemail-web --branch=main
```

也可以在 Cloudflare 控制台手动创建。绑定自定义域名：Pages 项目 → Custom domains。

### 6.2 配置 Workers Routes

Workers & Pages → 你的 Worker → Settings → Triggers → Routes，只保留：

```
example.com/api/*
example.com/oauth/*
```

### 6.3 配置 Bot / Mini App

BotFather：

- `/setdomain` 设为 `example.com`
- `/newapp` 注册 Mini App，Web App URL 填 `https://example.com/telegram-app`，short name 记下来

把刚才的 short name 配到 `TG_MINI_APP_SHORT_NAME`。

## 6.4 配置 IMAP Email Routing（可选，仅当要接 IMAP 账号时）

### 准备

1. 准备一个独立收件域名，例如 `telemail-inbox.example`。不要复用已在其他邮箱服务接收邮件的主域名。
2. 在 Cloudflare 启用 Email Routing / Email Service，并按提示配置该域名的 MX / TXT。
3. 先部署 Worker，再创建 Email Routing rule。
4. 把这个收件域名配置到 `IMAP_FORWARD_DOMAIN`。

Email Routing rule：

| 字段 | 值 |
| --- | --- |
| Email pattern | `fwd` |
| Domain | `IMAP_FORWARD_DOMAIN` 对应域名 |
| Subaddressing | enabled |
| Action | Send to Worker |
| Worker | `telemail` |

不要在 Email pattern 里填 `fwd-*`；Cloudflare 这里不是 glob，`*` 不合法。启用 Subaddressing 后，`fwd+<token>@domain` 会命中 `fwd@domain` 这条规则。

## 7. 添加邮箱账号

通过 Telegram Mini App 管理：

1. 向 Bot 发送 `/start` → **账号管理** 打开 Mini App
2. 在 Mini App 里选择账号类型（Gmail / Outlook / IMAP），填写 Chat ID 和必要配置
3. Gmail / Outlook 需完成 OAuth 授权（先确保 `WORKER_URL` 已配置，且 OAuth redirect URI 指向同一域名）；IMAP 需填写服务器信息和密码，并把邮箱自动转发到账号详情显示的 `fwd+<token>` 地址
4. 授权或转发设置完成后，新邮件会实时推送到 Telegram，并由每 10 分钟的未读邮件拉取兜底

管理员可从 `/start` → **全局管理** → **用户管理** 打开 Mini App 审批、撤回或删除用户。
