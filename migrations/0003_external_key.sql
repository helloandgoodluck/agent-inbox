-- A bot's own id for an item, so re-posting it updates the item instead of
-- creating a duplicate. Unique per bot; NULL for items created without one.
ALTER TABLE items ADD COLUMN external_key TEXT;

CREATE UNIQUE INDEX items_bot_external_key ON items (bot, external_key)
  WHERE external_key IS NOT NULL;
