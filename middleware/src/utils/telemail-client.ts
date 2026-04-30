import ky from "ky";
import { config } from "../config";

const api = ky.create({
  prefixUrl: config.workerUrl,
  headers: { Authorization: `Bearer ${config.bridgeSecret}` },
  retry: { limit: 3, methods: ["get", "post"], backoffLimit: 5_000 },
  timeout: 60_000,
});

/** 与 Telemail Worker 中 accounts 表对应的 IMAP 账号信息 */
export interface ImapAccount {
  id: number;
  email: string;
  chat_id: string;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  imap_user: string;
  imap_pass: string;
}

/** 从 Telemail Worker 拉取所有 IMAP 账号 */
export const fetchImapAccounts = (): Promise<ImapAccount[]> =>
  api.get("api/imap/accounts").json<ImapAccount[]>();

/** 通知 Telemail Worker 有新邮件到达（accountId + RFC 822 Message-Id），Worker 将入队后按需拉取原文 */
export const notifyNewEmail = (
  accountId: number,
  rfcMessageId: string,
): Promise<void> =>
  api
    .post("api/imap/push", { json: { accountId, rfcMessageId } })
    .then(() => {});
