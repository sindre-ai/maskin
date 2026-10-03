-- Rollback for 0076_device_tokens.sql. Drops the table (and its index and
-- unique constraint with it). Registered device tokens are lost; devices
-- re-register on next app launch.
DROP TABLE IF EXISTS "device_tokens";
