-- Items are things a bot is waiting on you for (or has finished).
-- Times are ISO 8601 UTC strings, so they sort and compare as text.
CREATE TABLE items (
  id           TEXT PRIMARY KEY,
  bot          TEXT NOT NULL,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'waiting'
               CHECK (status IN ('waiting', 'done', 'snoozed')),
  note         TEXT,
  links        TEXT NOT NULL DEFAULT '[]', -- JSON array of {url, label}
  snooze_until TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX items_status_updated ON items (status, updated_at);
CREATE INDEX items_bot ON items (bot);

-- Append-only log of everything that happened to an item.
CREATE TABLE events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items (id),
  type    TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}', -- JSON
  at      TEXT NOT NULL
);

CREATE INDEX events_item ON events (item_id, id);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
