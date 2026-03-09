ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
-- 已有用户自动批准
UPDATE users SET approved = 1;
