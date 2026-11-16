-- Remove duplicate/amount-covering indexes on hot write paths; retain period lookup indexes.
DROP INDEX idx_users_verified_email;
DROP INDEX idx_luna_month_cost;
DROP INDEX idx_audio_day_kind;
DROP INDEX idx_luna_spend_month;
CREATE INDEX idx_luna_spend_month ON luna_spend(month);
DROP INDEX idx_audio_spend_day;
CREATE INDEX idx_audio_spend_day ON audio_spend(day,kind);
DROP INDEX idx_requests_request_id;
CREATE INDEX idx_requests_request_id ON requests(request_id) WHERE request_id IS NOT NULL;
DROP INDEX idx_requests_provider_time;
CREATE INDEX idx_requests_provider_time ON requests(provider,started) WHERE provider IS NOT NULL;
DROP TRIGGER record_luna_spend;
DROP TRIGGER settle_luna_spend;
DROP TRIGGER price_legacy_luna_settlement;
DROP TRIGGER settle_audio_spend;
CREATE TRIGGER record_luna_spend AFTER INSERT ON luna_usage BEGIN
 INSERT INTO luna_spend(lease,month,cost_nanos,settled) VALUES(NEW.lease,NEW.month,CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END,NEW.settled);
 UPDATE luna_usage SET charged_cost_nanos=CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END,reserved_cost_nanos=max(reserved_cost_nanos,CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END) WHERE lease=NEW.lease AND (charged_cost_nanos<>(CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END) OR reserved_cost_nanos<(CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END));
END;
CREATE TRIGGER settle_luna_spend AFTER UPDATE OF charged_cost_nanos,settled ON luna_usage WHEN OLD.charged_cost_nanos<>NEW.charged_cost_nanos OR OLD.settled<>NEW.settled BEGIN
 UPDATE luna_spend SET cost_nanos=(SELECT charged_cost_nanos FROM luna_usage WHERE lease=NEW.lease),settled=NEW.settled WHERE lease=NEW.lease AND (cost_nanos<>(SELECT charged_cost_nanos FROM luna_usage WHERE lease=NEW.lease) OR settled<>NEW.settled);
END;
CREATE TRIGGER price_legacy_luna_settlement AFTER UPDATE OF prompt_tokens,completion_tokens,cached_tokens,cache_write_tokens ON luna_usage WHEN NEW.settled=1 AND NEW.charged_cost_nanos<>(max(0,NEW.prompt_tokens-NEW.cached_tokens-NEW.cache_write_tokens)*100+NEW.cached_tokens*10+NEW.cache_write_tokens*125+NEW.completion_tokens*500) BEGIN
 UPDATE luna_usage SET charged_cost_nanos=max(0,NEW.prompt_tokens-NEW.cached_tokens-NEW.cache_write_tokens)*100+NEW.cached_tokens*10+NEW.cache_write_tokens*125+NEW.completion_tokens*500 WHERE lease=NEW.lease;
END;
CREATE TRIGGER settle_audio_spend AFTER UPDATE OF charged_units,settled ON audio_usage WHEN NEW.charged_units<>OLD.charged_units OR NEW.settled<>OLD.settled BEGIN
 UPDATE audio_spend SET units=NEW.charged_units,settled=NEW.settled WHERE lease=NEW.lease AND (units<>NEW.charged_units OR settled<>NEW.settled);
END;
