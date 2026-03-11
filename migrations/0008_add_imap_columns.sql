ALTER TABLE accounts ADD COLUMN type TEXT NOT NULL DEFAULT 'gmail';
ALTER TABLE accounts ADD COLUMN imap_host TEXT;
ALTER TABLE accounts ADD COLUMN imap_port INTEGER;
ALTER TABLE accounts ADD COLUMN imap_secure INTEGER;
ALTER TABLE accounts ADD COLUMN imap_user TEXT;
ALTER TABLE accounts ADD COLUMN imap_pass TEXT;
