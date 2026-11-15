-- USD nanodollars: Standard Luna input=100, cached=10, cache write=125, output=500 per token.
ALTER TABLE luna_usage ADD COLUMN reserved_cost_nanos INTEGER NOT NULL DEFAULT 0 CHECK(reserved_cost_nanos>=0);
ALTER TABLE luna_usage ADD COLUMN charged_cost_nanos INTEGER NOT NULL DEFAULT 0 CHECK(charged_cost_nanos>=0);
UPDATE luna_usage SET reserved_cost_nanos=prompt_tokens*125+completion_tokens*500,
 charged_cost_nanos=CASE WHEN settled=0 THEN prompt_tokens*125+completion_tokens*500 ELSE max(0,prompt_tokens-cached_tokens-cache_write_tokens)*100+cached_tokens*10+cache_write_tokens*125+completion_tokens*500 END;
-- Independent spend ledger survives account/usage deletion. Provider cost is not refunded by deleting users.
CREATE TABLE luna_spend(lease TEXT PRIMARY KEY,month TEXT NOT NULL,cost_nanos INTEGER NOT NULL CHECK(cost_nanos>=0),settled INTEGER NOT NULL);
CREATE INDEX idx_luna_spend_month ON luna_spend(month,cost_nanos);
INSERT INTO luna_spend SELECT lease,month,charged_cost_nanos,settled FROM luna_usage;
CREATE INDEX idx_luna_month_cost ON luna_usage(month,charged_cost_nanos);
CREATE INDEX idx_audio_day_kind ON audio_usage(day,kind,charged_units);
INSERT INTO settings(name,value) VALUES('global_limits','{"cloud_enabled":true,"luna_monthly_usd":200,"asr_daily_minutes":null,"tts_daily_characters":null}');
INSERT INTO settings(name,value) VALUES('registration_policy','{"enabled":true,"ip_hourly":5,"global_hourly":100,"global_minute":15}');
CREATE TABLE identity_attempts(kind TEXT NOT NULL,hash TEXT NOT NULL,ts REAL NOT NULL);
CREATE INDEX idx_identity_attempts ON identity_attempts(kind,hash,ts);
CREATE TABLE diagnostic_probe_slots(slot TEXT PRIMARY KEY,created REAL NOT NULL);
CREATE TABLE operational_alerts(kind TEXT PRIMARY KEY,first_seen REAL NOT NULL,last_seen REAL NOT NULL,occurrences INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'open',details TEXT NOT NULL);
CREATE TABLE request_history(user_id INTEGER NOT NULL,day TEXT NOT NULL,service TEXT NOT NULL,total INTEGER NOT NULL,failed INTEGER NOT NULL,response_bytes INTEGER NOT NULL,prompt_tokens INTEGER NOT NULL,completion_tokens INTEGER NOT NULL,PRIMARY KEY(user_id,day,service));
CREATE INDEX idx_requests_ended_time ON requests(ended,started);
CREATE INDEX idx_access_expiry ON access_tokens(expires);
CREATE INDEX idx_refresh_expiry ON refresh_tokens(expires);
ALTER TABLE quota_adjustments ADD COLUMN previous_cost_nanos INTEGER;
ALTER TABLE quota_adjustments ADD COLUMN new_cost_nanos INTEGER;
ALTER TABLE requests ADD COLUMN first_byte_ms INTEGER;

-- Old Worker versions settling in-flight requests still price their final usage.
-- Manual reconciliation does not write prompt/completion fields and is unaffected.

CREATE TRIGGER record_luna_spend AFTER INSERT ON luna_usage BEGIN
 INSERT INTO luna_spend(lease,month,cost_nanos,settled) VALUES(NEW.lease,NEW.month,CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END,NEW.settled);
 UPDATE luna_usage SET charged_cost_nanos=CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END,reserved_cost_nanos=max(reserved_cost_nanos,CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END) WHERE lease=NEW.lease;
END;
CREATE TRIGGER settle_luna_spend AFTER UPDATE OF charged_cost_nanos,settled ON luna_usage BEGIN
 UPDATE luna_spend SET cost_nanos=(SELECT charged_cost_nanos FROM luna_usage WHERE lease=NEW.lease),settled=NEW.settled WHERE lease=NEW.lease;
END;
CREATE TRIGGER global_luna_budget BEFORE INSERT ON luna_usage BEGIN
 SELECT CASE WHEN json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.cloud_enabled')=0 THEN RAISE(ABORT,'global_cloud_disabled') END;
 SELECT CASE WHEN (SELECT coalesce(sum(cost_nanos),0) FROM luna_spend WHERE month=NEW.month)+(CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END)>round(json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.luna_monthly_usd')*1000000000) THEN RAISE(ABORT,'global_luna_budget_exhausted') END;
END;
CREATE TRIGGER global_audio_budget BEFORE INSERT ON audio_usage BEGIN
 SELECT CASE WHEN json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.cloud_enabled')=0 THEN RAISE(ABORT,'global_cloud_disabled') END;
 SELECT CASE WHEN (SELECT coalesce(sum(charged_units),0) FROM audio_usage WHERE day=NEW.day AND kind=NEW.kind)+NEW.charged_units>CASE NEW.kind WHEN 'asr' THEN json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.asr_daily_minutes')*60000 ELSE json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.tts_daily_characters') END THEN RAISE(ABORT,'global_audio_budget_exhausted') END;
END;
CREATE TRIGGER price_legacy_luna_settlement AFTER UPDATE OF prompt_tokens,completion_tokens,cached_tokens,cache_write_tokens ON luna_usage WHEN NEW.settled=1 BEGIN
 UPDATE luna_usage SET charged_cost_nanos=max(0,NEW.prompt_tokens-NEW.cached_tokens-NEW.cache_write_tokens)*100+NEW.cached_tokens*10+NEW.cache_write_tokens*125+NEW.completion_tokens*500 WHERE lease=NEW.lease;
END;
