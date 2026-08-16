import { hmacSha256Hex, timingSafeEqual } from "@worker/utils/hash";
import { normalizeBaseUrl } from "@worker/utils/url";

interface MailPreviewCredentialsInput {
  access?: string;
  accountId?: unknown;
  token?: unknown;
}

/** 生成基于 accountId 的邮件查看链接 HMAC-SHA256 token（32 字符截断） */
export const generateMailTokenById = async (
  secret: string,
  emailMessageId: string,
  accountId: number,
): Promise<string> => {
  return hmacSha256Hex(secret, `${emailMessageId}:${accountId}`, 32);
};

/** 验证基于 accountId 的邮件查看链接 token */
export const verifyMailTokenById = async (
  secret: string,
  emailMessageId: string,
  accountId: number,
  token: string,
): Promise<boolean> => {
  const expected = await generateMailTokenById(
    secret,
    emailMessageId,
    accountId,
  );
  return timingSafeEqual(expected, token);
};

const parseMailPreviewAccess = (
  access: string,
): { accountId: number; token: string } | null => {
  const separator = access.indexOf(".");
  if (separator <= 0 || separator !== access.lastIndexOf(".")) return null;

  const accountId = Number(access.slice(0, separator));
  const token = access.slice(separator + 1);
  if (!Number.isInteger(accountId) || accountId <= 0 || !token) return null;

  return { accountId, token };
};

/** 归一化新 `access` 或旧 `accountId + token` 凭证。 */
export const parseMailPreviewCredentials = (
  input: MailPreviewCredentialsInput,
): { accountId: unknown; token: unknown } | null => {
  if (input.access !== undefined) {
    return parseMailPreviewAccess(input.access);
  }
  return { accountId: input.accountId, token: input.token };
};

/** Web 版邮件页 URL（已有 token 时复用，避免重复签名） */
export const buildWebMailUrl = (
  workerUrl: string,
  emailMessageId: string,
  accountId: number,
  token: string,
  folder?: "inbox" | "junk" | "archive",
): string => {
  const access = encodeURIComponent(`${accountId}.${token}`);
  const base = `${normalizeBaseUrl(workerUrl)}/mail/${encodeURIComponent(emailMessageId)}?access=${access}`;
  return folder ? `${base}&folder=${folder}` : base;
};

/** Mini App 版邮件页 URL（与 ROUTE_MINI_APP_MAIL 同步） */
export const buildMiniAppMailUrl = (
  workerUrl: string,
  emailMessageId: string,
  accountId: number,
  token: string,
): string => {
  return `${normalizeBaseUrl(workerUrl)}/telegram-app/mail/${encodeURIComponent(emailMessageId)}?accountId=${accountId}&t=${encodeURIComponent(token)}`;
};

/** Mini App 版提醒页 URL（与 ROUTE_MINI_APP_REMINDERS 同步） */
export const buildMiniAppRemindersUrl = (
  workerUrl: string,
  emailMessageId: string,
  accountId: number,
  token: string,
): string => {
  return `${normalizeBaseUrl(workerUrl)}/telegram-app/reminders?accountId=${accountId}&emailMessageId=${encodeURIComponent(emailMessageId)}&token=${encodeURIComponent(token)}`;
};
