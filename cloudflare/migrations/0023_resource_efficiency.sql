-- Exact personal balances; updates stay in the same transaction as each ledger change.
CREATE TABLE luna_user_month_totals(
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,month TEXT NOT NULL,
 used_tokens INTEGER NOT NULL CHECK(used_tokens>=0),reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>=0),
 requests INTEGER NOT NULL CHECK(requests>=0),prompt_tokens INTEGER NOT NULL CHECK(prompt_tokens>=0),completion_tokens INTEGER NOT NULL CHECK(completion_tokens>=0),
 PRIMARY KEY(user_id,month)
);
INSERT INTO luna_user_month_totals SELECT user_id,month,sum(charged_tokens),sum(CASE WHEN settled=0 THEN charged_tokens ELSE 0 END),count(*),sum(prompt_tokens),sum(completion_tokens) FROM luna_usage GROUP BY user_id,month;
CREATE TRIGGER personal_luna_insert AFTER INSERT ON luna_usage BEGIN
 INSERT INTO luna_user_month_totals VALUES(NEW.user_id,NEW.month,NEW.charged_tokens,CASE WHEN NEW.settled=0 THEN NEW.charged_tokens ELSE 0 END,1,NEW.prompt_tokens,NEW.completion_tokens)
 ON CONFLICT(user_id,month) DO UPDATE SET used_tokens=used_tokens+excluded.used_tokens,reserved_tokens=reserved_tokens+excluded.reserved_tokens,requests=requests+1,prompt_tokens=prompt_tokens+excluded.prompt_tokens,completion_tokens=completion_tokens+excluded.completion_tokens;
END;
CREATE TRIGGER personal_luna_update AFTER UPDATE OF user_id,month,charged_tokens,settled,prompt_tokens,completion_tokens ON luna_usage
 WHEN NEW.user_id=OLD.user_id AND NEW.month=OLD.month AND (NEW.charged_tokens<>OLD.charged_tokens OR NEW.settled<>OLD.settled OR NEW.prompt_tokens<>OLD.prompt_tokens OR NEW.completion_tokens<>OLD.completion_tokens) BEGIN
 UPDATE luna_user_month_totals SET used_tokens=used_tokens+NEW.charged_tokens-OLD.charged_tokens,reserved_tokens=reserved_tokens+(CASE WHEN NEW.settled=0 THEN NEW.charged_tokens ELSE 0 END)-(CASE WHEN OLD.settled=0 THEN OLD.charged_tokens ELSE 0 END),prompt_tokens=prompt_tokens+NEW.prompt_tokens-OLD.prompt_tokens,completion_tokens=completion_tokens+NEW.completion_tokens-OLD.completion_tokens WHERE user_id=NEW.user_id AND month=NEW.month;
END;
CREATE TRIGGER personal_luna_move AFTER UPDATE OF user_id,month ON luna_usage WHEN NEW.user_id<>OLD.user_id OR NEW.month<>OLD.month BEGIN
 UPDATE luna_user_month_totals SET used_tokens=used_tokens-OLD.charged_tokens,reserved_tokens=reserved_tokens-(CASE WHEN OLD.settled=0 THEN OLD.charged_tokens ELSE 0 END),requests=requests-1,prompt_tokens=prompt_tokens-OLD.prompt_tokens,completion_tokens=completion_tokens-OLD.completion_tokens WHERE user_id=OLD.user_id AND month=OLD.month;
 INSERT INTO luna_user_month_totals VALUES(NEW.user_id,NEW.month,NEW.charged_tokens,CASE WHEN NEW.settled=0 THEN NEW.charged_tokens ELSE 0 END,1,NEW.prompt_tokens,NEW.completion_tokens)
 ON CONFLICT(user_id,month) DO UPDATE SET used_tokens=used_tokens+excluded.used_tokens,reserved_tokens=reserved_tokens+excluded.reserved_tokens,requests=requests+1,prompt_tokens=prompt_tokens+excluded.prompt_tokens,completion_tokens=completion_tokens+excluded.completion_tokens;
END;
CREATE TRIGGER personal_luna_delete AFTER DELETE ON luna_usage BEGIN
 UPDATE luna_user_month_totals SET used_tokens=used_tokens-OLD.charged_tokens,reserved_tokens=reserved_tokens-(CASE WHEN OLD.settled=0 THEN OLD.charged_tokens ELSE 0 END),requests=requests-1,prompt_tokens=prompt_tokens-OLD.prompt_tokens,completion_tokens=completion_tokens-OLD.completion_tokens WHERE user_id=OLD.user_id AND month=OLD.month;
END;
CREATE INDEX idx_requests_privacy_started ON requests(started) WHERE client_ip IS NOT NULL OR user_agent IS NOT NULL OR device_id IS NOT NULL;
CREATE TABLE maintenance_request_candidates(id TEXT PRIMARY KEY);
DROP TRIGGER luna_reservation;
CREATE TRIGGER luna_reservation BEFORE INSERT ON luna_usage BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM requests r JOIN users u ON u.id=r.user_id
  WHERE r.id=NEW.lease AND r.user_id=NEW.user_id AND r.service='qwen'
   AND r.path IN ('/v1/chat/completions','/v1/responses','/v1/embeddings') AND r.ended IS NULL
   AND u.enabled=1 AND u.must_change=0 AND EXISTS(SELECT 1 FROM json_each(u.services) WHERE value='qwen')
   AND (r.key_id IS NULL OR EXISTS(SELECT 1 FROM keys k WHERE k.id=r.key_id AND k.user_id=u.id AND k.revoked=0 AND k.expires>unixepoch() AND EXISTS(SELECT 1 FROM json_each(k.services) WHERE value='qwen')))
 ) THEN RAISE(ABORT,'account_permission') END;
 SELECT CASE WHEN (SELECT luna_monthly_tokens FROM users WHERE id=NEW.user_id)=0 OR
  coalesce((SELECT used_tokens FROM luna_user_month_totals WHERE user_id=NEW.user_id AND month=NEW.month),0)+NEW.charged_tokens>
  (SELECT luna_monthly_tokens FROM users WHERE id=NEW.user_id)
 THEN RAISE(ABORT,'luna_budget_exhausted') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM requests r JOIN keys k ON k.id=r.key_id WHERE r.id=NEW.lease AND k.legacy_daily_tokens>0 AND
   (SELECT coalesce(sum(CASE WHEN l.lease IS NULL THEN r2.prompt_tokens+r2.completion_tokens ELSE l.prompt_tokens+l.completion_tokens END),0) FROM requests r2 LEFT JOIN luna_usage l ON l.lease=r2.id WHERE r2.key_id=k.id AND r2.day=r.day)+
   coalesce((SELECT prompt_tokens+completion_tokens FROM legacy_token_baseline WHERE key_id=k.id AND day=r.day),0)+
   NEW.prompt_tokens+NEW.completion_tokens>k.legacy_daily_tokens
 ) THEN RAISE(ABORT,'quota_tokens') END;
END;
