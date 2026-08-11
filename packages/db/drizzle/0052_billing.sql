-- Workspace billing + invoices (settings-billing bet, T1).
--
-- `billing` is one row per workspace. `status` mirrors the lifecycle of the
-- Stripe PaymentIntent that activated the plan: 'inactive' (never subscribed),
-- 'pending' (checkout started, not yet confirmed), 'active' (payment verified
-- succeeded server-side by POST /api/billing/complete), 'declined' (the last
-- checkout failed). `price_cents` and the display fields are snapshots resolved
-- from the Stripe Price at checkout time — the Stripe Price object is the
-- source of truth for amount, never a hardcoded number. Card data is never
-- stored here (or anywhere Maskin-owned) — it only ever lives inside Stripe's
-- own embedded checkout frames.
--
-- `invoices` records successful charges. Rows are inserted by the complete
-- path only after `paymentIntent.retrieve()` returns succeeded, so a client
-- cannot fabricate a paid invoice.
--
-- Idempotent — safe to re-run (integration harness replays all migrations
-- against a fresh schema on each run).

CREATE TABLE IF NOT EXISTS "billing" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL DEFAULT 'free',
	"plan_label" text,
	"status" text NOT NULL DEFAULT 'inactive',
	"price_cents" integer,
	"currency" text NOT NULL DEFAULT 'usd',
	"invoice_email" text,
	"stripe_customer_id" text,
	"stripe_price_id" text,
	"next_charge_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "billing_workspace_id_workspaces_id_fk"
		FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
	CONSTRAINT "billing_status_check"
		CHECK ("status" IN ('inactive','pending','active','declined'))
);

CREATE TABLE IF NOT EXISTS "invoices" (
	"id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL DEFAULT 'usd',
	"stripe_payment_intent_id" text,
	"status" text NOT NULL DEFAULT 'paid',
	"billed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "invoices_workspace_id_workspaces_id_fk"
		FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "invoices_ws_billed_at_idx"
	ON "invoices" ("workspace_id", "billed_at");

-- One invoice per succeeded PaymentIntent. POST /api/billing/complete races
-- concurrent calls for the same intent (Elements re-confirm, retries); the
-- active row serializes the race and the ON CONFLICT DO NOTHING insert in the
-- route takes the idempotent path instead of double-billing.
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_stripe_payment_intent_id_key"
	ON "invoices" ("stripe_payment_intent_id")
	WHERE "stripe_payment_intent_id" IS NOT NULL;