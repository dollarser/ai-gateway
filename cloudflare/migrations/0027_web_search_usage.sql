ALTER TABLE luna_usage ADD COLUMN web_search_calls INTEGER
  CHECK(web_search_calls IS NULL OR web_search_calls >= 0);

DROP TRIGGER price_legacy_luna_settlement;
CREATE TRIGGER price_legacy_luna_settlement
AFTER UPDATE OF prompt_tokens,completion_tokens,cached_tokens,cache_write_tokens ON luna_usage
WHEN NEW.model='gpt-6-luna' AND NEW.web_search_calls IS NULL AND NEW.settled=1
AND NEW.charged_cost_nanos<>(max(0,NEW.prompt_tokens-NEW.cached_tokens-NEW.cache_write_tokens)*100+NEW.cached_tokens*10+NEW.cache_write_tokens*125+NEW.completion_tokens*500)
BEGIN
 UPDATE luna_usage SET charged_cost_nanos=max(0,NEW.prompt_tokens-NEW.cached_tokens-NEW.cache_write_tokens)*100+NEW.cached_tokens*10+NEW.cache_write_tokens*125+NEW.completion_tokens*500 WHERE lease=NEW.lease;
END;

ALTER TABLE users ADD COLUMN web_search_daily_calls INTEGER NOT NULL DEFAULT 30
  CHECK(web_search_daily_calls BETWEEN 0 AND 10000);
ALTER TABLE luna_usage ADD COLUMN web_search_day TEXT;
CREATE INDEX idx_luna_web_search_user_day ON luna_usage(user_id,web_search_day)
  WHERE web_search_day IS NOT NULL;

CREATE TRIGGER reserve_web_search_daily_budget
BEFORE INSERT ON luna_usage WHEN NEW.web_search_day IS NOT NULL
BEGIN
 SELECT CASE WHEN coalesce((
    SELECT sum(web_search_calls) FROM luna_usage
    WHERE user_id=NEW.user_id AND web_search_day=NEW.web_search_day
 ),0)+NEW.web_search_calls>(SELECT web_search_daily_calls FROM users WHERE id=NEW.user_id)
 THEN RAISE(ABORT,'web_search_daily_limit') END;
END;
