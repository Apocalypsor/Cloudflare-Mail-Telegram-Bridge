-- Reminders: bot 在 remind_at 时通过私聊向 telegram_user_id 推送 text。
-- sent_at IS NULL 表示待发送；发送成功后写入时间戳。
-- 每分钟 cron 扫一次待发送行，通过 idx_reminders_due 走索引。
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  remind_at TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reminders_due ON reminders(sent_at, remind_at);
CREATE INDEX idx_reminders_user ON reminders(telegram_user_id);
