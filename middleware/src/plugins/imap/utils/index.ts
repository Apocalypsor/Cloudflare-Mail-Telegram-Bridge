/**
 * `plugins/imap/utils/` barrel —— plugin 内部 helper（folder 解析 + UID 搜索），
 * 仅供 `plugins/imap/index.ts` 自己用，不出 plugin 边界。
 */
export {
  findArchiveFolder,
  findJunkFolder,
  findSpecialFolder,
  findTrashFolder,
  resolveArchiveFolder,
  resolveFetchCandidates,
} from "./folders";
export { findUidByMessageId, locateMessage, searchAndFetch } from "./search";
