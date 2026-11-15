-- Preserve aggregate global audio units independently of account cleanup.
CREATE TABLE audio_spend(lease TEXT PRIMARY KEY,day TEXT NOT NULL,kind TEXT NOT NULL,units INTEGER NOT NULL CHECK(units>=0),settled INTEGER NOT NULL);
CREATE INDEX idx_audio_spend_day ON audio_spend(day,kind,units);
INSERT INTO audio_spend SELECT lease,day,kind,charged_units,settled FROM audio_usage;
DROP TRIGGER global_audio_budget;
CREATE TRIGGER global_audio_budget BEFORE INSERT ON audio_usage BEGIN
 SELECT CASE WHEN json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.cloud_enabled')=0 THEN RAISE(ABORT,'global_cloud_disabled') END;
 SELECT CASE WHEN (SELECT coalesce(sum(units),0) FROM audio_spend WHERE day=NEW.day AND kind=NEW.kind)+NEW.charged_units>CASE NEW.kind WHEN 'asr' THEN json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.asr_daily_minutes')*60000 ELSE json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.tts_daily_characters') END THEN RAISE(ABORT,'global_audio_budget_exhausted') END;
END;
CREATE TRIGGER record_audio_spend AFTER INSERT ON audio_usage BEGIN
 INSERT INTO audio_spend(lease,day,kind,units,settled) VALUES(NEW.lease,NEW.day,NEW.kind,NEW.charged_units,NEW.settled);
END;
CREATE TRIGGER settle_audio_spend AFTER UPDATE OF charged_units,settled ON audio_usage BEGIN
 UPDATE audio_spend SET units=NEW.charged_units,settled=NEW.settled WHERE lease=NEW.lease;
END;
