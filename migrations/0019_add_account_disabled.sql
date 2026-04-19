-- Migration: add disabled flag so users can pause an account without deleting it
-- disabled=1 会被 push/enqueue/cron/digest/list 全部跳过，但账号配置保留
ALTER TABLE accounts ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
