-- Account-wide monthly input + output token budget; zero disables Luna.
ALTER TABLE users ADD COLUMN luna_monthly_tokens INTEGER NOT NULL DEFAULT 10000000 CHECK(luna_monthly_tokens>=0);
INSERT INTO settings(name,value) VALUES('luna_defaults','{"monthly_tokens":10000000}');
CREATE TABLE luna_usage(
 lease TEXT PRIMARY KEY REFERENCES requests(id),
 user_id INTEGER NOT NULL REFERENCES users(id),
 month TEXT NOT NULL,
 reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>=0),
 charged_tokens INTEGER NOT NULL CHECK(charged_tokens>=0),
 settled INTEGER NOT NULL DEFAULT 0,
 prompt_tokens INTEGER NOT NULL DEFAULT 0,
 completion_tokens INTEGER NOT NULL DEFAULT 0,
 cached_tokens INTEGER NOT NULL DEFAULT 0,
 cache_write_tokens INTEGER NOT NULL DEFAULT 0,
 response_id TEXT
);
CREATE INDEX idx_luna_user_month ON luna_usage(user_id,month);
CREATE TRIGGER luna_reservation BEFORE INSERT ON luna_usage BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM requests r JOIN users u ON u.id=r.user_id
  WHERE r.id=NEW.lease AND r.user_id=NEW.user_id AND r.service='qwen'
   AND r.path IN ('/v1/chat/completions','/v1/responses') AND r.ended IS NULL
   AND u.enabled=1 AND u.must_change=0 AND EXISTS(SELECT 1 FROM json_each(u.services) WHERE value='qwen')
   AND (r.key_id IS NULL OR EXISTS(SELECT 1 FROM keys k WHERE k.id=r.key_id AND k.user_id=u.id AND k.revoked=0 AND k.expires>unixepoch() AND EXISTS(SELECT 1 FROM json_each(k.services) WHERE value='qwen')))
 ) THEN RAISE(ABORT,'account_permission') END;
 SELECT CASE WHEN (SELECT luna_monthly_tokens FROM users WHERE id=NEW.user_id)=0 OR
  (SELECT coalesce(sum(charged_tokens),0) FROM luna_usage WHERE user_id=NEW.user_id AND month=NEW.month)+NEW.charged_tokens>
  (SELECT luna_monthly_tokens FROM users WHERE id=NEW.user_id)
 THEN RAISE(ABORT,'luna_budget_exhausted') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM requests r JOIN keys k ON k.id=r.key_id WHERE r.id=NEW.lease AND k.legacy_daily_tokens>0 AND
   (SELECT coalesce(sum(CASE WHEN l.lease IS NULL THEN r2.prompt_tokens+r2.completion_tokens ELSE l.prompt_tokens+l.completion_tokens END),0) FROM requests r2 LEFT JOIN luna_usage l ON l.lease=r2.id WHERE r2.key_id=k.id AND r2.day=r.day)+
   coalesce((SELECT prompt_tokens+completion_tokens FROM legacy_token_baseline WHERE key_id=k.id AND day=r.day),0)+
   NEW.prompt_tokens+NEW.completion_tokens>k.legacy_daily_tokens
 ) THEN RAISE(ABORT,'quota_tokens') END;
END;
