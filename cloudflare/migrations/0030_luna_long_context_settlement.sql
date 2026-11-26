-- Retain the fallback for older Workers that settle tokens without writing cost.
DROP TRIGGER price_legacy_luna_settlement;
CREATE TRIGGER price_legacy_luna_settlement
AFTER UPDATE OF prompt_tokens,completion_tokens,cached_tokens,cache_write_tokens ON luna_usage
WHEN NEW.model='gpt-6-luna' AND NEW.web_search_calls IS NULL AND NEW.settled=1
  AND NEW.charged_cost_nanos=OLD.charged_cost_nanos
BEGIN
 UPDATE luna_usage
 SET charged_cost_nanos=CASE WHEN NEW.prompt_tokens>272000 THEN
   2*(max(0,NEW.prompt_tokens-NEW.cached_tokens-NEW.cache_write_tokens)*100
      +NEW.cached_tokens*10+NEW.cache_write_tokens*125)+NEW.completion_tokens*750
 ELSE
   max(0,NEW.prompt_tokens-NEW.cached_tokens-NEW.cache_write_tokens)*100
      +NEW.cached_tokens*10+NEW.cache_write_tokens*125+NEW.completion_tokens*500
 END
 WHERE lease=NEW.lease;
END;

-- Repair only settled non-search Luna rows matching the former short rate.
-- The existing settle_luna_spend trigger synchronizes spend and its monthly rollup.
UPDATE luna_usage
SET charged_cost_nanos=2*(max(0,prompt_tokens-cached_tokens-cache_write_tokens)*100
  +cached_tokens*10+cache_write_tokens*125)+completion_tokens*750
WHERE model='gpt-6-luna' AND web_search_calls IS NULL AND settled=1 AND prompt_tokens>272000
  AND charged_cost_nanos=max(0,prompt_tokens-cached_tokens-cache_write_tokens)*100
    +cached_tokens*10+cache_write_tokens*125+completion_tokens*500
  AND charged_tokens=prompt_tokens+completion_tokens;
