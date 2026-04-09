-- Migration: Drop unique index on gmail email to allow multiple accounts with the same email
DROP INDEX IF EXISTS idx_accounts_gmail_email;
