-- Account data model shared with the SQLite migration tool.
CREATE TABLE access_tokens(
          hash TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES auth_families(id),expires REAL NOT NULL);
CREATE TABLE audit(
          id INTEGER PRIMARY KEY, actor INTEGER, action TEXT NOT NULL,
          target TEXT NOT NULL, ts REAL NOT NULL);
CREATE TABLE auth_families(
          id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
          expires REAL NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE inference_auth_failures(ip_hash TEXT NOT NULL, ts REAL NOT NULL);
CREATE TABLE keys(
          id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
          name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
          services TEXT NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
          created REAL NOT NULL, legacy_daily_tokens INTEGER NOT NULL DEFAULT 0);
CREATE TABLE legacy_token_baseline(key_id INTEGER NOT NULL,day TEXT NOT NULL,prompt_tokens INTEGER NOT NULL,completion_tokens INTEGER NOT NULL,PRIMARY KEY(key_id,day));
CREATE TABLE login_attempts(ip TEXT NOT NULL, ts REAL NOT NULL);
CREATE TABLE refresh_tokens(
          hash TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES auth_families(id),
          expires REAL NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE registration_attempts(ip_hash TEXT NOT NULL, ts REAL NOT NULL);
CREATE TABLE requests(
                  id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
                  key_id INTEGER REFERENCES keys(id),service TEXT NOT NULL,
                  auth_type TEXT NOT NULL DEFAULT 'api_key',path TEXT NOT NULL,
                  started REAL NOT NULL,day TEXT NOT NULL,ended REAL,status INTEGER,
                  response_bytes INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, request_id TEXT, client_request_id TEXT, helix_turn_id TEXT, helix_model_call_id TEXT, upstream_response_id TEXT);
CREATE TABLE sessions(
          hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
          csrf TEXT NOT NULL, expires REAL NOT NULL, family_id TEXT);
CREATE TABLE settings(name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users(
          id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
          role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          services TEXT NOT NULL, rpm INTEGER NOT NULL, daily_requests INTEGER NOT NULL,
          concurrency INTEGER NOT NULL, must_change INTEGER NOT NULL DEFAULT 0,
          created REAL NOT NULL, email TEXT);
CREATE INDEX idx_access_family ON access_tokens(family_id);
CREATE INDEX idx_inference_auth_ip ON inference_auth_failures(ip_hash,ts);
CREATE INDEX idx_login_ip ON login_attempts(ip,ts);
CREATE INDEX idx_refresh_family ON refresh_tokens(family_id);
CREATE INDEX idx_registration_ip ON registration_attempts(ip_hash,ts);
CREATE INDEX idx_requests_request_id ON requests(request_id);
CREATE INDEX idx_requests_user_day ON requests(user_id,day);
CREATE INDEX idx_requests_user_time ON requests(user_id,started);
CREATE UNIQUE INDEX idx_users_email ON users(email COLLATE NOCASE);
INSERT OR IGNORE INTO settings(name,value) VALUES('registration_defaults','{"rpm":30,"daily_requests":1000,"concurrency":2}');
-- Quota enforcement runs inside the same SQL statement as lease creation.
CREATE TRIGGER request_quota BEFORE INSERT ON requests BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND enabled=1 AND must_change=0 AND EXISTS(SELECT 1 FROM json_each(users.services) WHERE value=NEW.service)) THEN RAISE(ABORT,'account_permission') END;
 SELECT CASE WHEN NEW.key_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM keys WHERE id=NEW.key_id AND user_id=NEW.user_id AND revoked=0 AND expires>NEW.started AND EXISTS(SELECT 1 FROM json_each(keys.services) WHERE value=NEW.service)) THEN RAISE(ABORT,'key_permission') END;
 SELECT CASE WHEN (SELECT rpm FROM users WHERE id=NEW.user_id)>0 AND (SELECT count(*) FROM requests WHERE user_id=NEW.user_id AND started>NEW.started-60)>=(SELECT rpm FROM users WHERE id=NEW.user_id) THEN RAISE(ABORT,'quota_rpm') END;
 SELECT CASE WHEN (SELECT daily_requests FROM users WHERE id=NEW.user_id)>0 AND (SELECT count(*) FROM requests WHERE user_id=NEW.user_id AND day=NEW.day)>=(SELECT daily_requests FROM users WHERE id=NEW.user_id) THEN RAISE(ABORT,'quota_daily') END;
 SELECT CASE WHEN (SELECT count(*) FROM requests WHERE user_id=NEW.user_id AND ended IS NULL AND started>NEW.started-920)>=(SELECT concurrency FROM users WHERE id=NEW.user_id) THEN RAISE(ABORT,'quota_concurrency') END;
 SELECT CASE WHEN NEW.key_id IS NOT NULL AND (SELECT legacy_daily_tokens FROM keys WHERE id=NEW.key_id)>0 AND (SELECT coalesce(sum(prompt_tokens+completion_tokens),0) FROM requests WHERE key_id=NEW.key_id AND day=NEW.day)+coalesce((SELECT prompt_tokens+completion_tokens FROM legacy_token_baseline WHERE key_id=NEW.key_id AND day=NEW.day),0)>=(SELECT legacy_daily_tokens FROM keys WHERE id=NEW.key_id) THEN RAISE(ABORT,'quota_tokens') END;
END;
CREATE TRIGGER protect_last_admin BEFORE UPDATE OF enabled ON users WHEN OLD.role='admin' AND OLD.enabled=1 AND NEW.enabled=0 AND (SELECT count(*) FROM users WHERE role='admin' AND enabled=1)<=1 BEGIN SELECT RAISE(ABORT,'last_admin'); END;
