ALTER TABLE operational_alerts ADD COLUMN notified_episode INTEGER NOT NULL DEFAULT 0;
-- Existing notifications already count, including those read by administrators.
UPDATE operational_alerts SET notified_episode=episode WHERE EXISTS(SELECT 1 FROM alert_deliveries d WHERE d.kind=operational_alerts.kind AND d.episode=operational_alerts.episode AND d.event_state='open');
UPDATE operational_alerts SET state='resolved' WHERE kind IN ('high_latency','slow_first_audio');
UPDATE alert_deliveries SET status='cancelled' WHERE kind IN ('high_latency','slow_first_audio') AND status IN ('pending','failed');
