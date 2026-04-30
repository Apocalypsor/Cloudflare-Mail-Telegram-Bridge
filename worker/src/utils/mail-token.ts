import { hmacSha256Hex, timingSafeEqual } from "@worker/utils/hash";

/** 生成基于 accountId 的邮件查看链接 HMAC-SHA256 token（32 字符截断） */
export async function generateMailTokenById(
  secret: string,
  emailMessageId: string,
  accountId: number,
): Promise<string> {
  return hmacSha256Hex(secret, `${emailMessageId}:${accountId}`, 32);
}

/** 验证基于 accountId 的邮件查看链接 token */
export async function verifyMailTokenById(
  secret: string,
  emailMessageId: string,
  accountId: number,
  token: string,
): Promise<boolean> {
  const expected = await generateMailTokenById(
    secret,
    emailMessageId,
    accountId,
  );
  return timingSafeEqual(expected, token);
}

/** 生成邮件 web 预览链接（自动签 token）。`folder` 用于告诉预览页从哪个文件夹取邮件（仅 IMAP 需要）。 */
export async function buildMailPreviewUrl(
  workerUrl: string,
  adminSecret: string,
  emailMessageId: string,
  accountId: number,
  folder?: "inbox" | "junk" | "archive",
): Promise<string> {
  const token = await generateMailTokenById(
    adminSecret,
    emailMessageId,
    accountId,
  );
  return buildWebMailUrl(workerUrl, emailMessageId, accountId, token, folder);
}

/** Web 版邮件页 URL（已有 token 时复用，避免重复签名） */
export function buildWebMailUrl(
  workerUrl: string,
  emailMessageId: string,
  accountId: number,
  token: string,
  folder?: "inbox" | "junk" | "archive",
): string {
  const base = `${workerUrl.replace(/\/$/, "")}/mail/${encodeURIComponent(emailMessageId)}?accountId=${accountId}&t=${encodeURIComponent(token)}`;
  return folder ? `${base}&folder=${folder}` : base;
}

/** Mini App 版邮件页 URL（与 ROUTE_MINI_APP_MAIL 同步） */
export function buildMiniAppMailUrl(
  workerUrl: string,
  emailMessageId: string,
  accountId: number,
  token: string,
): string {
  return `${workerUrl.replace(/\/$/, "")}/telegram-app/mail/${encodeURIComponent(emailMessageId)}?accountId=${accountId}&t=${encodeURIComponent(token)}`;
}

/** Mini App 版提醒页 URL（与 ROUTE_MINI_APP_REMINDERS 同步） */
export function buildMiniAppRemindersUrl(
  workerUrl: string,
  emailMessageId: string,
  accountId: number,
  token: string,
): string {
  return `${workerUrl.replace(/\/$/, "")}/telegram-app/reminders?accountId=${accountId}&emailMessageId=${encodeURIComponent(emailMessageId)}&token=${encodeURIComponent(token)}`;
}
