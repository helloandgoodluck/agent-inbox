-- Adds item types, the 'rejected' status, and the bot activity log.
--
-- SQLite can't change a CHECK constraint in place, so items is rebuilt with
-- 'rejected' allowed and a nullable type column. events references items, so
-- foreign keys are deferred until the rebuilt table has taken its name.
PRAGMA defer_foreign_keys = on;

CREATE TABLE items_new (
  id           TEXT PRIMARY KEY,
  bot          TEXT NOT NULL,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'waiting'
               CHECK (status IN ('waiting', 'done', 'snoozed', 'rejected')),
  note         TEXT,
  links        TEXT NOT NULL DEFAULT '[]', -- JSON array of {url, label}
  snooze_until TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  external_key TEXT,
  type         TEXT
               CHECK (type IN ('approval', 'yes_no', 'reply', 'sign', 'due_today'))
);

INSERT INTO items_new (id, bot, title, status, note, links, snooze_until, created_at, updated_at, external_key)
  SELECT id, bot, title, status, note, links, snooze_until, created_at, updated_at, external_key FROM items;

DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

CREATE INDEX items_status_updated ON items (status, updated_at);
CREATE INDEX items_bot ON items (bot);
CREATE UNIQUE INDEX items_bot_external_key ON items (bot, external_key)
  WHERE external_key IS NOT NULL;

PRAGMA defer_foreign_keys = off;

-- What bots are doing or have done, separate from items that need you. An
-- entry with an external_key can be re-posted to move it from in_progress to
-- finished.
CREATE TABLE activity (
  id           TEXT PRIMARY KEY,
  bot          TEXT NOT NULL,
  text         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('in_progress', 'finished')),
  external_key TEXT,
  at           TEXT NOT NULL, -- when it started, or finished once it has
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX activity_at ON activity (at);
CREATE INDEX activity_bot_at ON activity (bot, at);
CREATE UNIQUE INDEX activity_bot_external_key ON activity (bot, external_key)
  WHERE external_key IS NOT NULL;

-- The page's timeline reads recent events across all items.
CREATE INDEX events_at ON events (at);
