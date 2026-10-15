-- Idempotency ledger for the Telnyx call-event webhook (voice-outreach bet).
-- One row per claimed Telnyx event_id; a duplicate delivery hits the primary
-- key and returns 200 with no side effects. New table, nothing reads it until
-- the route that ships with it.
CREATE TABLE IF NOT EXISTS "telnyx_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
