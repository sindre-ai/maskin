import type { Database } from '@maskin/db'
import { actors, workspaceMembers, workspaces } from '@maskin/db/schema'
import {
	type BillingPlan,
	OWNERSHIP_CAPS,
	SEAT_CAPS,
	higherTier,
	workspaceSettingsSchema,
} from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'

/**
 * Narrow structural type accepted by every helper below so they can be
 * called with either the top-level `db` or a `tx` handed to a
 * `db.transaction(async (tx) => ...)` callback — mirrors the `Tx` precedent
 * in apps/dev/src/routes/stripe-webhook.ts.
 */
type Queryable = Pick<Database, 'select' | 'execute'>

/**
 * Count of type='human' members currently in a workspace. Agents never count
 * toward the seat cap — filtered via an INNER JOIN to actors using Drizzle's
 * query builder (not a raw `sql` correlated subquery), which sidesteps the
 * unqualified-column pitfall documented in .claude/rules/known-pitfalls.md
 * entirely (Drizzle's own query builder always table-qualifies).
 */
export async function countHumanMembers(db: Queryable, workspaceId: string): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`COUNT(*)::int` })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.type, 'human')))
	return row?.n ?? 0
}

/** Seat cap for a plan tier. `null` = unlimited (byollm). */
export function seatCapForPlan(plan: BillingPlan): number | null {
	return SEAT_CAPS[plan]
}

/** Resolve a workspace's plan tier from its settings JSON, defaulting to 'trial'. */
export function resolvePlanTier(settings: unknown): BillingPlan {
	const parsed = workspaceSettingsSchema.partial().safeParse(settings ?? {})
	return (parsed.success ? parsed.data.billing?.plan : undefined) ?? 'trial'
}

/**
 * Plan tier of every workspace where `actorId` is currently `billing_owner_id`.
 * Zero rows means the actor owns nothing yet.
 */
export async function ownedWorkspacePlans(db: Queryable, actorId: string): Promise<BillingPlan[]> {
	const rows = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.billingOwnerId, actorId))
	return rows.map((r) => resolvePlanTier(r.settings))
}

/**
 * Effective tier = MAX(plan) over an actor's currently-owned workspaces,
 * folded together with `candidatePlan` (the plan of the workspace they're
 * about to claim/keep ownership of) — folding it in BEFORE the cap check
 * means a brand-new actor claiming their first workspace at 'pro' is capped
 * at 5, not at trial's 1. Zero owned workspaces + a trial candidate yields
 * 'trial' (cap 1), matching a fresh signup's default.
 *
 * A single number governs total owned-workspace count across all tiers
 * combined — NOT independent per-tier buckets. Buckets were rejected: they'd
 * gate a new workspace by its OWN proposed tier rather than the actor's
 * demonstrated tier (the exact "gate by the new thing's own plan" pattern
 * rejected for the seat cap), they're gameable (create 25 trial workspaces,
 * upgrade one to team, still holding 24 "fine-looking" trial workspaces), and
 * they're harder to explain on a downgrade ("which bucket overflowed?" vs.
 * "you own 26 of 25 allowed at your Team tier").
 */
export function computeEffectiveTier(
	ownedPlans: BillingPlan[],
	candidatePlan: BillingPlan,
): BillingPlan {
	return ownedPlans.reduce<BillingPlan>((acc, p) => higherTier(acc, p), candidatePlan)
}

/** Ownership cap for an effective tier. `null` = unlimited (byollm). */
export function ownershipCapForTier(tier: BillingPlan): number | null {
	return OWNERSHIP_CAPS[tier]
}

/**
 * Serializes ownership-cap-affecting operations (claim at workspace create,
 * claim at ownership transfer) for a single actor. The ownership cap is an
 * aggregate over potentially many `workspaces` rows with no single row a
 * `FOR UPDATE` could lock to protect it, so this uses a Postgres advisory
 * lock instead — the first use of one in this codebase (every prior lock
 * here is a single-row `FOR UPDATE`, e.g. stripe-webhook.ts's `applyEvent`).
 *
 * `pg_advisory_xact_lock` takes an int8 key; `hashtextextended` is a stable,
 * built-in Postgres function (no extension required) used to fold the actor
 * UUID into a bigint. A hash collision between two different actor UUIDs is
 * harmless (it over-serializes two unrelated actors' claims, never
 * under-serializes) and vanishingly unlikely.
 *
 * MUST be called inside the same `db.transaction()` whose commit/rollback
 * should release the lock — `pg_advisory_xact_lock` auto-releases at
 * transaction end, unlike `pg_advisory_lock`. Every write path that mutates
 * `billing_owner_id` (create, transfer) must call this before reading the
 * actor's owned-workspace set, or the invariant it protects reopens.
 */
export async function lockActorForOwnershipClaim(
	tx: Pick<Database, 'execute'>,
	actorId: string,
): Promise<void> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${actorId}::text, 0))`)
}

export class SeatCapExceededError extends Error {
	readonly workspaceId: string
	readonly plan: BillingPlan
	readonly used: number
	readonly cap: number

	constructor(ctx: { workspaceId: string; plan: BillingPlan; used: number; cap: number }) {
		super(`Workspace seat cap exceeded: ${ctx.used}/${ctx.cap} human members on ${ctx.plan} plan.`)
		this.name = 'SeatCapExceededError'
		this.workspaceId = ctx.workspaceId
		this.plan = ctx.plan
		this.used = ctx.used
		this.cap = ctx.cap
	}
}

export class OwnershipCapExceededError extends Error {
	readonly actorId: string
	readonly effectiveTier: BillingPlan
	readonly used: number
	readonly cap: number

	constructor(ctx: { actorId: string; effectiveTier: BillingPlan; used: number; cap: number }) {
		super(
			`Ownership cap exceeded: actor owns ${ctx.used}/${ctx.cap} workspaces at ${ctx.effectiveTier} tier.`,
		)
		this.name = 'OwnershipCapExceededError'
		this.actorId = ctx.actorId
		this.effectiveTier = ctx.effectiveTier
		this.used = ctx.used
		this.cap = ctx.cap
	}
}
