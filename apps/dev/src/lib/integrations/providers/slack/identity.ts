import type { Database } from '@maskin/db'
import { slackUserLinks } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import type { NormalizedEvent } from '../../types'

/**
 * DM vs channel is the identity axis for a Slack mention (AC-U1). Every
 * routing decision in this module — which workspace receives the event,
 * whose connectors run — is driven by which side of this split we land on.
 */
export type MentionSurface = 'dm' | 'channel'

/**
 * Distinguish DM mentions from channel mentions on inbound Slack events.
 *
 * Slack encodes the same mention two ways depending on event type:
 *  - `message.im` — `event.channel` starts with `D`, `event.channel_type` is
 *    `'im'`. The webhooks normalizer already routes this to
 *    `slack.direct_message` via the channel-prefix map, so we can trust the
 *    entity type alone here.
 *  - `app_mention` — the entity type stays `slack.app_mention` regardless of
 *    surface, so we have to look at the raw envelope. `channel_type: 'im'`
 *    is authoritative when Slack sends it; the `D` channel-id prefix is the
 *    fallback for older Events API payloads that omit the field.
 *
 * Returns `null` for non-mention Slack events so the caller can leave every
 * other webhook path untouched (App Home opens, reactions, plain channel
 * messages, etc.).
 */
export function getMentionSurface(normalized: NormalizedEvent): MentionSurface | null {
	if (normalized.entityType === 'slack.direct_message') return 'dm'
	if (normalized.entityType !== 'slack.app_mention') return null

	const data = normalized.data as Record<string, unknown> | undefined
	const event = data?.event as Record<string, unknown> | undefined
	const channelType = event?.channel_type
	if (typeof channelType === 'string' && channelType === 'im') return 'dm'
	const channel = event?.channel
	if (typeof channel === 'string' && channel.startsWith('D')) return 'dm'
	return 'channel'
}

/** The Slack user id of the actor who posted the mention. `null` when the envelope is malformed. */
export function extractMentioningSlackUserId(normalized: NormalizedEvent): string | null {
	const data = normalized.data as Record<string, unknown> | undefined
	const event = data?.event as Record<string, unknown> | undefined
	const user = event?.user
	return typeof user === 'string' && user.length > 0 ? user : null
}

/** The Slack channel id the mention was posted in. `null` when malformed. */
export function extractChannelId(normalized: NormalizedEvent): string | null {
	const data = normalized.data as Record<string, unknown> | undefined
	const event = data?.event as Record<string, unknown> | undefined
	const channel = event?.channel
	return typeof channel === 'string' && channel.length > 0 ? channel : null
}

/** Shape the resolver needs off each candidate integration row. */
interface EligibleIntegration {
	id: string
	workspaceId: string
}

export interface DispatchResolution<T extends EligibleIntegration> {
	/** Integrations that should receive the event and run agent dispatch. */
	targets: T[]
	/**
	 * `true` when a DM landed but the mentioning user has no `slack_user_links`
	 * row (or their link points at a workspace that's no longer bound to this
	 * Slack team). The caller posts the AC-U5 re-link picker and drops the
	 * event — a DM never falls back to the installer/channel context.
	 */
	needsRelinkPrompt: boolean
}

/**
 * Split the DM identity path from the channel identity path (AC-U1, AC-T2).
 *
 *  - DM: single-player. Route to the mentioning Slack user's
 *    `slack_user_links` row and ONLY that workspace. A DM from a user with
 *    no link never lands anywhere — instead the caller posts the re-link
 *    picker (AC-U5), so the user picks a workspace explicitly. This
 *    protects the DM promise: your DM to `@Maskin` runs in your personal
 *    workspace and nowhere else.
 *  - Channel: shared. Pass through every candidate integration unchanged.
 *    The channel surface never reads `slack_user_links` — the channel's
 *    bound workspace is defined by the `integrations` row, and any
 *    per-user override would leak personal routing into a shared surface.
 *    Multiple Maskin workspaces bound to the same Slack team continue to
 *    receive their own copy of the channel mention (the T8 multi-workspace
 *    fan-out), each running under its own workspace's shared connectors.
 *
 * A DM link that points at a workspace with no matching active integration
 * for this Slack team collapses to the same outcome as a missing link: we
 * signal `needsRelinkPrompt` and return no targets. It means the link is
 * stale (the workspace revoked Slack, or the row was migrated in from a
 * different team), and silently routing to the wrong workspace would break
 * AC-U5's re-link contract.
 */
export async function resolveMentionDispatch<T extends EligibleIntegration>(
	db: Database,
	slackTeamId: string,
	slackUserId: string,
	surface: MentionSurface,
	candidates: T[],
): Promise<DispatchResolution<T>> {
	if (surface === 'channel') {
		return { targets: candidates, needsRelinkPrompt: false }
	}

	if (candidates.length === 0) {
		// No workspace has this Slack team installed — same "no bound workspace"
		// no-op as the channel path treats it. No prompt: we have no bot token
		// to post one with.
		return { targets: [], needsRelinkPrompt: false }
	}

	const [link] = await db
		.select({ defaultWorkspaceId: slackUserLinks.defaultWorkspaceId })
		.from(slackUserLinks)
		.where(
			and(eq(slackUserLinks.slackTeamId, slackTeamId), eq(slackUserLinks.slackUserId, slackUserId)),
		)
		.limit(1)

	if (!link) return { targets: [], needsRelinkPrompt: true }

	const filtered = candidates.filter((c) => c.workspaceId === link.defaultWorkspaceId)
	if (filtered.length === 0) return { targets: [], needsRelinkPrompt: true }
	return { targets: filtered, needsRelinkPrompt: false }
}
