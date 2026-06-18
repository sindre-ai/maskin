-- Migration: idempotency table for the `loop_active_day` PostHog event.
--
-- T11 (instrumentation) fires `loop_active_day` from the session-completion
-- path when the completing session's actor belongs to a managed-catalog
-- install. The ship metric counts at most one event per (installed_package,
-- UTC day), so concurrent session completions on the same day must not all
-- emit. The PRIMARY KEY on (installed_package_id, utc_day) plus
-- INSERT ... ON CONFLICT DO NOTHING gives an atomic, race-free "first claim
-- wins" check with no read-then-write window.
--
-- A whole table for one boolean per (install, day) is intentional — adding
-- a `metadata jsonb` column to `installed_packages` would couple T11's
-- concerns to T1's schema, and using a column on actors/triggers would
-- spread the dedup state across rows that get created and deleted by the
-- version-push cron, breaking the idempotency invariant.
--
-- ON DELETE CASCADE so deleting an install (or its workspace) doesn't leave
-- orphan rows behind; a future re-install of the same package gets a fresh
-- ID and starts emitting again on day one.

CREATE TABLE IF NOT EXISTS "loop_active_days" (
	"installed_package_id" uuid NOT NULL,
	"utc_day" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loop_active_days_pk" PRIMARY KEY ("installed_package_id", "utc_day")
);

ALTER TABLE "loop_active_days"
	DROP CONSTRAINT IF EXISTS "loop_active_days_installed_package_id_installed_packages_id_fk";
ALTER TABLE "loop_active_days"
	ADD CONSTRAINT "loop_active_days_installed_package_id_installed_packages_id_fk"
	FOREIGN KEY ("installed_package_id") REFERENCES "public"."installed_packages"("id")
	ON DELETE cascade ON UPDATE no action;
