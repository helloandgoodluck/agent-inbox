-- event_deliveries_due held every undelivered row, including ones that gave
-- up after 10 attempts. Those stay undelivered forever, so the retry cron
-- (every minute) read each of them on every run. The index now holds only
-- deliveries that can still be retried. The 10 must match
-- FORWARD_MAX_ATTEMPTS in src/index.ts, which uses it as a literal so SQLite
-- can match the query to this index.
DROP INDEX event_deliveries_due;
CREATE INDEX event_deliveries_due ON event_deliveries (next_attempt_at)
  WHERE delivered_at IS NULL AND attempts < 10;
