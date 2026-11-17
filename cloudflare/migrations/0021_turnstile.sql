CREATE TABLE captcha_redemptions(token_hash TEXT PRIMARY KEY,created REAL NOT NULL);
CREATE INDEX idx_captcha_redemptions_created ON captcha_redemptions(created);
CREATE TABLE captcha_attempts(scope TEXT NOT NULL,bucket INTEGER NOT NULL,attempts INTEGER NOT NULL,PRIMARY KEY(scope,bucket));
CREATE INDEX idx_captcha_attempts_bucket ON captcha_attempts(bucket);
