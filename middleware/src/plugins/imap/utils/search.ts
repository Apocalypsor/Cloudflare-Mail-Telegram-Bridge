import type { ActiveConnection } from "@middleware/imap/types";
import type { MessageHit, MessageSummary } from "../types";

/**
 * 在 `folder` 里按 RFC 822 Message-Id 搜 UID。多条匹配时取最新（UID 最大）。
 * 没找到返回 null；folder 不存在 / 无权限 → 抛错由调用方处理。
 */
export async function findUidByMessageId(
  conn: ActiveConnection,
  folder: string,
  rfcMessageId: string,
): Promise<number | null> {
  const lock = await conn.client.getMailboxLock(folder);
  try {
    const hits = await conn.client.search(
      { header: { "message-id": rfcMessageId } },
      { uid: true },
    );
    if (!Array.isArray(hits) || hits.length === 0) return null;
    return (hits as number[]).sort((a, b) => b - a)[0];
  } finally {
    lock.release();
  }
}

/** 在候选文件夹里依次按 Message-Id 搜索，返回命中的 `{folder, uid}` 或 null */
export async function locateMessage(
  conn: ActiveConnection,
  rfcMessageId: string,
  folders: string[],
): Promise<MessageHit | null> {
  for (const folder of folders) {
    const uid = await findUidByMessageId(conn, folder, rfcMessageId);
    if (uid !== null) return { folder, uid };
  }
  return null;
}

export async function searchAndFetch(
  conn: ActiveConnection,
  folder: string,
  searchQuery: Record<string, unknown>,
  maxResults: number,
): Promise<MessageSummary[]> {
  const lock = await conn.client.getMailboxLock(folder);
  try {
    const result = await conn.client.search(searchQuery, { uid: true });
    if (!result || !Array.isArray(result)) return [];
    const uids = (result as number[])
      .sort((a: number, b: number) => b - a)
      .slice(0, maxResults);
    if (uids.length === 0) return [];

    const range = uids.join(",");
    const fetched = await conn.client.fetchAll(
      range,
      { envelope: true },
      { uid: true },
    );
    // 无 Message-Id 的邮件（罕见）直接跳过 —— 没法跨 folder 追踪，后续 action 也做不了
    return fetched
      .filter((msg) => !!msg.envelope?.messageId)
      .map((msg) => ({
        id: msg.envelope?.messageId as string,
        subject: msg.envelope?.subject ?? undefined,
      }));
  } finally {
    lock.release();
  }
}
