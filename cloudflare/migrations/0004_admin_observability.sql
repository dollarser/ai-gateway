ALTER TABLE users ADD COLUMN last_login_ip TEXT;
ALTER TABLE users ADD COLUMN last_login_at REAL;
ALTER TABLE requests ADD COLUMN client_ip TEXT;
ALTER TABLE requests ADD COLUMN user_agent TEXT;
ALTER TABLE requests ADD COLUMN client_version TEXT;
ALTER TABLE requests ADD COLUMN device_id TEXT;
CREATE INDEX idx_requests_day_started ON requests(day,started);
CREATE INDEX idx_audio_day_kind_user ON audio_usage(day,kind,user_id);
CREATE INDEX idx_luna_month_user ON luna_usage(month,user_id);
