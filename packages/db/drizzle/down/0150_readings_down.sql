-- Rollback for 0150. Drops the readings (and their indexes and trigger with them), then the
-- trigger function. Nothing else depends on either. Objects and targets are untouched.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "readings";
DROP FUNCTION IF EXISTS readings_refuse_update();
