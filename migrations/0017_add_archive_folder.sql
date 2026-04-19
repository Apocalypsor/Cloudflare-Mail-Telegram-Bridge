-- Migration: Add per-account archive folder/label override
-- Gmail: stores label ID to apply on archive (NULL = archive disabled, since
--   Gmail's native "remove INBOX" sends mail to All Mail which is rarely useful)
-- IMAP:  stores destination folder name (NULL = falls back to "Archive")
-- Outlook: unused (always uses well-known "archive" folder)
ALTER TABLE accounts ADD COLUMN archive_folder TEXT;
