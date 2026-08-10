import type { Database } from '@maskin/db'
import { installedLoops, loopActiveDays, marketplaceLoops } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

// Server-side emitters for the managed-marketplace ship metric (two external
// workspaces running an active loop unforked for 14+ days). The bet hangs
// on these three events being present in PostHog 191282 — fork rate and
// agent DAU in the first test both derive from them, so the emit sites
// need to be wired exactly once each and dedup'd where the call site
// can fire more than once per logical event.

interface LoopInstalledProps {
	loopId: string
	loopSlug: string
	loopVersion: string
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
		extensions: number
	}
}

// Ordering here is the wire ordering downstream queries will see in
// `component_types`; keep it stable so PostHog aggregations don't need to sort.
const PROVISIONED_TO_COMPONENT_TYPE: ReadonlyArray<
	readonly [keyof LoopInstalledProps['provisioned'], string]
> = [
	['actors', 'actor'],
	['triggers', 'trigger'],
	['skills', 'skill'],
	['integrations', 'integration'],
	['extensions', 'extension'],
]

export async function trackLoopInstalled(p: LoopInstalledProps): Promise<void> {
	const componentTypes = PROVISIONED_TO_COMPONENT_TYPE.filter(
		([key]) => p.provisioned[key] > 0,
	).map(([, type]) => type)
	await capturePosthogEvent('loop_installed', p.workspaceId, {
		loop_id: p.loopId,
		loop_slug: p.loopSlug,
		loop_version: p.loopVersion,
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		component_type_count: componentTypes.length,
		component_types: componentTypes,
	})
}

interface LoopForkedProps {
	loopId: string
	installedLoopId: string
	versionAtFork: string
	workspaceId: string
	actorId: string
}

// Called from the fork endpoint (T4: POST /api/installed-loops/:id/fork).
// Fire after the fork transaction commits — the metric is "the team detached",
// not "the team intended to".
export async function trackLoopForked(p: LoopForkedProps): Promise<void> {
	await capturePosthogEvent('loop_forked', p.workspaceId, {
		loop_id: p.loopId,
		installed_loop_id: p.installedLoopId,
		version_at_fork: p.versionAtFork,
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
	})
}

interface LoopUninstalledProps {
	loopId: string
	installedLoopId: string
	workspaceId: string
	actorId: string
	keptItems: boolean
}

export async function trackLoopUninstalled(p: LoopUninstalledProps): Promise<void> {
	await capturePosthogEvent('loop_uninstalled', p.workspaceId, {
		loop_id: p.loopId,
		installed_loop_id: p.installedLoopId,
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
// distinct id is the workspace, mirroring the existing managed-marketplace
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
	installedLoopId: string
	loopId: string
	loopSlug: string
	workspaceId: string
	utcDay: string
}

// Pure emitter — the idempotency check lives in `claimLoopActiveDay` below
// so callers can decide whether to fire based on the claim result without
// the emitter coupling to the DB.
export async function trackLoopActiveDay(p: LoopActiveDayProps): Promise<void> {
	await capturePosthogEvent('loop_active_day', p.workspaceId, {
		installed_loop_id: p.installedLoopId,
		loop_id: p.loopId,
		loop_slug: p.loopSlug,
		workspace_id: p.workspaceId,
		utc_day: p.utcDay,
	})
}

export function utcDayString(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10)
}

/**
 * Atomically claim "first activity today" on an installed loop. Returns
 * the loop context if the claim was won (caller should emit
 * `loop_active_day`), or null if the day has already been claimed.
 *
 * Implementation: INSERT ON CONFLICT DO NOTHING into the `loop_active_days`
 * idempotency table. The primary key on (installed_loop_id, utc_day)
 * makes the claim race-safe at the DB level — two concurrent session
 * completions both run the INSERT but only one gets a returning row. The
 * follow-up lookups for source_loop_id + slug are cheap by-PK reads
 * and only run on the winning path.
 */
export async function claimLoopActiveDay(
	db: Database,
	installedLoopId: string,
	utcDay: string,
): Promise<{
	installedLoopId: string
	loopId: string
	loopSlug: string
	workspaceId: string
} | null> {
	const claimed = await db
		.insert(loopActiveDays)
		.values({ installedLoopId, utcDay })
		.onConflictDoNothing({ target: [loopActiveDays.installedLoopId, loopActiveDays.utcDay] })
		.returning({ installedLoopId: loopActiveDays.installedLoopId })

	if (!claimed[0]) return null

	const [install] = await db
		.select({
			id: installedLoops.id,
			sourceLoopId: installedLoops.sourceLoopId,
			workspaceId: installedLoops.workspaceId,
		})
		.from(installedLoops)
		.where(eq(installedLoops.id, installedLoopId))
		.limit(1)

	if (!install) {
		logger.warn('Loop active day claim won but install row missing', { installedLoopId })
		return null
	}

	const [loop] = await db
		.select({ slug: marketplaceLoops.slug })
		.from(marketplaceLoops)
		.where(eq(marketplaceLoops.id, install.sourceLoopId))
		.limit(1)

	if (!loop) {
		logger.warn('Loop active day claim won but marketplace loop row missing', {
			installedLoopId,
			sourceLoopId: install.sourceLoopId,
		})
		return null
	}

	return {
		installedLoopId: install.id,
		loopId: install.sourceLoopId,
		loopSlug: loop.slug,
		workspaceId: install.workspaceId,
	}
}
