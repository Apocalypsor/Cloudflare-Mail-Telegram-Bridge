-- Rename gmail_message_id → email_message_id to support both Gmail and IMAP
ALTER TABLE message_map RENAME COLUMN gmail_message_id TO email_message_id;
ALTER TABLE failed_emails RENAME COLUMN gmail_message_id TO email_message_id;
