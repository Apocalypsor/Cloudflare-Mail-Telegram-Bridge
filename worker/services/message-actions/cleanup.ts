import {
  deleteMappingByEmailId,
  getMappingsByEmailIds,
  type MessageMapping,
} from "@db/message-map";
import { deleteMessage } from "@services/telegram";
import type { Env } from "@/types";

/** 删除 TG 消息 + mapping（邮件不再归属 INBOX 时统一清理）。
 *  调用方拿到了 mapping 时直接用；只有 (account, emailMessageId) 时用下面的
 *  `cleanupTgForEmail` 包一层。 */
export async function removeFromTelegram(
  env: Env,
  mapping: MessageMapping,
): Promise<void> {
  await deleteMessage(
    env.TELEGRAM_BOT_TOKEN,
    mapping.tg_chat_id,
    mapping.tg_message_id,
  ).catch(() => {});
  await deleteMappingByEmailId(
    env.DB,
    mapping.email_message_id,
    mapping.account_id,
  ).catch(() => {});
}

/** 邮件被 markAsJunk / archive / trash 之后清理 TG 侧的残留：
 *  查 mapping → 删 TG 消息 + mapping。没 mapping（邮件没投递过）就 no-op。 */
export async function cleanupTgForEmail(
  env: Env,
  accountId: number,
  emailMessageId: string,
): Promise<void> {
  const mappings = await getMappingsByEmailIds(env.DB, accountId, [
    emailMessageId,
  ]);
  if (mappings.length === 0) return;
  await removeFromTelegram(env, mappings[0]);
}

/** 删除垃圾邮件对应的 Telegram 消息和映射（junk 列表刷新时调用） */
export async function deleteJunkMappings(
  env: Env,
  mappings: MessageMapping[],
): Promise<void> {
  for (const m of mappings) {
    await deleteMessage(
      env.TELEGRAM_BOT_TOKEN,
      m.tg_chat_id,
      m.tg_message_id,
    ).catch(() => {});
    await deleteMappingByEmailId(
      env.DB,
      m.email_message_id,
      m.account_id,
    ).catch(() => {});
  }
}
