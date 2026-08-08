import { cf } from "@worker/api/plugins/cf";
import { requireGmailPushSecret } from "@worker/api/plugins/secrets";
import { GmailProvider } from "@worker/providers/gmail";
import { OutlookProvider } from "@worker/providers/outlook";
import { timingSafeEqual } from "@worker/utils/hash";
import { Elysia } from "elysia";
import { OutlookPushQuery, PushBody } from "./model";

/**
 * Provider push webhooks。
 *  - Gmail: Pub/Sub push（query `?secret=GMAIL_PUSH_SECRET`）
 *  - Outlook: Graph subscription（先处理 `?validationToken=` 握手，再 secret）
 *  - IMAP: Cloudflare Email Routing handler 作为 push signal，见 `handlers/email`
 *
 * 走的都是各 provider class 的 `dispatch` 静态方法，把直接投递放进 waitUntil 后立即 200。
 */

const gmailPush = new Elysia({ name: "gmail-push" })
  .use(cf)
  .use(requireGmailPushSecret)
  .post(
    "/api/gmail/push",
    async ({ env, body, waitUntil }) => {
      await GmailProvider.dispatch(
        body as { message: { data: string } },
        env,
        waitUntil,
      );
      return "OK";
    },
    { body: PushBody },
  );

const outlookPush = new Elysia({ name: "outlook-push" }).use(cf).post(
  "/api/outlook/push",
  async ({ env, query, body, status, waitUntil }) => {
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

    await OutlookProvider.dispatch(
      body as Parameters<typeof OutlookProvider.dispatch>[0],
      env,
      waitUntil,
    );
    return "OK";
  },
  { body: PushBody, query: OutlookPushQuery },
);

export const providersController = new Elysia({ name: "controller.providers" })
  .use(gmailPush)
  .use(outlookPush);
