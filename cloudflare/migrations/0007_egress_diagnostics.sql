-- Probe IP belongs to a separate connection to the named target, NOT OpenAI.
ALTER TABLE requests ADD COLUMN ingress_colo TEXT;
ALTER TABLE requests ADD COLUMN client_country TEXT;
ALTER TABLE requests ADD COLUMN ingress_ray TEXT;
ALTER TABLE requests ADD COLUMN upstream_cf_ray TEXT;
ALTER TABLE requests ADD COLUMN egress_probe_ip TEXT;
ALTER TABLE requests ADD COLUMN egress_probe_at INTEGER;
ALTER TABLE requests ADD COLUMN egress_probe_target TEXT;
ALTER TABLE requests ADD COLUMN egress_probe_status TEXT;
