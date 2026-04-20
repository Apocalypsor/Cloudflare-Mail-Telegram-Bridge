-- Migration: add rfc_message_id column to message_map for IMAP cross-folder reconciliation
-- IMAP UID 是 per-folder 的，邮件被移出 INBOX 后原 UID 失效；RFC 822 Message-Id 是全局
-- 唯一的，middleware 用它 `SEARCH HEADER Message-Id` 可以在任何 folder 里定位这封邮件。
-- 仅 IMAP provider 的 reconcileMessageState 用到；Gmail/Outlook 忽略该列。
-- 历史 mapping 为 NULL（IMAP 无法精确对账，回退到旧 isJunk/isStarred 行为，不丢数据）。
ALTER TABLE message_map ADD COLUMN rfc_message_id TEXT;
