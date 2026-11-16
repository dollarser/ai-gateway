ALTER TABLE users ADD COLUMN email_verified_at REAL;
CREATE TABLE registration_codes(email_hash TEXT PRIMARY KEY,id TEXT NOT NULL,code_hash TEXT NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending');
CREATE INDEX idx_registration_codes_expiry ON registration_codes(expires);
CREATE TABLE email_send_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,ip_hash TEXT NOT NULL,email_hash TEXT NOT NULL,ts REAL NOT NULL);
CREATE INDEX idx_email_send_attempts_ip ON email_send_attempts(ip_hash,ts);
CREATE INDEX idx_email_send_attempts_email ON email_send_attempts(email_hash,ts);
CREATE INDEX idx_email_send_attempts_ts ON email_send_attempts(ts);
