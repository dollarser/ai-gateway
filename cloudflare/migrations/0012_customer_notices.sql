CREATE TABLE customer_notices(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,priority TEXT NOT NULL DEFAULT 'normal',audience TEXT NOT NULL DEFAULT 'all',recipients TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL DEFAULT 'draft',starts_at REAL NOT NULL,expires_at REAL,created REAL NOT NULL,updated REAL NOT NULL,published_at REAL,version INTEGER NOT NULL DEFAULT 1);
CREATE INDEX idx_customer_notices_active ON customer_notices(state,starts_at,expires_at);
CREATE TABLE customer_notice_reads(notice_id TEXT NOT NULL REFERENCES customer_notices(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,read_at REAL NOT NULL,PRIMARY KEY(notice_id,user_id));
CREATE INDEX idx_customer_notice_reads_user ON customer_notice_reads(user_id,notice_id);
