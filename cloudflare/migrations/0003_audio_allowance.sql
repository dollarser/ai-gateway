ALTER TABLE users ADD COLUMN openai_asr_daily_seconds INTEGER NOT NULL DEFAULT 1800 CHECK(openai_asr_daily_seconds>=0);
ALTER TABLE users ADD COLUMN openai_tts_daily_characters INTEGER NOT NULL DEFAULT 500000 CHECK(openai_tts_daily_characters>=0);
INSERT INTO settings(name,value) VALUES('audio_defaults','{"openai_asr_daily_seconds":1800,"openai_tts_daily_characters":500000}');
CREATE TABLE audio_usage(
 lease TEXT PRIMARY KEY REFERENCES requests(id),user_id INTEGER NOT NULL REFERENCES users(id),
 day TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('asr','tts')),
 reserved_units INTEGER NOT NULL CHECK(reserved_units>0),charged_units INTEGER NOT NULL CHECK(charged_units>=0),
 settled INTEGER NOT NULL DEFAULT 0,response_id TEXT
);
CREATE INDEX idx_audio_user_day_kind ON audio_usage(user_id,day,kind);
CREATE TRIGGER audio_reservation BEFORE INSERT ON audio_usage BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM requests r JOIN users u ON u.id=r.user_id
  WHERE r.id=NEW.lease AND r.user_id=NEW.user_id AND r.service=NEW.kind AND r.ended IS NULL AND r.started>unixepoch()-900
   AND r.path=CASE NEW.kind WHEN 'asr' THEN '/v1/audio/transcriptions' ELSE '/v1/audio/speech' END
   AND u.enabled=1 AND u.must_change=0 AND EXISTS(SELECT 1 FROM json_each(u.services) WHERE value=NEW.kind)
   AND (r.key_id IS NULL OR EXISTS(SELECT 1 FROM keys k WHERE k.id=r.key_id AND k.user_id=u.id AND k.revoked=0 AND k.expires>unixepoch() AND EXISTS(SELECT 1 FROM json_each(k.services) WHERE value=NEW.kind)))
 ) THEN RAISE(ABORT,'account_permission') END;
 SELECT CASE WHEN (SELECT coalesce(sum(charged_units),0) FROM audio_usage WHERE user_id=NEW.user_id AND day=NEW.day AND kind=NEW.kind)+NEW.charged_units>
  (SELECT CASE NEW.kind WHEN 'asr' THEN openai_asr_daily_seconds*1000 ELSE openai_tts_daily_characters END FROM users WHERE id=NEW.user_id)
 THEN RAISE(ABORT,'audio_budget_exhausted') END;
END;
