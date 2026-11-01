-- Delivery state for inbox actions forwarded to FORWARD_WEBHOOK_URL, one row
-- per forwarded event. Kept out of events so that table stays append-only.
CREATE TABLE event_deliveries (
  event_id        INTEGER PRIMARY KEY REFERENCES events (id),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  delivered_at    TEXT,
  last_error      TEXT
);

CREATE INDEX event_deliveries_due ON event_deliveries (next_attempt_at)
  WHERE delivered_at IS NULL;
