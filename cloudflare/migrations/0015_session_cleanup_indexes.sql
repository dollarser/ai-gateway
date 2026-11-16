-- Expiry cleanup and family revocation must not scan all active browser sessions.
CREATE INDEX idx_sessions_expiry ON sessions(expires);
CREATE INDEX idx_sessions_family ON sessions(family_id);
CREATE INDEX idx_auth_families_expiry ON auth_families(expires);
