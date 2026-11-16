-- Constant-time global quota checks. Detailed ledgers remain authoritative history.
CREATE TABLE luna_spend_totals(month TEXT PRIMARY KEY,cost_nanos INTEGER NOT NULL CHECK(cost_nanos>=0),reserved_cost_nanos INTEGER NOT NULL CHECK(reserved_cost_nanos>=0));
INSERT INTO luna_spend_totals SELECT month,sum(cost_nanos),sum(CASE WHEN settled=0 THEN cost_nanos ELSE 0 END) FROM luna_spend GROUP BY month;
CREATE TABLE audio_spend_totals(day TEXT NOT NULL,kind TEXT NOT NULL,units INTEGER NOT NULL CHECK(units>=0),reserved_units INTEGER NOT NULL CHECK(reserved_units>=0),PRIMARY KEY(day,kind));
INSERT INTO audio_spend_totals SELECT day,kind,sum(units),sum(CASE WHEN settled=0 THEN units ELSE 0 END) FROM audio_spend GROUP BY day,kind;
DROP TRIGGER global_luna_budget;
DROP TRIGGER global_audio_budget;
CREATE TRIGGER luna_spend_totals_insert AFTER INSERT ON luna_spend BEGIN
 INSERT INTO luna_spend_totals(month,cost_nanos,reserved_cost_nanos) VALUES(NEW.month,NEW.cost_nanos,CASE WHEN NEW.settled=0 THEN NEW.cost_nanos ELSE 0 END) ON CONFLICT(month) DO UPDATE SET cost_nanos=cost_nanos+excluded.cost_nanos,reserved_cost_nanos=reserved_cost_nanos+excluded.reserved_cost_nanos;
END;
CREATE TRIGGER luna_spend_totals_update AFTER UPDATE OF month,cost_nanos,settled ON luna_spend WHEN NEW.month=OLD.month AND (NEW.cost_nanos!=OLD.cost_nanos OR NEW.settled!=OLD.settled) BEGIN
 UPDATE luna_spend_totals SET cost_nanos=cost_nanos+NEW.cost_nanos-OLD.cost_nanos,reserved_cost_nanos=reserved_cost_nanos+(CASE WHEN NEW.settled=0 THEN NEW.cost_nanos ELSE 0 END)-(CASE WHEN OLD.settled=0 THEN OLD.cost_nanos ELSE 0 END) WHERE month=OLD.month;
END;
CREATE TRIGGER luna_spend_totals_move AFTER UPDATE OF month ON luna_spend WHEN NEW.month!=OLD.month BEGIN
 UPDATE luna_spend_totals SET cost_nanos=cost_nanos-OLD.cost_nanos,reserved_cost_nanos=reserved_cost_nanos-(CASE WHEN OLD.settled=0 THEN OLD.cost_nanos ELSE 0 END) WHERE month=OLD.month;
 INSERT INTO luna_spend_totals(month,cost_nanos,reserved_cost_nanos) VALUES(NEW.month,NEW.cost_nanos,CASE WHEN NEW.settled=0 THEN NEW.cost_nanos ELSE 0 END) ON CONFLICT(month) DO UPDATE SET cost_nanos=cost_nanos+excluded.cost_nanos,reserved_cost_nanos=reserved_cost_nanos+excluded.reserved_cost_nanos;
END;
CREATE TRIGGER luna_spend_totals_delete AFTER DELETE ON luna_spend BEGIN
 UPDATE luna_spend_totals SET cost_nanos=cost_nanos-OLD.cost_nanos,reserved_cost_nanos=reserved_cost_nanos-(CASE WHEN OLD.settled=0 THEN OLD.cost_nanos ELSE 0 END) WHERE month=OLD.month;
END;
CREATE TRIGGER audio_spend_totals_insert AFTER INSERT ON audio_spend BEGIN
 INSERT INTO audio_spend_totals(day,kind,units,reserved_units) VALUES(NEW.day,NEW.kind,NEW.units,CASE WHEN NEW.settled=0 THEN NEW.units ELSE 0 END) ON CONFLICT(day,kind) DO UPDATE SET units=units+excluded.units,reserved_units=reserved_units+excluded.reserved_units;
END;
CREATE TRIGGER audio_spend_totals_update AFTER UPDATE OF day,kind,units,settled ON audio_spend WHEN NEW.day=OLD.day AND NEW.kind=OLD.kind AND (NEW.units!=OLD.units OR NEW.settled!=OLD.settled) BEGIN
 UPDATE audio_spend_totals SET units=units+NEW.units-OLD.units,reserved_units=reserved_units+(CASE WHEN NEW.settled=0 THEN NEW.units ELSE 0 END)-(CASE WHEN OLD.settled=0 THEN OLD.units ELSE 0 END) WHERE day=OLD.day AND kind=OLD.kind;
END;
CREATE TRIGGER audio_spend_totals_move AFTER UPDATE OF day,kind ON audio_spend WHEN NEW.day!=OLD.day OR NEW.kind!=OLD.kind BEGIN
 UPDATE audio_spend_totals SET units=units-OLD.units,reserved_units=reserved_units-(CASE WHEN OLD.settled=0 THEN OLD.units ELSE 0 END) WHERE day=OLD.day AND kind=OLD.kind;
 INSERT INTO audio_spend_totals(day,kind,units,reserved_units) VALUES(NEW.day,NEW.kind,NEW.units,CASE WHEN NEW.settled=0 THEN NEW.units ELSE 0 END) ON CONFLICT(day,kind) DO UPDATE SET units=units+excluded.units,reserved_units=reserved_units+excluded.reserved_units;
END;
CREATE TRIGGER audio_spend_totals_delete AFTER DELETE ON audio_spend BEGIN
 UPDATE audio_spend_totals SET units=units-OLD.units,reserved_units=reserved_units-(CASE WHEN OLD.settled=0 THEN OLD.units ELSE 0 END) WHERE day=OLD.day AND kind=OLD.kind;
END;
CREATE TRIGGER global_luna_budget BEFORE INSERT ON luna_usage BEGIN
 SELECT CASE WHEN json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.cloud_enabled')=0 THEN RAISE(ABORT,'global_cloud_disabled') END;
 SELECT CASE WHEN coalesce((SELECT cost_nanos FROM luna_spend_totals WHERE month=NEW.month),0)+(CASE WHEN NEW.charged_cost_nanos=0 AND NEW.charged_tokens>0 THEN CASE WHEN NEW.prompt_tokens+NEW.completion_tokens>0 THEN NEW.prompt_tokens*125+NEW.completion_tokens*500 ELSE NEW.charged_tokens*500 END ELSE NEW.charged_cost_nanos END)>round(json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.luna_monthly_usd')*1000000000) THEN RAISE(ABORT,'global_luna_budget_exhausted') END;
END;
CREATE TRIGGER global_audio_budget BEFORE INSERT ON audio_usage BEGIN
 SELECT CASE WHEN json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.cloud_enabled')=0 THEN RAISE(ABORT,'global_cloud_disabled') END;
 SELECT CASE WHEN coalesce((SELECT units FROM audio_spend_totals WHERE day=NEW.day AND kind=NEW.kind),0)+NEW.charged_units>CASE NEW.kind WHEN 'asr' THEN json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.asr_daily_minutes')*60000 ELSE json_extract((SELECT value FROM settings WHERE name='global_limits'),'$.tts_daily_characters') END THEN RAISE(ABORT,'global_audio_budget_exhausted') END;
END;
