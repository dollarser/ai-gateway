-- Closed catalog detail is no longer useful after its daily quota window.
CREATE INDEX idx_requests_catalog_day ON requests(day) WHERE path='/v1/models' AND ended IS NOT NULL;
CREATE TABLE catalog_archive_candidates(id TEXT PRIMARY KEY);
INSERT INTO catalog_archive_candidates SELECT r.id FROM requests r WHERE r.path='/v1/models' AND r.ended IS NOT NULL AND r.day<date('now','+8 hours') AND NOT EXISTS(SELECT 1 FROM luna_usage l WHERE l.lease=r.id) AND NOT EXISTS(SELECT 1 FROM audio_usage a WHERE a.lease=r.id) AND NOT EXISTS(SELECT 1 FROM quota_adjustments q WHERE q.lease=r.id) ORDER BY r.started LIMIT 500;
INSERT INTO request_history(user_id,day,service,total,failed,response_bytes,prompt_tokens,completion_tokens) SELECT user_id,day,service,count(*),sum(CASE WHEN status>=400 THEN 1 ELSE 0 END),sum(response_bytes),sum(prompt_tokens),sum(completion_tokens) FROM requests WHERE id IN(SELECT id FROM catalog_archive_candidates) GROUP BY user_id,day,service ON CONFLICT(user_id,day,service) DO UPDATE SET total=total+excluded.total,failed=failed+excluded.failed,response_bytes=response_bytes+excluded.response_bytes,prompt_tokens=prompt_tokens+excluded.prompt_tokens,completion_tokens=completion_tokens+excluded.completion_tokens;
DELETE FROM requests WHERE id IN(SELECT id FROM catalog_archive_candidates);
DROP TABLE catalog_archive_candidates;
