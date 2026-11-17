CREATE TABLE password_reset_codes(
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,id TEXT NOT NULL,code_hash TEXT NOT NULL,
  password_version TEXT NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX idx_password_reset_codes_expiry ON password_reset_codes(expires);
CREATE INDEX idx_password_reset_codes_email ON password_reset_codes(email_hash);
