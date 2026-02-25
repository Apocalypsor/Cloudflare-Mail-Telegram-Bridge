# gmail-tg-bridge

一个 Cloudflare Worker，通过 **Gmail API + Google Cloud Pub/Sub** 推送通知监控 Gmail 收件箱，并将新邮件转发到 Telegram 聊天——包括附件。

## 工作原理

1. Gmail 检测到收件箱中有新邮件，通过 Google Cloud Pub/Sub 发送推送通知。
2. Pub/Sub 向 Worker 的 `/gmail/push` 端点发送 HTTP POST 请求。
3. Worker 调用 Gmail API `history.list` 获取自上次检查点以来的新消息 ID。
4. 消息 ID 被批量投递到 **Cloudflare Queue**（`max_concurrency: 1` 保证串行处理，避免重复）。
5. Queue Consumer 逐条拉取原始 RFC 2822 邮件，使用 [postal-mime](https://github.com/nickytonline/postal-mime) 解析。
6. 格式化后的消息（发件人、时间、主题、正文）发送到 Telegram。
7. 附件作为真实文件附在同一条 Telegram 消息中：
   - **1 个附件** → `sendDocument` + 标题
   - **多个附件** → `sendMediaGroup`，标题放在第一个文件上
8. 处理失败时 Queue 自动重试（最多 3 次），成功后自动 ack。
9. Cron Trigger 每 6 天自动续订 Gmail watch（watch 7 天后过期）。

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
4. Authorized redirect URIs 添加 `https://developers.google.com/oauthplayground`
5. 记录 `Client ID` 和 `Client Secret`

#### 2c. 获取 Refresh Token

1. 打开 [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
2. 点击右上角齿轮 ⚙️ → 勾选 **Use your own OAuth credentials** → 填入上一步的 Client ID 和 Secret
3. 左侧选择 **Gmail API v1** → 勾选 `https://www.googleapis.com/auth/gmail.readonly`
4. 点击 **Authorize APIs** → 登录并授权
5. 点击 **Exchange authorization code for tokens**
6. 记录 `Refresh Token`

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

Queue 用于串行处理邮件，内置重试机制，无需手动去重。`wrangler.jsonc` 中已配置好 producer 和 consumer 绑定。

### 4. 配置 Secrets

```sh
npx wrangler secret put TG_TOKEN             # Telegram Bot Token
npx wrangler secret put CHAT_ID              # Telegram Chat ID
npx wrangler secret put GMAIL_CLIENT_ID      # Google OAuth2 Client ID
npx wrangler secret put GMAIL_CLIENT_SECRET  # Google OAuth2 Client Secret
npx wrangler secret put GMAIL_REFRESH_TOKEN  # Google OAuth2 Refresh Token
npx wrangler secret put GMAIL_USER_EMAIL     # 你的 Gmail 邮箱地址
npx wrangler secret put GMAIL_PUBSUB_TOPIC   # 例如 projects/my-project/topics/gmail-push
npx wrangler secret put GMAIL_PUSH_SECRET    # 自定义密钥，用于验证 Pub/Sub push
```

### 5. 部署

```sh
npm run deploy
```

### 6. 激活 Gmail Watch

部署后，发送一个 POST 请求来注册 Gmail push 通知：

```sh
curl -X POST https://YOUR_WORKER_DOMAIN/gmail/watch
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
  index.ts        # Worker 入口 — fetch（Pub/Sub → Queue 入队）+ queue consumer + scheduled（watch 续订）
  types.ts        # 类型定义：Env, PubSubPushBody, GmailNotification, Attachment, QueueMessage
  gmail.ts        # Gmail OAuth2 + REST API + watch + history 拉取 + base64url 解码
  telegram.ts     # Telegram 发送：sendTextMessage, sendWithAttachments
  format.ts       # 邮件格式化：node-html-markdown(HTML→Markdown) + telegram-markdown-v2(MarkdownV2 转换)
test/
  index.spec.ts   # 测试
wrangler.jsonc    # Cloudflare Worker 配置（KV + Queue + Cron）
```

## 环境变量（Secrets）

| Secret                | 说明                                         |
| --------------------- | -------------------------------------------- |
| `TG_TOKEN`            | Telegram Bot API Token                       |
| `CHAT_ID`             | 接收消息的 Telegram Chat ID                  |
| `GMAIL_CLIENT_ID`     | Google OAuth2 Client ID                      |
| `GMAIL_CLIENT_SECRET` | Google OAuth2 Client Secret                  |
| `GMAIL_REFRESH_TOKEN` | Google OAuth2 Refresh Token                  |
| `GMAIL_USER_EMAIL`    | Gmail 邮箱地址                               |
| `GMAIL_PUBSUB_TOPIC`  | Pub/Sub topic 全名 (projects/xxx/topics/yyy) |
| `GMAIL_PUSH_SECRET`   | 自定义密钥，附加在 push URL 中用于验证       |

## API 端点

| 方法 | 路径                     | 说明                |
| ---- | ------------------------ | ------------------- |
| GET  | `/`                      | 健康检查            |
| POST | `/gmail/push?secret=XXX` | Pub/Sub push 回调   |
| POST | `/gmail/watch`           | 手动注册/续订 watch |

## Telegram 消息格式

```text
发件人:  Name <email@example.com>
时  间:  2026/2/22 10:30:00
主  题:  Subject line

（正文内容，过长时自动截断）
```

附件会作为可下载文件附在同一条消息中。

## 许可证

私有
