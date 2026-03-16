-- 移除废弃的 history_id 列，实际 history_id 存储在 KV 中
ALTER TABLE accounts DROP COLUMN history_id;
