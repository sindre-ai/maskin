-- Partial expression index on `settings.billing.stripe_customer_id` so the
-- Stripe webhook resolver fallback can find a workspace by customer id in one
-- indexable lookup instead of scanning every row and re-parsing the JSONB
-- settings blob in JS. The fallback fires for any `invoice.*` /
-- `customer.subscription.*` event that arrives without `metadata.workspace_id`
-- (most invoices, since metadata doesn't auto-inherit from the subscription),
-- so on a degraded webhook endpoint this runs on every retry.
--
-- Built CONCURRENTLY: `workspaces` isn't on the hot-tables list today, but it's
-- referenced by nearly every workspace-scoped write, so a SHARE lock for the
-- duration of the build would block tenant traffic. CONCURRENTLY must be the
-- only statement in this file per packages/db/MIGRATIONS.md.
--
-- The WHERE clause keeps the index small by indexing only rows that actually
-- have a Stripe customer id — most workspaces are BYOLLM and never hit Stripe.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "workspaces_billing_stripe_customer_id_idx"
	ON "workspaces" ((settings->'billing'->>'stripe_customer_id'))
	WHERE settings->'billing'->>'stripe_customer_id' IS NOT NULL;
