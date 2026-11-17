-- Migration: trial_cards — plain-entry cards that have started a free trial (bet "A card to start a
-- 7-day trial", task T2). The Stripe card fingerprint is the key; the unique index refuses a second
-- trial on the same card, even when two requests race. Wallet cards (Apple Pay, Google Pay) are never
-- stored: their fingerprint comes from a device number, so it cannot recognise the card.
-- New, empty table, not hot-listed: plain CREATE INDEX is fine. workspace_id is SET NULL when the
-- workspace is deleted, so deleting a workspace never hands its card a fresh trial. No triggers /
-- pg_notify. Idempotent — safe to re-run.
-- Down: drizzle/down/0144_trial_cards_down.sql.

CREATE TABLE IF NOT EXISTS "trial_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trial_cards_fingerprint_uniq" ON "trial_cards" USING btree ("fingerprint");
