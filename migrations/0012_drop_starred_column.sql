-- 移除 starred 列，星标状态以邮件源为 single source of truth
ALTER TABLE message_map DROP COLUMN starred;
