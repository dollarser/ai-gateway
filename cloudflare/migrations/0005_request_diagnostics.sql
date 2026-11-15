ALTER TABLE requests ADD COLUMN model TEXT;
ALTER TABLE requests ADD COLUMN provider TEXT;
ALTER TABLE requests ADD COLUMN protocol TEXT;
ALTER TABLE requests ADD COLUMN failure_stage TEXT;
ALTER TABLE requests ADD COLUMN error_code TEXT;
ALTER TABLE requests ADD COLUMN upstream_status INTEGER;
ALTER TABLE requests ADD COLUMN duration_ms INTEGER;
CREATE TABLE quota_adjustments(
 id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('luna','audio')),lease TEXT NOT NULL,
 actor INTEGER NOT NULL,user_id INTEGER NOT NULL,previous_units INTEGER NOT NULL,new_units INTEGER NOT NULL,
 reason TEXT NOT NULL,created REAL NOT NULL
);
CREATE INDEX idx_quota_adjustment_lease ON quota_adjustments(kind,lease);
