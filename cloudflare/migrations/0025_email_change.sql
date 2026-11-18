-- Separate from registration, initial binding and password recovery proofs.
CREATE TABLE email_change_challenges(
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 id TEXT NOT NULL, old_email TEXT NOT NULL, new_email TEXT NOT NULL,
 email_hash TEXT NOT NULL, code_hash TEXT NOT NULL, password_version TEXT NOT NULL,
 created REAL NOT NULL, expires REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'pending', consumed_by TEXT
);
CREATE INDEX idx_email_change_expiry ON email_change_challenges(expires);
