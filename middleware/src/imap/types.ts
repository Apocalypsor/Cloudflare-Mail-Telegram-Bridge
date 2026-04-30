import type { ImapAccount } from "@middleware/utils/telemail-client";
import type { ImapFlow } from "imapflow";

/** 单账号 IMAP 连接状态：account 元数据 + 当前 client（断线时为 null）+ 已处理 UID 水位。 */
export interface Connection {
  account: ImapAccount;
  client: ImapFlow | null;
  active: boolean;
  lastUid: number;
}

/** `Connection` 的 narrowed 形式 —— 进入 IMAP 操作前已确认 client 在线。 */
export type ActiveConnection = Connection & { client: ImapFlow };
