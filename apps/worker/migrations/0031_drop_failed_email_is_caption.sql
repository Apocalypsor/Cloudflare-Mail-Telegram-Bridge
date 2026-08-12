-- Deploy the Rich HTML-only Worker before applying this destructive migration.
ALTER TABLE failed_emails DROP COLUMN is_caption;
