import { deleteMessage } from "@worker/clients/telegram";
import { getAccountById } from "@worker/db/accounts";
import { deliverEmailToTelegram } from "@worker/handlers/queue/utils";
import { getEmailProvider } from "@worker/providers";
import {
  type EmailQueueMessage,
  type Env,
  type QueueMessage,
  QueueMessageType,
} from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";

/** Queue consumer: 按 type 派发邮件投递 / 延迟删 TG 消息等任务 */
export async function handleQueueBatch(
  batch: MessageBatch<QueueMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const waitUntil = ctx.waitUntil.bind(ctx);
  for (const msg of batch.messages) {
    try {
      switch (msg.body.type) {
        case QueueMessageType.Email:
          await processEmailMessage(msg.body, env, waitUntil);
          break;
        case QueueMessageType.DeleteTgMessage:
          await deleteMessage(
            env.TELEGRAM_BOT_TOKEN,
            msg.body.chatId,
            msg.body.messageId,
          );
          break;
      }
      msg.ack();
    } catch (error: unknown) {
      await reportErrorToObservability(env, "queue.message_failed", error, {
        attempt: msg.attempts,
        body: msg.body,
      });
      msg.retry();
    }
  }
}

/** 按账号类型拉取原始邮件并投递到 Telegram */
async function processEmailMessage(
  msg: EmailQueueMessage,
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  const account = await getAccountById(env.DB, msg.accountId);
  if (!account) {
    console.log(
      `Account ${msg.accountId} not found, skipping email ${msg.emailMessageId}`,
    );
    return;
  }
  if (account.disabled) {
    console.log(
      `Account ${msg.accountId} is disabled, dropping email ${msg.emailMessageId}`,
    );
    return;
  }

  const provider = getEmailProvider(account, env);
  const rawEmail = await provider.fetchRawEmail(msg.emailMessageId);

  await deliverEmailToTelegram(
    rawEmail,
    msg.emailMessageId,
    account,
    env,
    waitUntil,
  );
}
