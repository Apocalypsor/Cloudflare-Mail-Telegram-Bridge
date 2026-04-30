import { cf } from "@worker/api/plugins/cf";
import {
  requireGmailPushSecret,
  requireImapBridgeBearer,
} from "@worker/api/plugins/secrets";
import { getImapAccounts } from "@worker/db/accounts";
import {
  GmailProvider,
  ImapProvider,
  OutlookProvider,
} from "@worker/providers";
import { timingSafeEqual } from "@worker/utils/hash";
import { Elysia } from "elysia";
import { OutlookPushQuery, PushBody } from "./model";

/**
 * Provider push webhooks。
 *  - Gmail: Pub/Sub push（query `?secret=GMAIL_PUSH_SECRET`）
 *  - Outlook: Graph subscription（先处理 `?validationToken=` 握手，再 secret）
 *  - IMAP: 中间件回调（Bearer + accounts list）
 *
 * 走的都是各 provider class 的 `enqueue` 静态方法，把消息丢进 Queue 后立即 200。
 */

const gmailPush = new Elysia({ name: "gmail-push" })
  .use(requireGmailPushSecret)
  .post(
    "/api/gmail/push",
    async ({ env, body }) => {
      await GmailProvider.enqueue(body as { message: { data: string } }, env);
      return "OK";
    },
    { body: PushBody },
  );

const outlookPush = new Elysia({ name: "outlook-push" }).use(cf).post(
  "/api/outlook/push",
  async ({ env, query, body, status }) => {
    // Graph subscription validation 握手 —— 必须早于鉴权
    const validationToken = query.validationToken;
    if (validationToken) {
      return new Response(validationToken, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const provided = query.secret;
    if (
      typeof provided !== "string" ||
      !env.MS_WEBHOOK_SECRET ||
      !timingSafeEqual(provided, env.MS_WEBHOOK_SECRET)
    ) {
      return status(403, "Forbidden");
    }

    await OutlookProvider.enqueue(
      body as Parameters<typeof OutlookProvider.enqueue>[0],
      env,
    );
    return "OK";
  },
  { body: PushBody, query: OutlookPushQuery },
);

const imapBridge = new Elysia({ name: "imap-bridge" })
  .use(requireImapBridgeBearer)
  .get("/api/imap/accounts", async ({ env }) => {
    const accounts = await getImapAccounts(env.DB);
    return accounts.map((acc) => ({
      id: acc.id,
      email: acc.email,
      chat_id: acc.chat_id,
      imap_host: acc.imap_host,
      imap_port: acc.imap_port,
      imap_secure: !!acc.imap_secure,
      imap_user: acc.imap_user,
      imap_pass: acc.imap_pass,
    }));
  })
  .post(
    "/api/imap/push",
    async ({ env, body }) => {
      await ImapProvider.enqueue(
        body as { accountId: number; rfcMessageId: string },
        env,
      );
      return "OK";
    },
    { body: PushBody },
  );

export const providersController = new Elysia({ name: "controller.providers" })
  .use(gmailPush)
  .use(outlookPush)
  .use(imapBridge);
