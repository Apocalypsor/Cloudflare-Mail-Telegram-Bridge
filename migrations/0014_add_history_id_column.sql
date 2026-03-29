-- 将 history_id 从 KV 迁回 D1，作为 accounts 表的列
ALTER TABLE accounts ADD COLUMN history_id TEXT;
