import type { ActiveConnection } from "@middleware/imap/types";
import type { FolderHint } from "../types";

export const findSpecialFolder = async (
  conn: ActiveConnection,
  specialUse: string,
  nameMatches: string[],
): Promise<string | null> => {
  const mailboxes = await conn.client.list();
  const box =
    mailboxes.find((m) => m.specialUse === specialUse) ??
    mailboxes.find((m) => nameMatches.includes(m.name.toLowerCase()));
  return box?.path ?? null;
};

export const findJunkFolder = (conn: ActiveConnection) =>
  findSpecialFolder(conn, "\\Junk", ["junk", "junk email", "spam"]);

export const findTrashFolder = (conn: ActiveConnection) =>
  findSpecialFolder(conn, "\\Trash", [
    "trash",
    "deleted items",
    "deleted messages",
    "bin",
  ]);

export const findArchiveFolder = (conn: ActiveConnection) =>
  findSpecialFolder(conn, "\\Archive", [
    "archive",
    "archives",
    "all mail",
    "[gmail]/all mail",
  ]);

/**
 * 解析归档目标文件夹：
 * 1. 调用方显式指定 → 用指定的
 * 2. 否则查 `\Archive` special-use / 常见名字
 * 3. 都没有 → fallback 到字面量 "Archive"
 */
export async function resolveArchiveFolder(
  conn: ActiveConnection,
  explicit: string | undefined,
): Promise<string> {
  if (explicit) return explicit;
  return (await findArchiveFolder(conn)) ?? "Archive";
}

/**
 * `fetchEmail` 要在哪些文件夹里找 Message-Id —— 不同 hint 给出不同候选顺序。
 * 顺序决定了命中速度 + 歧义（同一 Message-Id 极少数情况会在 All Mail + INBOX
 * 同时存在，hint 让调用方主导选哪封）。
 */
export async function resolveFetchCandidates(
  conn: ActiveConnection,
  folderHint: FolderHint | undefined,
  archiveFolder: string | undefined,
): Promise<string[]> {
  const junk = async () => (await findJunkFolder(conn)) ?? undefined;
  const archive = () => resolveArchiveFolder(conn, archiveFolder);

  switch (folderHint) {
    case "archive":
      return [await archive()];
    case "junk": {
      const j = await junk();
      return j ? [j, "INBOX"] : ["INBOX"];
    }
    default: {
      const j = await junk();
      return j ? ["INBOX", j] : ["INBOX"];
    }
  }
}
