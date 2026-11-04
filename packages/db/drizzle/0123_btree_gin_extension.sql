-- Migration: turn on btree_gin, which lets the message-text search index in 0124 hold the chat id
-- next to the trigrams, so one index scan answers "does this chat have a message with this word".
--
-- btree_gin is a trusted extension (Postgres 13+), like pg_trgm in 0122. IF NOT EXISTS makes a
-- re-run safe.
--
-- Reversible: drizzle/down/0123_btree_gin_extension_down.sql.
CREATE EXTENSION IF NOT EXISTS btree_gin;
