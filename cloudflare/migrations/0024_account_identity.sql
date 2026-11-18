-- Email is the only login identifier; display names may repeat.

-- Existing user IDs and every dependent row are preserved.

-- D1 cannot disable FK enforcement. Detach leaf tables before rebuilding

-- the parent: deferring FK checks alone would still run ON DELETE CASCADE.

-- Migration runs atomically; triggers are restored after data to avoid

-- replaying usage/accounting side effects. Do not split this migration.

CREATE TABLE "__identity_backup_users" AS SELECT * FROM "users";

CREATE TABLE "__identity_backup_account_email_codes" AS SELECT * FROM "account_email_codes";

CREATE TABLE "__identity_backup_auth_families" AS SELECT * FROM "auth_families";

CREATE TABLE "__identity_backup_customer_notice_reads" AS SELECT * FROM "customer_notice_reads";

CREATE TABLE "__identity_backup_keys" AS SELECT * FROM "keys";

CREATE TABLE "__identity_backup_luna_user_month_totals" AS SELECT * FROM "luna_user_month_totals";

CREATE TABLE "__identity_backup_notification_reads" AS SELECT * FROM "notification_reads";

CREATE TABLE "__identity_backup_password_reset_codes" AS SELECT * FROM "password_reset_codes";

CREATE TABLE "__identity_backup_sessions" AS SELECT * FROM "sessions";

CREATE TABLE "__identity_backup_access_tokens" AS SELECT * FROM "access_tokens";

CREATE TABLE "__identity_backup_refresh_tokens" AS SELECT * FROM "refresh_tokens";

CREATE TABLE "__identity_backup_requests" AS SELECT * FROM "requests";

CREATE TABLE "__identity_backup_audio_usage" AS SELECT * FROM "audio_usage";

CREATE TABLE "__identity_backup_luna_usage" AS SELECT * FROM "luna_usage";

DROP TRIGGER "audio_reservation";

DROP TRIGGER "audio_spend_totals_delete";

DROP TRIGGER "audio_spend_totals_insert";

DROP TRIGGER "audio_spend_totals_move";

DROP TRIGGER "audio_spend_totals_update";

DROP TRIGGER "global_audio_budget";

DROP TRIGGER "global_luna_budget";

DROP TRIGGER "luna_reservation";

DROP TRIGGER "luna_spend_totals_delete";

DROP TRIGGER "luna_spend_totals_insert";

DROP TRIGGER "luna_spend_totals_move";

DROP TRIGGER "luna_spend_totals_update";

DROP TRIGGER "personal_luna_delete";

DROP TRIGGER "personal_luna_insert";

DROP TRIGGER "personal_luna_move";

DROP TRIGGER "personal_luna_update";

DROP TRIGGER "price_legacy_luna_settlement";

DROP TRIGGER "protect_last_admin";

DROP TRIGGER "record_audio_spend";

DROP TRIGGER "record_luna_spend";

DROP TRIGGER "request_quota";

DROP TRIGGER "settle_audio_spend";

DROP TRIGGER "settle_luna_spend";

DROP TABLE "luna_usage";

DROP TABLE "audio_usage";

DROP TABLE "requests";

DROP TABLE "refresh_tokens";

DROP TABLE "access_tokens";

DROP TABLE "sessions";

DROP TABLE "password_reset_codes";

DROP TABLE "notification_reads";

DROP TABLE "luna_user_month_totals";

DROP TABLE "keys";

DROP TABLE "customer_notice_reads";

DROP TABLE "auth_families";

DROP TABLE "account_email_codes";

DROP TABLE "users";

CREATE TABLE users(
          id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 80), password TEXT NOT NULL,
          role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          services TEXT NOT NULL, rpm INTEGER NOT NULL, daily_requests INTEGER NOT NULL,
          concurrency INTEGER NOT NULL, must_change INTEGER NOT NULL DEFAULT 0,
          created REAL NOT NULL, email TEXT COLLATE NOCASE CHECK(email IS NULL OR (length(email) BETWEEN 3 AND 254 AND instr(email,'@')>1)), luna_monthly_tokens INTEGER NOT NULL DEFAULT 10000000 CHECK(luna_monthly_tokens>=0), openai_asr_daily_seconds INTEGER NOT NULL DEFAULT 1800 CHECK(openai_asr_daily_seconds>=0), openai_tts_daily_characters INTEGER NOT NULL DEFAULT 500000 CHECK(openai_tts_daily_characters>=0), last_login_ip TEXT, last_login_at REAL, email_verified_at REAL, display_name_updated_at REAL NOT NULL DEFAULT 0 CHECK(display_name_updated_at>=0));

CREATE TABLE account_email_codes(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,email_hash TEXT NOT NULL,id TEXT NOT NULL,code_hash TEXT NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending');

CREATE TABLE auth_families(
          id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
          expires REAL NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);

CREATE TABLE customer_notice_reads(notice_id TEXT NOT NULL REFERENCES customer_notices(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,read_at REAL NOT NULL,PRIMARY KEY(notice_id,user_id));

CREATE TABLE keys(
          id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
          name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
          services TEXT NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
          created REAL NOT NULL, legacy_daily_tokens INTEGER NOT NULL DEFAULT 0);

CREATE TABLE luna_user_month_totals(
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,month TEXT NOT NULL,
 used_tokens INTEGER NOT NULL CHECK(used_tokens>=0),reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>=0),
 requests INTEGER NOT NULL CHECK(requests>=0),prompt_tokens INTEGER NOT NULL CHECK(prompt_tokens>=0),completion_tokens INTEGER NOT NULL CHECK(completion_tokens>=0),
 PRIMARY KEY(user_id,month)
);

CREATE TABLE notification_reads(notification_id TEXT NOT NULL REFERENCES notification_inbox(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,read_at REAL NOT NULL,PRIMARY KEY(notification_id,user_id));

CREATE TABLE password_reset_codes(
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,id TEXT NOT NULL,code_hash TEXT NOT NULL,
  password_version TEXT NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE sessions(
          hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
          csrf TEXT NOT NULL, expires REAL NOT NULL, family_id TEXT);

CREATE TABLE access_tokens(
          hash TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES auth_families(id),expires REAL NOT NULL);

CREATE TABLE refresh_tokens(
          hash TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES auth_families(id),
          expires REAL NOT NULL,used INTEGER NOT NULL DEFAULT 0);

CREATE TABLE requests(
                  id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
                  key_id INTEGER REFERENCES keys(id),service TEXT NOT NULL,
                  auth_type TEXT NOT NULL DEFAULT 'api_key',path TEXT NOT NULL,
                  started REAL NOT NULL,day TEXT NOT NULL,ended REAL,status INTEGER,
                  response_bytes INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, request_id TEXT, client_request_id TEXT, helix_turn_id TEXT, helix_model_call_id TEXT, upstream_response_id TEXT, client_ip TEXT, user_agent TEXT, client_version TEXT, device_id TEXT, model TEXT, provider TEXT, protocol TEXT, failure_stage TEXT, error_code TEXT, upstream_status INTEGER, duration_ms INTEGER, upstream_error_code TEXT, upstream_error_param TEXT, upstream_request_id TEXT, compatibility TEXT, ingress_colo TEXT, client_country TEXT, ingress_ray TEXT, upstream_cf_ray TEXT, egress_probe_ip TEXT, egress_probe_at INTEGER, egress_probe_target TEXT, egress_probe_status TEXT, first_byte_ms INTEGER, upstream_attempted INTEGER NOT NULL DEFAULT 0, release_sha TEXT, egress_probe_stage TEXT, egress_probe_error TEXT, egress_probe_http_status INTEGER, egress_probe_duration_ms INTEGER);

CREATE TABLE audio_usage(
 lease TEXT PRIMARY KEY REFERENCES requests(id),user_id INTEGER NOT NULL REFERENCES users(id),
 day TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('asr','tts')),
 reserved_units INTEGER NOT NULL CHECK(reserved_units>0),charged_units INTEGER NOT NULL CHECK(charged_units>=0),
 settled INTEGER NOT NULL DEFAULT 0,response_id TEXT
);

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
, reserved_cost_nanos INTEGER NOT NULL DEFAULT 0 CHECK(reserved_cost_nanos>=0), charged_cost_nanos INTEGER NOT NULL DEFAULT 0 CHECK(charged_cost_nanos>=0), model TEXT NOT NULL DEFAULT 'gpt-6-luna');

INSERT INTO "users"("id","display_name","password","role","enabled","services","rpm","daily_requests","concurrency","must_change","created","email","luna_monthly_tokens","openai_asr_daily_seconds","openai_tts_daily_characters","last_login_ip","last_login_at","email_verified_at") SELECT "id",substr(trim("username"),1,80),"password","role","enabled","services","rpm","daily_requests","concurrency","must_change","created",CASE WHEN "email" IS NULL THEN NULL ELSE lower(trim("email")) END,"luna_monthly_tokens","openai_asr_daily_seconds","openai_tts_daily_characters","last_login_ip","last_login_at","email_verified_at" FROM "__identity_backup_users";

INSERT INTO "account_email_codes"("user_id","email_hash","id","code_hash","created","expires","attempts","state") SELECT "user_id","email_hash","id","code_hash","created","expires","attempts","state" FROM "__identity_backup_account_email_codes";

INSERT INTO "auth_families"("id","user_id","expires","revoked") SELECT "id","user_id","expires","revoked" FROM "__identity_backup_auth_families";

INSERT INTO "customer_notice_reads"("notice_id","user_id","read_at") SELECT "notice_id","user_id","read_at" FROM "__identity_backup_customer_notice_reads";

INSERT INTO "keys"("id","user_id","name","hash","prefix","services","expires","revoked","created","legacy_daily_tokens") SELECT "id","user_id","name","hash","prefix","services","expires","revoked","created","legacy_daily_tokens" FROM "__identity_backup_keys";

INSERT INTO "luna_user_month_totals"("user_id","month","used_tokens","reserved_tokens","requests","prompt_tokens","completion_tokens") SELECT "user_id","month","used_tokens","reserved_tokens","requests","prompt_tokens","completion_tokens" FROM "__identity_backup_luna_user_month_totals";

INSERT INTO "notification_reads"("notification_id","user_id","read_at") SELECT "notification_id","user_id","read_at" FROM "__identity_backup_notification_reads";

INSERT INTO "password_reset_codes"("user_id","email_hash","id","code_hash","password_version","created","expires","attempts","state") SELECT "user_id","email_hash","id","code_hash","password_version","created","expires","attempts","state" FROM "__identity_backup_password_reset_codes";

INSERT INTO "sessions"("hash","user_id","csrf","expires","family_id") SELECT "hash","user_id","csrf","expires","family_id" FROM "__identity_backup_sessions";

INSERT INTO "access_tokens"("hash","family_id","expires") SELECT "hash","family_id","expires" FROM "__identity_backup_access_tokens";

INSERT INTO "refresh_tokens"("hash","family_id","expires","used") SELECT "hash","family_id","expires","used" FROM "__identity_backup_refresh_tokens";

INSERT INTO "requests"("id","user_id","key_id","service","auth_type","path","started","day","ended","status","response_bytes","prompt_tokens","completion_tokens","request_id","client_request_id","helix_turn_id","helix_model_call_id","upstream_response_id","client_ip","user_agent","client_version","device_id","model","provider","protocol","failure_stage","error_code","upstream_status","duration_ms","upstream_error_code","upstream_error_param","upstream_request_id","compatibility","ingress_colo","client_country","ingress_ray","upstream_cf_ray","egress_probe_ip","egress_probe_at","egress_probe_target","egress_probe_status","first_byte_ms","upstream_attempted","release_sha","egress_probe_stage","egress_probe_error","egress_probe_http_status","egress_probe_duration_ms") SELECT "id","user_id","key_id","service","auth_type","path","started","day","ended","status","response_bytes","prompt_tokens","completion_tokens","request_id","client_request_id","helix_turn_id","helix_model_call_id","upstream_response_id","client_ip","user_agent","client_version","device_id","model","provider","protocol","failure_stage","error_code","upstream_status","duration_ms","upstream_error_code","upstream_error_param","upstream_request_id","compatibility","ingress_colo","client_country","ingress_ray","upstream_cf_ray","egress_probe_ip","egress_probe_at","egress_probe_target","egress_probe_status","first_byte_ms","upstream_attempted","release_sha","egress_probe_stage","egress_probe_error","egress_probe_http_status","egress_probe_duration_ms" FROM "__identity_backup_requests";

INSERT INTO "audio_usage"("lease","user_id","day","kind","reserved_units","charged_units","settled","response_id") SELECT "lease","user_id","day","kind","reserved_units","charged_units","settled","response_id" FROM "__identity_backup_audio_usage";

INSERT INTO "luna_usage"("lease","user_id","month","reserved_tokens","charged_tokens","settled","prompt_tokens","completion_tokens","cached_tokens","cache_write_tokens","response_id","reserved_cost_nanos","charged_cost_nanos","model") SELECT "lease","user_id","month","reserved_tokens","charged_tokens","settled","prompt_tokens","completion_tokens","cached_tokens","cache_write_tokens","response_id","reserved_cost_nanos","charged_cost_nanos","model" FROM "__identity_backup_luna_usage";

CREATE INDEX idx_access_expiry ON access_tokens(expires);

CREATE INDEX idx_access_family ON access_tokens(family_id);

CREATE INDEX idx_account_email_codes_expiry ON account_email_codes(expires);

CREATE INDEX idx_audio_day_kind_user ON audio_usage(day,kind,user_id);

CREATE INDEX idx_audio_user_day_kind ON audio_usage(user_id,day,kind);

CREATE INDEX idx_auth_families_expiry ON auth_families(expires);

CREATE INDEX idx_customer_notice_reads_user ON customer_notice_reads(user_id,notice_id);

CREATE INDEX idx_luna_month_user ON luna_usage(month,user_id);

CREATE INDEX idx_luna_user_month ON luna_usage(user_id,month);

CREATE INDEX idx_notification_reads_user ON notification_reads(user_id,notification_id);

CREATE INDEX idx_password_reset_codes_email ON password_reset_codes(email_hash);

CREATE INDEX idx_password_reset_codes_expiry ON password_reset_codes(expires);

CREATE INDEX idx_refresh_expiry ON refresh_tokens(expires);

CREATE INDEX idx_refresh_family ON refresh_tokens(family_id);

CREATE INDEX idx_requests_catalog_day ON requests(day) WHERE path='/v1/models' AND ended IS NOT NULL;

CREATE INDEX idx_requests_day_started ON requests(day,started);

CREATE INDEX idx_requests_ended_time ON requests(ended,started);

CREATE INDEX idx_requests_privacy_started ON requests(started) WHERE client_ip IS NOT NULL OR user_agent IS NOT NULL OR device_id IS NOT NULL;

CREATE INDEX idx_requests_provider_time ON requests(provider,started) WHERE provider IS NOT NULL;

CREATE INDEX idx_requests_request_id ON requests(request_id) WHERE request_id IS NOT NULL;

CREATE INDEX idx_requests_user_day ON requests(user_id,day);

CREATE INDEX idx_requests_user_time ON requests(user_id,started);

CREATE INDEX idx_sessions_expiry ON sessions(expires);

CREATE INDEX idx_sessions_family ON sessions(family_id);

CREATE UNIQUE INDEX idx_users_email ON users(email COLLATE NOCASE);

DROP TABLE "__identity_backup_luna_usage";

DROP TABLE "__identity_backup_audio_usage";

DROP TABLE "__identity_backup_requests";

DROP TABLE "__identity_backup_refresh_tokens";

DROP TABLE "__identity_backup_access_tokens";

DROP TABLE "__identity_backup_sessions";

DROP TABLE "__identity_backup_password_reset_codes";

DROP TABLE "__identity_backup_notification_reads";

DROP TABLE "__identity_backup_luna_user_month_totals";

DROP TABLE "__identity_backup_keys";

DROP TABLE "__identity_backup_customer_notice_reads";

DROP TABLE "__identity_backup_auth_families";

DROP TABLE "__identity_backup_account_email_codes";

DROP TABLE "__identity_backup_users";

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

CREATE TRIGGER audio_spend_totals_delete AFTER DELETE ON audio_spend BEGIN
 UPDATE audio_spend_totals SET units=units-OLD.units,reserved_units=reserved_units-(CASE WHEN OLD.settled=0 THEN OLD.units ELSE 0 END) WHERE day=OLD.day AND kind=OLD.kind;
END;

CREATE TRIGGER audio_spend_totals_insert AFTER INSERT ON audio_spend BEGIN
 INSERT INTO audio_spend_totals(day,kind,units,reserved_units) VALUES(NEW.day,NEW.kind,NEW.units,CASE WHEN NEW.settled=0 THEN NEW.units ELSE 0 END) ON CONFLICT(day,kind) DO UPDATE SET units=units+excluded.units,reserved_units=reserved_units+excluded.reserved_units;
END;

CREATE TRIGGER audio_spend_totals_move AFTER UPDATE OF day,kind ON audio_spend WHEN NEW.day!=OLD.day OR NEW.kind!=OLD.kind BEGIN
 UPDATE audio_spend_totals SET units=units-OLD.units,reserved_units=reserved_units-(CASE WHEN OLD.settled=0 THEN OLD.units ELSE 0 END) WHERE day=OLD.day AND kind=OLD.kind;
 INSERT INTO audio_spend_totals(day,kind,units,reserved_units) VALUES(NEW.day,NEW.kind,NEW.units,CASE WHEN NEW.settled=0 THEN NEW.units ELSE 0 END) ON CONFLICT(day,kind) DO UPDATE SET units=units+excluded.units,reserved_units=reserved_units+excluded.reserved_units;
END;

CREATE TRIGGER audio_spend_totals_update AFTER UPDATE OF day,kind,units,settled ON audio_spend WHEN NEW.day=OLD.day AND NEW.kind=OLD.kind AND (NEW.units!=OLD.units OR NEW.settled!=OLD.settled) BEGIN
 UPDATE audio_spend_totals SET units=units+NEW.units-OLD.units,reserved_units=reserved_units+(CASE WHEN NEW.settled=0 THEN NEW.units ELSE 0 END)-(CASE WHEN OLD.settled=0 THEN OLD.units ELSE 0 END) WHERE day=OLD.day AND kind=OLD.kind;
END;

CREATE TRIGGER global_audio_budget BEFORE INSERT ON audio_usage BEGIN
 SELECT CASE WHEN json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.cloud_enabled')=0 THEN RAISE(ABORT,'global_cloud_disabled') END;
 SELECT CASE WHEN coalesce((SELECT units FROM audio_spend_totals WHERE day=NEW.day AND kind=NEW.kind),0)+NEW.charged_units>CASE NEW.kind WHEN 'asr' THEN json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.asr_daily_minutes')*60000 ELSE json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.tts_daily_characters') END THEN RAISE(ABORT,'global_audio_budget_exhausted') END;
END;

CREATE TRIGGER global_luna_budget BEFORE INSERT ON luna_usage BEGIN
 SELECT CASE WHEN json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.cloud_enabled')=0 THEN RAISE(ABORT,'global_cloud_disabled') END;
 SELECT CASE WHEN coalesce((SELECT cost_nanos FROM luna_spend_totals WHERE month=NEW.month),0)+(CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END)>round(json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.luna_monthly_usd')*1000000000) THEN RAISE(ABORT,'global_luna_budget_exhausted') END;
END;

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

CREATE TRIGGER luna_spend_totals_delete AFTER DELETE ON luna_spend BEGIN
 UPDATE luna_spend_totals SET cost_nanos=cost_nanos-OLD.cost_nanos,reserved_cost_nanos=reserved_cost_nanos-(CASE WHEN OLD.settled=0 THEN OLD.cost_nanos ELSE 0 END) WHERE month=OLD.month;
END;

CREATE TRIGGER luna_spend_totals_insert AFTER INSERT ON luna_spend BEGIN
 INSERT INTO luna_spend_totals(month,cost_nanos,reserved_cost_nanos) VALUES(NEW.month,NEW.cost_nanos,CASE WHEN NEW.settled=0 THEN NEW.cost_nanos ELSE 0 END) ON CONFLICT(month) DO UPDATE SET cost_nanos=cost_nanos+excluded.cost_nanos,reserved_cost_nanos=reserved_cost_nanos+excluded.reserved_cost_nanos;
END;

CREATE TRIGGER luna_spend_totals_move AFTER UPDATE OF month ON luna_spend WHEN NEW.month!=OLD.month BEGIN
 UPDATE luna_spend_totals SET cost_nanos=cost_nanos-OLD.cost_nanos,reserved_cost_nanos=reserved_cost_nanos-(CASE WHEN OLD.settled=0 THEN OLD.cost_nanos ELSE 0 END) WHERE month=OLD.month;
 INSERT INTO luna_spend_totals(month,cost_nanos,reserved_cost_nanos) VALUES(NEW.month,NEW.cost_nanos,CASE WHEN NEW.settled=0 THEN NEW.cost_nanos ELSE 0 END) ON CONFLICT(month) DO UPDATE SET cost_nanos=cost_nanos+excluded.cost_nanos,reserved_cost_nanos=reserved_cost_nanos+excluded.reserved_cost_nanos;
END;

CREATE TRIGGER luna_spend_totals_update AFTER UPDATE OF month,cost_nanos,settled ON luna_spend WHEN NEW.month=OLD.month AND (NEW.cost_nanos!=OLD.cost_nanos OR NEW.settled!=OLD.settled) BEGIN
 UPDATE luna_spend_totals SET cost_nanos=cost_nanos+NEW.cost_nanos-OLD.cost_nanos,reserved_cost_nanos=reserved_cost_nanos+(CASE WHEN NEW.settled=0 THEN NEW.cost_nanos ELSE 0 END)-(CASE WHEN OLD.settled=0 THEN OLD.cost_nanos ELSE 0 END) WHERE month=OLD.month;
END;

CREATE TRIGGER personal_luna_delete AFTER DELETE ON luna_usage BEGIN
 UPDATE luna_user_month_totals SET used_tokens=used_tokens-OLD.charged_tokens,reserved_tokens=reserved_tokens-(CASE WHEN OLD.settled=0 THEN OLD.charged_tokens ELSE 0 END),requests=requests-1,prompt_tokens=prompt_tokens-OLD.prompt_tokens,completion_tokens=completion_tokens-OLD.completion_tokens WHERE user_id=OLD.user_id AND month=OLD.month;
END;

CREATE TRIGGER personal_luna_insert AFTER INSERT ON luna_usage BEGIN
 INSERT INTO luna_user_month_totals VALUES(NEW.user_id,NEW.month,NEW.charged_tokens,CASE WHEN NEW.settled=0 THEN NEW.charged_tokens ELSE 0 END,1,NEW.prompt_tokens,NEW.completion_tokens)
 ON CONFLICT(user_id,month) DO UPDATE SET used_tokens=used_tokens+excluded.used_tokens,reserved_tokens=reserved_tokens+excluded.reserved_tokens,requests=requests+1,prompt_tokens=prompt_tokens+excluded.prompt_tokens,completion_tokens=completion_tokens+excluded.completion_tokens;
END;

CREATE TRIGGER personal_luna_move AFTER UPDATE OF user_id,month ON luna_usage WHEN NEW.user_id<>OLD.user_id OR NEW.month<>OLD.month BEGIN
 UPDATE luna_user_month_totals SET used_tokens=used_tokens-OLD.charged_tokens,reserved_tokens=reserved_tokens-(CASE WHEN OLD.settled=0 THEN OLD.charged_tokens ELSE 0 END),requests=requests-1,prompt_tokens=prompt_tokens-OLD.prompt_tokens,completion_tokens=completion_tokens-OLD.completion_tokens WHERE user_id=OLD.user_id AND month=OLD.month;
 INSERT INTO luna_user_month_totals VALUES(NEW.user_id,NEW.month,NEW.charged_tokens,CASE WHEN NEW.settled=0 THEN NEW.charged_tokens ELSE 0 END,1,NEW.prompt_tokens,NEW.completion_tokens)
 ON CONFLICT(user_id,month) DO UPDATE SET used_tokens=used_tokens+excluded.used_tokens,reserved_tokens=reserved_tokens+excluded.reserved_tokens,requests=requests+1,prompt_tokens=prompt_tokens+excluded.prompt_tokens,completion_tokens=completion_tokens+excluded.completion_tokens;
END;

CREATE TRIGGER personal_luna_update AFTER UPDATE OF user_id,month,charged_tokens,settled,prompt_tokens,completion_tokens ON luna_usage
 WHEN NEW.user_id=OLD.user_id AND NEW.month=OLD.month AND (NEW.charged_tokens<>OLD.charged_tokens OR NEW.settled<>OLD.settled OR NEW.prompt_tokens<>OLD.prompt_tokens OR NEW.completion_tokens<>OLD.completion_tokens) BEGIN
 UPDATE luna_user_month_totals SET used_tokens=used_tokens+NEW.charged_tokens-OLD.charged_tokens,reserved_tokens=reserved_tokens+(CASE WHEN NEW.settled=0 THEN NEW.charged_tokens ELSE 0 END)-(CASE WHEN OLD.settled=0 THEN OLD.charged_tokens ELSE 0 END),prompt_tokens=prompt_tokens+NEW.prompt_tokens-OLD.prompt_tokens,completion_tokens=completion_tokens+NEW.completion_tokens-OLD.completion_tokens WHERE user_id=NEW.user_id AND month=NEW.month;
END;

CREATE TRIGGER price_legacy_luna_settlement AFTER UPDATE OF prompt_tokens,completion_tokens,cached_tokens,cache_write_tokens ON luna_usage WHEN NEW.model='gpt-6-luna' AND NEW.settled=1 AND NEW.charged_cost_nanos<>(max(0,NEW.prompt_tokens-NEW.cached_tokens-NEW.cache_write_tokens)*100+NEW.cached_tokens*10+NEW.cache_write_tokens*125+NEW.completion_tokens*500) BEGIN
 UPDATE luna_usage SET charged_cost_nanos=max(0,NEW.prompt_tokens-NEW.cached_tokens-NEW.cache_write_tokens)*100+NEW.cached_tokens*10+NEW.cache_write_tokens*125+NEW.completion_tokens*500 WHERE lease=NEW.lease;
END;

CREATE TRIGGER protect_last_admin BEFORE UPDATE OF enabled ON users WHEN OLD.role='admin' AND OLD.enabled=1 AND NEW.enabled=0 AND (SELECT count(*) FROM users WHERE role='admin' AND enabled=1)<=1 BEGIN SELECT RAISE(ABORT,'last_admin'); END;

CREATE TRIGGER record_audio_spend AFTER INSERT ON audio_usage BEGIN
 INSERT INTO audio_spend(lease,day,kind,units,settled) VALUES(NEW.lease,NEW.day,NEW.kind,NEW.charged_units,NEW.settled);
END;

CREATE TRIGGER record_luna_spend AFTER INSERT ON luna_usage BEGIN
 INSERT INTO luna_spend(lease,month,cost_nanos,settled) VALUES(NEW.lease,NEW.month,CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END,NEW.settled);
 UPDATE luna_usage SET charged_cost_nanos=CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END,reserved_cost_nanos=max(reserved_cost_nanos,CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END) WHERE lease=NEW.lease AND (charged_cost_nanos<>(CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END) OR reserved_cost_nanos<(CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END));
END;

CREATE TRIGGER request_quota BEFORE INSERT ON requests BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND enabled=1 AND must_change=0 AND EXISTS(SELECT 1 FROM json_each(users.services) WHERE value=NEW.service)) THEN RAISE(ABORT,'account_permission') END;
 SELECT CASE WHEN NEW.key_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM keys WHERE id=NEW.key_id AND user_id=NEW.user_id AND revoked=0 AND expires>NEW.started AND EXISTS(SELECT 1 FROM json_each(keys.services) WHERE value=NEW.service)) THEN RAISE(ABORT,'key_permission') END;
 SELECT CASE WHEN (SELECT rpm FROM users WHERE id=NEW.user_id)>0 AND (SELECT count(*) FROM requests WHERE user_id=NEW.user_id AND started>NEW.started-60)>=(SELECT rpm FROM users WHERE id=NEW.user_id) THEN RAISE(ABORT,'quota_rpm') END;
 SELECT CASE WHEN (SELECT daily_requests FROM users WHERE id=NEW.user_id)>0 AND (SELECT count(*) FROM requests WHERE user_id=NEW.user_id AND day=NEW.day)>=(SELECT daily_requests FROM users WHERE id=NEW.user_id) THEN RAISE(ABORT,'quota_daily') END;
 SELECT CASE WHEN (SELECT count(*) FROM requests WHERE user_id=NEW.user_id AND ended IS NULL AND started>NEW.started-920)>=(SELECT concurrency FROM users WHERE id=NEW.user_id) THEN RAISE(ABORT,'quota_concurrency') END;
 SELECT CASE WHEN NEW.key_id IS NOT NULL AND (SELECT legacy_daily_tokens FROM keys WHERE id=NEW.key_id)>0 AND (SELECT coalesce(sum(prompt_tokens+completion_tokens),0) FROM requests WHERE key_id=NEW.key_id AND day=NEW.day)+coalesce((SELECT prompt_tokens+completion_tokens FROM legacy_token_baseline WHERE key_id=NEW.key_id AND day=NEW.day),0)>=(SELECT legacy_daily_tokens FROM keys WHERE id=NEW.key_id) THEN RAISE(ABORT,'quota_tokens') END;
END;

CREATE TRIGGER settle_audio_spend AFTER UPDATE OF charged_units,settled ON audio_usage WHEN NEW.charged_units<>OLD.charged_units OR NEW.settled<>OLD.settled BEGIN
 UPDATE audio_spend SET units=NEW.charged_units,settled=NEW.settled WHERE lease=NEW.lease AND (units<>NEW.charged_units OR settled<>NEW.settled);
END;

CREATE TRIGGER settle_luna_spend AFTER UPDATE OF charged_cost_nanos,settled ON luna_usage WHEN OLD.charged_cost_nanos<>NEW.charged_cost_nanos OR OLD.settled<>NEW.settled BEGIN
 UPDATE luna_spend SET cost_nanos=(SELECT charged_cost_nanos FROM luna_usage WHERE lease=NEW.lease),settled=NEW.settled WHERE lease=NEW.lease AND (cost_nanos<>(SELECT charged_cost_nanos FROM luna_usage WHERE lease=NEW.lease) OR settled<>NEW.settled);
END;

CREATE TRIGGER user_id_immutable BEFORE UPDATE OF id ON users WHEN NEW.id<>OLD.id BEGIN
 SELECT RAISE(ABORT,'immutable_account_id');
END;
