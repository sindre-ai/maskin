-- Migration: turn on pg_trgm, which the message-text search index in 0124 needs.
--
-- pg_trgm is a trusted extension (Postgres 13+), so the database owner can create it without
-- superuser rights, on Supabase too. IF NOT EXISTS makes a re-run safe. Alone in its file, as is
-- each of 0123 and 0124 (see packages/db/MIGRATIONS.md).
--
-- Reversible: drizzle/down/0122_pg_trgm_extension_down.sql.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
