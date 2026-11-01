-- Indexes for the daily write caps (WRITE_CAPS in src/index.ts): each new
-- item or activity entry counts the rows created in the last 24 hours, and
-- these keep that count to the window instead of the whole table. Only adds
-- indexes.
CREATE INDEX items_created ON items (created_at);
CREATE INDEX activity_created ON activity (created_at);
