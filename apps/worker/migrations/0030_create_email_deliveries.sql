CREATE TABLE email_deliveries (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email_message_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'sending', 'retryable', 'unknown')),
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    PRIMARY KEY (account_id, email_message_id)
);

CREATE INDEX idx_email_deliveries_state_updated_at
    ON email_deliveries (state, updated_at);
