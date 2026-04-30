import { getAccountById } from "@worker/db/accounts";
import { getMessageMapping, type MessageMapping } from "@worker/db/message-map";
import { t } from "@worker/i18n";
import type { Account, Env } from "@worker/types";

/**
 * 从 TG 消息定位到对应的 mail mapping + account。
 * mapping 或 account 缺失时返回 `{ error }`，调用方把 error 直接塞给 `answerCallbackQuery`。
 *
 * 用于 inline button handler（archive / junk / ...）共享的入口样板。
 */
export async function resolveMessageAccount(
  env: Env,
  chatId: string,
  tgMessageId: number,
): Promise<
  | { ok: true; mapping: MessageMapping; account: Account }
  | { ok: false; error: string }
> {
  const mapping = await getMessageMapping(env.DB, chatId, tgMessageId);
  if (!mapping) return { ok: false, error: t("common:error.mappingNotFound") };
  const account = await getAccountById(env.DB, mapping.account_id);
  if (!account)
    return { ok: false, error: t("common:error.accountNotFoundShort") };
  return { ok: true, mapping, account };
}
