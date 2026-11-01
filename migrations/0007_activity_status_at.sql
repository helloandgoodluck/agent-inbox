-- GET /api/inbox/dashboard reads running activity of any age:
--   WHERE status = 'in_progress' ORDER BY at DESC LIMIT 50
-- activity_at alone made that a scan of the whole table; this makes it a
-- search on status, already in order. The dashboard's other queries were
-- already indexed (EXPLAIN QUERY PLAN checked against the live-data mirror).
CREATE INDEX activity_status_at ON activity (status, at);
