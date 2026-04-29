import { getAccountById } from "@db/accounts";
import { getCachedMailData, putCachedMailData } from "@db/kv";
import { getMappingsByEmailIds } from "@db/message-map";
import type { Reminder } from "@db/reminders";
import { getEmailProvider, PROVIDERS } from "@providers";
import { generateMailTokenById, verifyMailTokenById } from "@utils/mail-token";
import type { Context } from "hono";
import type { AppEnv } from "@/types";

export type EnrichedReminder = Reminder & {
  mail_token: string | null;
  email_summary: string | null;
};

/**
 * 校验 (accountId, emailMessageId, token) 三元组：token 是 mail-preview 用的 HMAC，
 * 等价于"持有该邮件的查看权"。返回查到的 account；否则返回错误响应。
 */
export async function resolveEmailContext(
  c: Context<AppEnv>,
  accountIdRaw: unknown,
  emailMessageId: unknown,
  token: unknown,
): Promise<
  | {
      ok: true;
      account: NonNullable<Awaited<ReturnType<typeof getAccountById>>>;
      accountId: number;
      emailMessageId: string;
    }
  | { ok: false; status: 400 | 403 | 404; error: string }
> {
  const accountId = Number(accountIdRaw);
  if (!Number.isInteger(accountId) || accountId <= 0)
    return { ok: false, status: 400, error: "Invalid accountId" };
  if (typeof emailMessageId !== "string" || !emailMessageId)
    return { ok: false, status: 400, error: "Invalid emailMessageId" };
  if (typeof token !== "string" || !token)
    return { ok: false, status: 400, error: "Invalid token" };

  const valid = await verifyMailTokenById(
    c.env.ADMIN_SECRET,
    emailMessageId,
    accountId,
    token,
  );
  if (!valid) return { ok: false, status: 403, error: "Forbidden" };

  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return { ok: false, status: 404, error: "账号不存在" };
  return { ok: true, account, accountId, emailMessageId };
}

/** 找投递时存的 mapping 和邮件展示文本。
 *  优先级：mapping.short_summary（LLM 一句话摘要，已在 mapping 查询里返回，零 I/O）
 *  → KV 缓存 subject（preview 打开过才有）→ provider 现拉 subject（兜底）。 */
export async function lookupEmailContext(
  c: Context<AppEnv>,
  account: NonNullable<Awaited<ReturnType<typeof getAccountById>>>,
  emailMessageId: string,
): Promise<{
  tgChatId: string | null;
  tgMessageId: number | null;
  subject: string | null;
}> {
  const mappings = await getMappingsByEmailIds(c.env.DB, account.id, [
    emailMessageId,
  ]);
  const m = mappings[0];

  // 1) LLM 摘要（已经在 mapping 行里）
  let subject: string | null = m?.short_summary ?? null;

  // 2) 没 LLM 摘要 → 三 folder 查 KV 缓存（preview.tsx 写入）
  if (subject == null) {
    for (const folder of ["inbox", "junk", "archive"] as const) {
      const cached = await getCachedMailData(
        c.env.EMAIL_KV,
        account.id,
        folder,
        emailMessageId,
      );
      if (cached?.meta?.subject) {
        subject = cached.meta.subject;
        break;
      }
    }
  }

  // 3) 还没有 → 现拉一次 fetchForPreview，写回 KV 给下次用。OAuth provider
  //    没授权 / 邮件已删 → 静默回退，UI 兜底 "(无主题)"。
  if (subject == null) {
    const needsAuth = PROVIDERS[account.type].oauth && !account.refresh_token;
    if (!needsAuth) {
      try {
        const provider = getEmailProvider(account, c.env);
        const result = await provider.fetchForPreview(emailMessageId, "inbox");
        if (result?.meta?.subject) {
          subject = result.meta.subject;
          await putCachedMailData(
            c.env.EMAIL_KV,
            account.id,
            "inbox",
            emailMessageId,
            { html: result.html, meta: result.meta },
          ).catch(() => {});
        }
      } catch {
        // ignore
      }
    }
  }

  return {
    tgChatId: m?.tg_chat_id ?? null,
    tgMessageId: m?.tg_message_id ?? null,
    subject,
  };
}

/** 给 listOnly 模式（主菜单"我的提醒"）的 reminder 列表附加：
 *   - `mail_token`: 基于 (emailMessageId, accountId) 的 HMAC，与键盘里 web 链接用的同一份。
 *     前端点击提醒跳邮件预览页要用，不扩大用户已有的访问权。
 *   - `email_summary`: message_map 里 LLM 一句话摘要的最新值，前端 fallback 到 email_subject。
 *  按 (accountId, emailMessageId) 去重 —— 同一封邮件的多条提醒共享同一份 HMAC + mapping，
 *  避免重复计算。mapping 批量查 + HMAC 计算两路并发。 */
export async function enrichReminders(
  c: Context<AppEnv>,
  items: Reminder[],
): Promise<EnrichedReminder[]> {
  const uniq = new Map<string, { accountId: number; emailMessageId: string }>();
  for (const r of items) {
    if (r.account_id && r.email_message_id)
      uniq.set(`${r.account_id}:${r.email_message_id}`, {
        accountId: r.account_id,
        emailMessageId: r.email_message_id,
      });
  }

  const idsByAccount = new Map<number, string[]>();
  for (const { accountId, emailMessageId } of uniq.values()) {
    const arr = idsByAccount.get(accountId);
    if (arr) arr.push(emailMessageId);
    else idsByAccount.set(accountId, [emailMessageId]);
  }

  const tokenByKey = new Map<string, string>();
  const summaryByKey = new Map<string, string>();
  await Promise.all([
    ...Array.from(idsByAccount.entries()).map(async ([accountId, ids]) => {
      const mappings = await getMappingsByEmailIds(c.env.DB, accountId, ids);
      for (const m of mappings) {
        if (m.short_summary)
          summaryByKey.set(
            `${accountId}:${m.email_message_id}`,
            m.short_summary,
          );
      }
    }),
    ...Array.from(uniq.entries()).map(async ([key, v]) => {
      tokenByKey.set(
        key,
        await generateMailTokenById(
          c.env.ADMIN_SECRET,
          v.emailMessageId,
          v.accountId,
        ),
      );
    }),
  ]);

  return items.map((r) => {
    const key =
      r.account_id && r.email_message_id
        ? `${r.account_id}:${r.email_message_id}`
        : null;
    return {
      ...r,
      mail_token: key ? (tokenByKey.get(key) ?? null) : null,
      email_summary: key ? (summaryByKey.get(key) ?? null) : null,
    };
  });
}
