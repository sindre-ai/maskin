-- Rollback for 0089_device_auth_codes.sql. Lives under drizzle/down/ so the forward migration runner
-- never picks it up. Reverting REQUIRES first reverting the device-auth routes (they read and write
-- this table); code from before them never touches it. Pending sign-in codes are lost, which only
-- means a TV shows a new code.

DROP TABLE IF EXISTS "device_auth_codes";
