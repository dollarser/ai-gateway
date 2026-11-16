ALTER TABLE alert_deliveries ADD COLUMN channel TEXT NOT NULL DEFAULT 'webhook';
CREATE TABLE notification_inbox(id TEXT PRIMARY KEY REFERENCES alert_deliveries(id) ON DELETE CASCADE,kind TEXT NOT NULL,event_state TEXT NOT NULL,created REAL NOT NULL,payload TEXT NOT NULL);
CREATE INDEX idx_notification_inbox_created ON notification_inbox(created);
CREATE TABLE notification_reads(notification_id TEXT NOT NULL REFERENCES notification_inbox(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,read_at REAL NOT NULL,PRIMARY KEY(notification_id,user_id));
CREATE INDEX idx_notification_reads_user ON notification_reads(user_id,notification_id);
