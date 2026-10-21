-- Rollback for 0103_web_push_subscriptions.sql. Drops the table (and its index and
-- unique constraint with it). Browsers re-subscribe the next time the user turns
-- browser notifications on.
DROP TABLE IF EXISTS "web_push_subscriptions";
