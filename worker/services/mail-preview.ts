import { getCachedMailData, putCachedMailData } from "@db/kv";
import { getEmailProvider, PROVIDERS } from "@providers";
import { proxyImages, replaceCidReferences } from "@utils/mail-html";
import type { Account, Env, MailMeta } from "@/types";

// ─── 邮件预览数据加载（web /mail/:id 和 mini app /telegram-app/mail/:id 共用） ─

type Folder = "inbox" | "junk" | "archive";

export type LoadedMailPreview =
  | {
      ok: true;
      meta: MailMeta;
      /** CID 内联完成、未走图片代理的原始 HTML —— 关闭代理时直接渲染 */
      rawHtml: string;
      /** 在 rawHtml 基础上再做外链图片代理改写 —— 默认渲染这个 */
      proxiedHtml: string;
      fetchFolder: Folder;
      inJunk: boolean;
      starred: boolean;
    }
  | { ok: false; status: 403 | 404; reason: string };

/** 拿邮件渲染所需的全部数据：folder 推断 → KV 缓存命中或 provider 现拉
 *  → CID 内联 → 写回 KV → 图片代理。两个 mail 页 handler 共享同一份逻辑。 */
export async function loadMailForPreview(
  env: Env,
  account: Account,
  emailMessageId: string,
  folderHint?: string,
): Promise<LoadedMailPreview> {
  const provider = getEmailProvider(account, env);
  const [inJunk, starred] = await Promise.all([
    provider.isJunk(emailMessageId).catch(() => false),
    provider.isStarred(emailMessageId).catch(() => false),
  ]);
  const fetchFolder: Folder =
    folderHint === "archive"
      ? "archive"
      : folderHint === "junk" || inJunk
        ? "junk"
        : "inbox";

  const cached = await getCachedMailData(
    env.EMAIL_KV,
    account.id,
    fetchFolder,
    emailMessageId,
  );
  if (cached) {
    return {
      ok: true,
      meta: cached.meta ?? {},
      rawHtml: cached.html,
      proxiedHtml: await proxyImages(cached.html, env.ADMIN_SECRET),
      fetchFolder,
      inJunk,
      starred,
    };
  }

  if (PROVIDERS[account.type].oauth && !account.refresh_token)
    return { ok: false, status: 403, reason: "Account not authorized" };

  const result = await provider.fetchForPreview(emailMessageId, fetchFolder);
  if (!result)
    return { ok: false, status: 404, reason: "No content in this email" };

  const html = replaceCidReferences(result.html, result.cidMap);
  await putCachedMailData(
    env.EMAIL_KV,
    account.id,
    fetchFolder,
    emailMessageId,
    {
      html,
      meta: result.meta,
    },
  );
  return {
    ok: true,
    meta: result.meta ?? {},
    rawHtml: html,
    proxiedHtml: await proxyImages(html, env.ADMIN_SECRET),
    fetchFolder,
    inJunk,
    starred,
  };
}
