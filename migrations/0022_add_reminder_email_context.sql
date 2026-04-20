-- 给 reminders 增加邮件上下文：
--   - 主要入口改为「邮件 TG 消息上的 ⏰ 按钮」→ Mini App 带 accountId+messageId 打开
--   - 到期发送时用 tg_chat_id + reply_to_message_id 把提醒挂在原邮件消息下
--   - email_subject 在创建时快照，即便原邮件被删/归档也有上下文
-- 已有 /remind 通用模式不受影响：所有邮件相关列为 NULL → 私聊推送 telegram_user_id。
-- text 之前是 NOT NULL，邮件提醒下用户可不填备注，所以放宽默认值；老行不受影响。
ALTER TABLE reminders ADD COLUMN account_id INTEGER;
ALTER TABLE reminders ADD COLUMN email_message_id TEXT;
ALTER TABLE reminders ADD COLUMN email_subject TEXT;
ALTER TABLE reminders ADD COLUMN tg_chat_id TEXT;
ALTER TABLE reminders ADD COLUMN tg_message_id INTEGER;
