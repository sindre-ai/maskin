import type { Database } from '@maskin/db'
import { catalogPackages, installedPackages, loopActiveDays } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
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
	// Counts of each element type provisioned by the install, keyed the same as
	// the install route's `provisioned` counter. Drives the bundle-card
	// discriminator on the emitted event.
	provisioned: {
		actors: number
		triggers: number
		skills: number
		integrations: number
	}
}

// Ordering here is the wire ordering downstream queries will see in
// `component_types`; keep it stable so PostHog aggregations don't need to sort.
const PROVISIONED_TO_COMPONENT_TYPE: ReadonlyArray<
	readonly [keyof PackageInstalledProps['provisioned'], string]
> = [
	['actors', 'actor'],
	['triggers', 'trigger'],
	['skills', 'skill'],
	['integrations', 'integration'],
]

export async function trackPackageInstalled(p: PackageInstalledProps): Promise<void> {
	const componentTypes = PROVISIONED_TO_COMPONENT_TYPE.filter(
		([key]) => p.provisioned[key] > 0,
	).map(([, type]) => type)
	await capturePosthogEvent('package_installed', p.workspaceId, {
		package_id: p.packageId,
		package_slug: p.packageSlug,
		package_version: p.packageVersion,
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		component_type_count: componentTypes.length,
		component_types: componentTypes,
	})
}

interface PackageForkedProps {
	packageId: string
	installedPackageId: string
	versionAtFork: string
	workspaceId: string
	actorId: string
}

// Called from the fork endpoint (T4: POST /api/installed-packages/:id/fork).
// Fire after the fork transaction commits — the metric is "the team detached",
// not "the team intended to".
export async function trackPackageForked(p: PackageForkedProps): Promise<void> {
	await capturePosthogEvent('package_forked', p.workspaceId, {
		package_id: p.packageId,
		installed_package_id: p.installedPackageId,
		version_at_fork: p.versionAtFork,
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

// ── Slack-app ship metric ───────────────────────────────────────────────────
//
// The "Maskin Slack App" bet's success metric is weekly active @Maskin
// mentions across ≥3 connected teams plus a downstream conversion rate. We
// fire `slack_mention_received` once per dedup'd inbound mention/DM — the
// distinct id is the workspace, mirroring the existing managed-catalog
// events so PostHog-side weekly-active joins stay simple.
//
// Anonymisation: we deliberately omit `slack_user_id` — only the resolved
// Maskin actor id is sent. The Slack user id is PII we don't need for the
// bet's success calculation, and not sending it is the cheap way to keep
// PostHog out of "we shipped a Slack user id to a third-party analytics
// service" territory.

interface SlackMentionReceivedProps {
	actorId: string
	workspaceId: string
	channelType: 'channel' | 'group' | 'im'
	slackTeamId: string
}

export async function trackSlackMentionReceived(p: SlackMentionReceivedProps): Promise<void> {
	await capturePosthogEvent('slack_mention_received', p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		channel_type: p.channelType,
		agent: 'workspace_coach',
		slack_team_id: p.slackTeamId,
	})
}

interface LoopActiveDayProps {
	installedPackageId: string
	packageId: string
	packageSlug: string
	workspaceId: string
	utcDay: string
}

// Pure emitter — the idempotency check lives in `claimLoopActiveDay` below
// so callers can decide whether to fire based on the claim result without
// the emitter coupling to the DB.
export async function trackLoopActiveDay(p: LoopActiveDayProps): Promise<void> {
	await capturePosthogEvent('loop_active_day', p.workspaceId, {
		installed_package_id: p.installedPackageId,
		package_id: p.packageId,
		package_slug: p.packageSlug,
		workspace_id: p.workspaceId,
		utc_day: p.utcDay,
	})
}

export function utcDayString(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10)
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
 * follow-up lookups for source_package_id + slug are cheap by-PK reads
 * and only run on the winning path.
 */
export async function claimLoopActiveDay(
	db: Database,
	installedPackageId: string,
	utcDay: string,
): Promise<{
	installedPackageId: string
	packageId: string
	packageSlug: string
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

	const [pkg] = await db
		.select({ slug: catalogPackages.slug })
		.from(catalogPackages)
		.where(eq(catalogPackages.id, install.sourcePackageId))
		.limit(1)

	if (!pkg) {
		logger.warn('Loop active day claim won but catalog package row missing', {
			installedPackageId,
			sourcePackageId: install.sourcePackageId,
		})
		return null
	}

	return {
		installedPackageId: install.id,
		packageId: install.sourcePackageId,
		packageSlug: pkg.slug,
		workspaceId: install.workspaceId,
	}
}
