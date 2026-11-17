ALTER TABLE luna_usage ADD COLUMN model TEXT NOT NULL DEFAULT 'gpt-6-luna';
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

DROP TRIGGER price_legacy_luna_settlement;
CREATE TRIGGER price_legacy_luna_settlement AFTER UPDATE OF prompt_tokens,completion_tokens,cached_tokens,cache_write_tokens ON luna_usage WHEN NEW.model='gpt-6-luna' AND NEW.settled=1 AND NEW.charged_cost_nanos<>(max(0,NEW.prompt_tokens-NEW.cached_tokens-NEW.cache_write_tokens)*100+NEW.cached_tokens*10+NEW.cache_write_tokens*125+NEW.completion_tokens*500) BEGIN
 UPDATE luna_usage SET charged_cost_nanos=max(0,NEW.prompt_tokens-NEW.cached_tokens-NEW.cache_write_tokens)*100+NEW.cached_tokens*10+NEW.cache_write_tokens*125+NEW.completion_tokens*500 WHERE lease=NEW.lease;
END;
