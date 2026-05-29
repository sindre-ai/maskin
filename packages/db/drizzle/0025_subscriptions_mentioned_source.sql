-- Add 'mentioned' as a valid subscription source.
--
-- A comment that @-mentions an actor now auto-subscribes that actor to the
-- commented object so the mention surfaces on their For You page. Use a
-- distinct source from 'commenter'/'author'/'manual' so the row's origin
-- remains legible (e.g. for future "unsubscribe from mentions" UX).

ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_source_check";
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_source_check"
	CHECK ("source" IN ('manual', 'author', 'commenter', 'mentioned'));
