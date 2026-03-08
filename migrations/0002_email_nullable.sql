-- Migration: Make email nullable (auto-filled from Gmail API during OAuth)
-- SQLite doesn't support ALTER COLUMN, so we recreate the table.

CREATE TABLE accounts_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    chat_id TEXT NOT NULL,
    refresh_token TEXT,
    history_id TEXT,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO accounts_new (id, email, chat_id, refresh_token, history_id, label, created_at, updated_at)
    SELECT id, email, chat_id, refresh_token, history_id, label, created_at, updated_at FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
