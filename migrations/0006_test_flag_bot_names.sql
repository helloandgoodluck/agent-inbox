-- Adds the is_test flag, and merges bot names that differ only in case.
--
-- is_test marks rows bots post while testing: a title/text starting with
-- '[TEST]', or test: true in the request. List routes hide them unless asked
-- (?include_test=1). Events have no flag of their own: they're hidden along
-- with their item, so the append-only events table is never touched.
ALTER TABLE items ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
ALTER TABLE activity ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;

UPDATE items SET is_test = 1 WHERE substr(title, 1, 6) = '[TEST]';
UPDATE activity SET is_test = 1 WHERE substr(text, 1, 6) = '[TEST]';

-- Bot names are canonicalized on write from now on (canonicalBot in
-- src/index.ts). Existing rows are merged here: each bot gets the casing it
-- was first seen with. Only items and activity store a bot name.
-- _known_bots once held a fixed list of names that took precedence; it is
-- left empty, since CANONICAL_BOTS now does that job at write time.
CREATE TABLE _known_bots (k TEXT PRIMARY KEY, name TEXT NOT NULL);

-- variant -> canonical, for every stored name that changes.
CREATE TABLE _bot_names (variant TEXT PRIMARY KEY, canonical TEXT NOT NULL);
INSERT INTO _bot_names (variant, canonical)
  WITH seen AS (
    SELECT bot, lower(bot) AS k, min(created_at) AS first_at
    FROM (SELECT bot, created_at FROM items UNION ALL SELECT bot, created_at FROM activity)
    GROUP BY bot
  )
  SELECT bot, coalesce(
    (SELECT name FROM _known_bots WHERE _known_bots.k = seen.k),
    (SELECT s.bot FROM seen s WHERE s.k = seen.k ORDER BY s.first_at, s.bot LIMIT 1)
  )
  FROM seen;
DELETE FROM _bot_names WHERE variant = canonical;

-- Renaming can make two rows share (bot, external_key), which the unique
-- indexes forbid. In each such group the most recently updated row keeps the
-- key, so re-posts go on updating it. Every other row is kept too, with its
-- key suffixed '#merged:<old bot>:<id>' so it stays unique and easy to find:
--   SELECT * FROM items WHERE external_key LIKE '%#merged:%';
-- (and the same on activity).
CREATE TABLE _merge_losers (tbl TEXT NOT NULL, id TEXT NOT NULL);

INSERT INTO _merge_losers (tbl, id)
  WITH r AS (
    SELECT id, external_key, updated_at,
      coalesce((SELECT canonical FROM _bot_names WHERE variant = bot), bot) AS canon
    FROM items WHERE external_key IS NOT NULL
  )
  SELECT 'items', a.id FROM r a WHERE EXISTS (
    SELECT 1 FROM r b
    WHERE b.canon = a.canon AND b.external_key = a.external_key AND b.id <> a.id
      AND (b.updated_at > a.updated_at OR (b.updated_at = a.updated_at AND b.id > a.id))
  );

INSERT INTO _merge_losers (tbl, id)
  WITH r AS (
    SELECT id, external_key, updated_at,
      coalesce((SELECT canonical FROM _bot_names WHERE variant = bot), bot) AS canon
    FROM activity WHERE external_key IS NOT NULL
  )
  SELECT 'activity', a.id FROM r a WHERE EXISTS (
    SELECT 1 FROM r b
    WHERE b.canon = a.canon AND b.external_key = a.external_key AND b.id <> a.id
      AND (b.updated_at > a.updated_at OR (b.updated_at = a.updated_at AND b.id > a.id))
  );

UPDATE items SET external_key = external_key || '#merged:' || bot || ':' || id
  WHERE id IN (SELECT id FROM _merge_losers WHERE tbl = 'items');
UPDATE activity SET external_key = external_key || '#merged:' || bot || ':' || id
  WHERE id IN (SELECT id FROM _merge_losers WHERE tbl = 'activity');

UPDATE items SET bot = (SELECT canonical FROM _bot_names WHERE variant = items.bot)
  WHERE bot IN (SELECT variant FROM _bot_names);
UPDATE activity SET bot = (SELECT canonical FROM _bot_names WHERE variant = activity.bot)
  WHERE bot IN (SELECT variant FROM _bot_names);

DROP TABLE _merge_losers;
DROP TABLE _bot_names;
DROP TABLE _known_bots;

-- ?bot= filters and the write-time name lookup compare case-insensitively.
DROP INDEX items_bot;
CREATE INDEX items_bot ON items (bot COLLATE NOCASE);
DROP INDEX activity_bot_at;
CREATE INDEX activity_bot_at ON activity (bot COLLATE NOCASE, at);
