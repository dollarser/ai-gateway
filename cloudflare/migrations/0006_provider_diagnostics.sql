ALTER TABLE requests ADD COLUMN upstream_error_code TEXT;
ALTER TABLE requests ADD COLUMN upstream_error_param TEXT;
ALTER TABLE requests ADD COLUMN upstream_request_id TEXT;
ALTER TABLE requests ADD COLUMN compatibility TEXT;
