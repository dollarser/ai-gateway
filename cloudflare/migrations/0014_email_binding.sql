CREATE UNIQUE INDEX idx_users_verified_email ON users(lower(email)) WHERE email_verified_at IS NOT NULL AND email IS NOT NULL;
ALTER TABLE email_send_attempts ADD COLUMN user_id INTEGER;
CREATE INDEX idx_email_send_attempts_user ON email_send_attempts(user_id,ts);
CREATE TABLE account_email_codes(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,email_hash TEXT NOT NULL,id TEXT NOT NULL,code_hash TEXT NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending');
CREATE INDEX idx_account_email_codes_expiry ON account_email_codes(expires);
