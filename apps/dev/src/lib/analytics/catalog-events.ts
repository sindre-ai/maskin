import type { Database } from '@maskin/db'
import { installedPackages, loopActiveDays } from '@maskin/db/schema'
import { desc, eq } from 'drizzle-orm'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

// Server-side emitters for the managed-catalog ship metric (two external
// workspaces running an active loop unforked for 14+ days). The bet hangs
// on these three events being present in PostHog 191282 — fork rate and
// agent DAU in the first test both derive from them, so the emit sites
// need to be wired exactly once each and dedup'd where the call site
// can fire more than once per logical event.

interface PackageInstalledProps {
	packageId: string
	packageSlug: string
	packageVersion: string
	workspaceId: string
	actorId: string
}

export async function trackPackageInstalled(p: PackageInstalledProps): Promise<void> {
	await capturePosthogEvent('package_installed', p.workspaceId, {
		package_id: p.packageId,
		package_slug: p.packageSlug,
		package_version: p.packageVersion,
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
	})
}

interface PackageForkedProps {
	packageId: string
	packageSlug: string
	packageVersion: string
	sourceInstallId: string
	workspaceId: string
	actorId: string
}

// Called from the fork endpoint (POST /api/installed-packages/:id/fork).
// Fire after the fork transaction commits — the metric is "the team detached",
// not "the team intended to". `source_install_id` is the install row that
// just got detached; the bet's HogQL LEFT JOINs `loop_active_day.install_id`
// against this to filter out forked installs from the streak count.
export async function trackPackageForked(p: PackageForkedProps): Promise<void> {
	await capturePosthogEvent('package_forked', p.workspaceId, {
		package_id: p.packageId,
		package_slug: p.packageSlug,
		package_version: p.packageVersion,
		source_install_id: p.sourceInstallId,
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
	})
}

interface PackageUninstalledProps {
	packageId: string
	installedPackageId: string
	workspaceId: string
	actorId: string
	keptItems: boolean
}

export async function trackPackageUninstalled(p: PackageUninstalledProps): Promise<void> {
	await capturePosthogEvent('package_uninstalled', p.workspaceId, {
		package_id: p.packageId,
		installed_package_id: p.installedPackageId,
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		kept_items: p.keptItems,
	})
}

interface LoopActiveDayProps {
	installId: string
	packageId: string
	workspaceId: string
	day: string
	consecutiveDays: number
}

// Pure emitter — the idempotency check lives in `claimLoopActiveDay` below
// so callers can decide whether to fire based on the claim result without
// the emitter coupling to the DB.
export async function trackLoopActiveDay(p: LoopActiveDayProps): Promise<void> {
	await capturePosthogEvent('loop_active_day', p.workspaceId, {
		install_id: p.installId,
		package_id: p.packageId,
		workspace_id: p.workspaceId,
		day: p.day,
		consecutive_days: p.consecutiveDays,
	})
}

export function utcDayString(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10)
}

function previousUtcDay(day: string): string {
	const d = new Date(`${day}T00:00:00Z`)
	d.setUTCDate(d.getUTCDate() - 1)
	return d.toISOString().slice(0, 10)
}

/**
 * Atomically claim "first activity today" on an installed package. Returns
 * the package context if the claim was won (caller should emit
 * `loop_active_day`), or null if the day has already been claimed.
 *
 * Implementation: INSERT ON CONFLICT DO NOTHING into the `loop_active_days`
 * idempotency table. The primary key on (installed_package_id, utc_day)
 * makes the claim race-safe at the DB level — two concurrent session
 * completions both run the INSERT but only one gets a returning row. The
 * follow-up lookup for source_package_id is a cheap by-PK read and only
 * runs on the winning path.
 */
export async function claimLoopActiveDay(
	db: Database,
	installedPackageId: string,
	utcDay: string,
): Promise<{
	installedPackageId: string
	packageId: string
	workspaceId: string
} | null> {
	const claimed = await db
		.insert(loopActiveDays)
		.values({ installedPackageId, utcDay })
		.onConflictDoNothing({ target: [loopActiveDays.installedPackageId, loopActiveDays.utcDay] })
		.returning({ installedPackageId: loopActiveDays.installedPackageId })

	if (!claimed[0]) return null

	const [install] = await db
		.select({
			id: installedPackages.id,
			sourcePackageId: installedPackages.sourcePackageId,
			workspaceId: installedPackages.workspaceId,
		})
		.from(installedPackages)
		.where(eq(installedPackages.id, installedPackageId))
		.limit(1)

	if (!install) {
		logger.warn('Loop active day claim won but install row missing', { installedPackageId })
		return null
	}

	return {
		installedPackageId: install.id,
		packageId: install.sourcePackageId,
		workspaceId: install.workspaceId,
	}
}

/**
 * Count the consecutive-day streak ending at `utcDay` for a given install.
 * The streak the bet measures is "≥14 consecutive days of `loop_active_day`
 * on the same install", so we have to compute it server-side and include
 * it on the event — the HogQL filter (`max(consecutive_days) >= 14`) reads
 * straight off the emitted property.
 *
 * Bounded read: pull the most recent days for this install, build a set,
 * walk back day-by-day from `utcDay` until a gap. Limit 60 covers any
 * streak the bet cares about — the threshold is 14, so 60 leaves headroom
 * for a long-running unforked install without growing the query.
 *
 * Returns 0 if today hasn't been claimed yet (caller should always call
 * after a winning `claimLoopActiveDay`).
 */
export async function computeConsecutiveDaysStreak(
	db: Database,
	installedPackageId: string,
	utcDay: string,
): Promise<number> {
	const rows = await db
		.select({ utcDay: loopActiveDays.utcDay })
		.from(loopActiveDays)
		.where(eq(loopActiveDays.installedPackageId, installedPackageId))
		.orderBy(desc(loopActiveDays.utcDay))
		.limit(60)

	const claimed = new Set(rows.map((r) => r.utcDay))
	let streak = 0
	let cursor = utcDay
	while (claimed.has(cursor)) {
		streak++
		cursor = previousUtcDay(cursor)
	}
	return streak
}
