import type { Database } from '@maskin/db'
import { actors, notifications, slackUserLinks } from '@maskin/db/schema'
import { and, desc, eq, ne } from 'drizzle-orm'
import { frontendBaseUrl } from '../../../file-urls'
import { logger } from '../../../logger'
import { TokenManager } from '../../oauth/token-manager'
import type { CustomEventNormalizer } from '../../types'
import { slackViewsPublish } from './client'

const messageEntityByChannelPrefix: Record<string, string> = {
	C: 'slack.channel_message',
	G: 'slack.group_message',
	D: 'slack.direct_message',
}

const eventMapping: Record<string, { entityType: string; action: string }> = {
	message: { entityType: 'slack.message', action: 'created' },
	app_mention: { entityType: 'slack.app_mention', action: 'created' },
	reaction_added: { entityType: 'slack.reaction', action: 'added' },
	reaction_removed: { entityType: 'slack.reaction', action: 'removed' },
	channel_created: { entityType: 'slack.channel', action: 'created' },
	channel_deleted: { entityType: 'slack.channel', action: 'deleted' },
	channel_rename: { entityType: 'slack.channel', action: 'renamed' },
	member_joined_channel: { entityType: 'slack.member', action: 'joined' },
	app_home_opened: { entityType: 'slack.app_home_opened', action: 'opened' },
}

/**
 * Normalize Slack event payloads.
 *
 * Slack wraps events in an outer envelope:
 * { type: "event_callback", team_id: "T...", event: { type: "message", ... } }
 *
 * The inner event.type determines the normalized entity type and action.
 */
export const slackEventNormalizer: CustomEventNormalizer = (payload, _headers) => {
	const data = payload as Record<string, unknown>

	if (data.type !== 'event_callback') return null

	const teamId = data.team_id as string
	if (!teamId) return null

	const event = data.event as Record<string, unknown>
	if (!event) return null

	const eventType = event.type as string
	const mapped = eventMapping[eventType]
	if (!mapped) return null

	// For message events, refine entity type based on channel prefix (C=public, G=private, D=DM)
	let entityType = mapped.entityType
	if (eventType === 'message') {
		const channel = event.channel as string | undefined
		const prefix = channel?.[0]
		if (prefix && prefix in messageEntityByChannelPrefix) {
			entityType = messageEntityByChannelPrefix[prefix] as string
		}
	}

	return {
		entityType,
		action: mapped.action,
		installationId: teamId,
		data: data,
	}
}

// ── App Home — `For You` tab ───────────────────────────────────────────────

/**
 * Latest-N inbox rows surfaced on the App Home tab. Notifications are the
 * "what needs you" primitive in Maskin, so the For You feed mirrors the same
 * filter the maskin.io feed applies: anything not yet resolved, newest first.
 */
const APP_HOME_FEED_LIMIT = 10

/**
 * Falu-red is reserved for agent attribution in Block Kit. The hex is pinned
 * here (not a token) because Slack mrkdwn only accepts inline literal colour
 * via the link-tag escape — Maskin's app.css token doesn't reach the client.
 * See knowledge article ba732e88 — rule 3.
 */
const FALU_RED = '#7C1F1A'

/**
 * Fixed agent labels — no variants, no shortenings (knowledge article rule 3).
 * Anything not in this map renders as the actor's literal name so we never
 * silently drop the subscript for a new agent role.
 */
const AGENT_LABELS: Record<string, string> = {
	'Workspace Coach': 'Workspace Coach',
	Architect: 'Architect',
	Strategist: 'Strategist',
}

function formatAgentSubscript(actorName: string | null | undefined): string {
	if (!actorName) return ''
	const label = AGENT_LABELS[actorName] ?? actorName
	return `↳ ${label}`
}

/**
 * Per-(team,user) debounce. App Home re-opens fire `app_home_opened` on every
 * tab switch, so a user flipping between Home and Messages can burst the route
 * faster than Slack's views.publish rate limit (~1/s tier 4). Throttle at the
 * source: a publish for a (team,user) within DEBOUNCE_MS of the previous one
 * is dropped. This is per-process, which is fine for a single-instance dev
 * deployment; if we go multi-instance, switch to a Redis token bucket.
 */
const DEBOUNCE_MS = 1_000
const lastPublishByUser = new Map<string, number>()

function debounceKey(teamId: string, slackUserId: string): string {
	return `${teamId}:${slackUserId}`
}

function shouldDebounce(teamId: string, slackUserId: string, now: number): boolean {
	const key = debounceKey(teamId, slackUserId)
	const previous = lastPublishByUser.get(key)
	if (previous !== undefined && now - previous < DEBOUNCE_MS) return true
	lastPublishByUser.set(key, now)
	return false
}

/** Reset debounce state — exported for tests. */
export function _resetAppHomeDebounce(): void {
	lastPublishByUser.clear()
}

interface InboxRow {
	id: string
	title: string
	content: string | null
	objectId: string | null
	sourceActorName: string | null
	updatedAt: Date | string | null
	createdAt: Date | string | null
}

async function fetchInbox(
	db: Database,
	workspaceId: string,
	targetActorId: string,
): Promise<InboxRow[]> {
	return await db
		.select({
			id: notifications.id,
			title: notifications.title,
			content: notifications.content,
			objectId: notifications.objectId,
			sourceActorName: actors.name,
			updatedAt: notifications.updatedAt,
			createdAt: notifications.createdAt,
		})
		.from(notifications)
		.leftJoin(actors, eq(actors.id, notifications.sourceActorId))
		.where(
			and(
				eq(notifications.workspaceId, workspaceId),
				eq(notifications.targetActorId, targetActorId),
				ne(notifications.status, 'resolved'),
			),
		)
		.orderBy(desc(notifications.createdAt))
		.limit(APP_HOME_FEED_LIMIT)
}

interface UnlinkedView {
	blocks: Array<Record<string, unknown>>
}

/** Cold-state view: a single Connect button. T2 wires the linking flow. */
function buildUnlinkedView(): UnlinkedView {
	return {
		blocks: [
			{
				type: 'header',
				text: { type: 'plain_text', text: 'For You', emoji: false },
			},
			{
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: 'Connect your Maskin account to see what needs you here.',
				},
				accessory: {
					type: 'button',
					text: { type: 'plain_text', text: 'Connect Maskin', emoji: false },
					url: `${frontendBaseUrl()}/integrations/slack`,
					action_id: 'maskin_slack_connect',
				},
			},
		],
	}
}

interface LinkedViewArgs {
	workspaceId: string
	rows: InboxRow[]
}

/**
 * Linked-state view shape:
 *  - header "For You — N unread"
 *  - primary CTA "Open For You in Maskin ↗"
 *  - one section per inbox row + a Falu-red `↳ <agent>` context block beneath
 *
 * `views.publish` requires a `home` view; sections > 100 blocks are rejected
 * by Slack, and APP_HOME_FEED_LIMIT * 3 (section + context + divider) keeps
 * us well under that.
 */
function buildLinkedView({ workspaceId, rows }: LinkedViewArgs): UnlinkedView {
	const inboxUrl = `${frontendBaseUrl()}/${workspaceId}/inbox`
	const header = {
		type: 'header',
		text: {
			type: 'plain_text',
			text: `For You — ${rows.length} unread`,
			emoji: false,
		},
	}
	const cta = {
		type: 'actions',
		elements: [
			{
				type: 'button',
				text: { type: 'plain_text', text: 'Open For You in Maskin ↗', emoji: false },
				url: inboxUrl,
				action_id: 'maskin_open_for_you',
				style: 'primary',
			},
		],
	}

	if (rows.length === 0) {
		return {
			blocks: [
				header,
				cta,
				{
					type: 'section',
					text: { type: 'mrkdwn', text: '_Nothing needs you right now._' },
				},
			],
		}
	}

	const blocks: Array<Record<string, unknown>> = [header, cta, { type: 'divider' }]
	for (const row of rows) {
		const objectLink = row.objectId
			? `<${frontendBaseUrl()}/${workspaceId}/objects/${row.objectId}|${row.title}>`
			: row.title
		blocks.push({
			type: 'section',
			text: { type: 'mrkdwn', text: `*${objectLink}*` },
		})
		const subscript = formatAgentSubscript(row.sourceActorName)
		if (subscript) {
			blocks.push({
				type: 'context',
				elements: [
					{
						type: 'mrkdwn',
						// Slack mrkdwn renders inline colour by abusing the link
						// hex-channel; this is the documented way to colour a
						// `context` element in Block Kit without a custom image.
						text: `<${FALU_RED}|${subscript}>`,
					},
				],
			})
		}
	}
	return { blocks }
}

interface PublishAppHomeArgs {
	db: Database
	teamId: string
	slackUserId: string
	/**
	 * Optional bot token override. The webhook path looks the token up by team
	 * via TokenManager; callers that already hold a token (e.g. the OAuth
	 * account-link flow rebuilding the view post-default-write) pass it in to
	 * skip a redundant DB read.
	 */
	accessToken?: string
	/**
	 * Force a publish even if the debounce window hasn't elapsed. Used by the
	 * onboarding hand-off so a freshly-linked user sees their feed immediately
	 * after the OAuth confirm screen, not 1s later on the next tab open.
	 */
	bypassDebounce?: boolean
	/** Optional clock override for tests. */
	now?: number
}

/**
 * Build and publish the App Home `For You` view for one (team, user). Idempotent
 * — Slack's `views.publish` replaces the home view in place keyed on `user_id`,
 * so reruns are safe. Returns `false` when the call was debounced and `true`
 * when a publish was attempted (regardless of outcome — logged inside).
 *
 * Used by:
 *  - the webhook route on `app_home_opened`
 *  - the OAuth account-link flow (T2) after the first-mention default-write
 *    rebuilds the feed for the freshly-linked user
 */
export async function publishAppHomeView(args: PublishAppHomeArgs): Promise<boolean> {
	const { db, teamId, slackUserId, bypassDebounce } = args
	const now = args.now ?? Date.now()

	if (!bypassDebounce && shouldDebounce(teamId, slackUserId, now)) {
		logger.debug('Slack App Home: debounced views.publish', { teamId, slackUserId })
		return false
	}

	// Find the integration for this team. Multi-workspace fan-out lives in T4 /
	// T6; for App Home we publish once per team since the view is owned by the
	// (Slack team, Slack user) pair and the slack_user_links row already picks
	// the right Maskin workspace.
	const [link] = await db
		.select({
			actorId: slackUserLinks.actorId,
			defaultWorkspaceId: slackUserLinks.defaultWorkspaceId,
		})
		.from(slackUserLinks)
		.where(and(eq(slackUserLinks.slackTeamId, teamId), eq(slackUserLinks.slackUserId, slackUserId)))
		.limit(1)

	let view: UnlinkedView
	if (!link) {
		view = buildUnlinkedView()
	} else {
		const rows = await fetchInbox(db, link.defaultWorkspaceId, link.actorId)
		view = buildLinkedView({ workspaceId: link.defaultWorkspaceId, rows })
	}

	// Resolve a bot token. Caller-supplied tokens skip the integrations lookup.
	let accessToken = args.accessToken
	if (!accessToken) {
		// Account linking is per-team — there can be multiple Maskin workspaces
		// connected to the same Slack team. For the publish call we just need a
		// valid bot token for THIS team; any active integration on this team
		// will do, since the token is workspace-scoped on Slack's side.
		const { integrations } = await import('@maskin/db/schema')
		const [integration] = await db
			.select({ id: integrations.id })
			.from(integrations)
			.where(
				and(
					eq(integrations.provider, 'slack'),
					eq(integrations.externalId, teamId),
					eq(integrations.status, 'active'),
				),
			)
			.limit(1)
		if (!integration) {
			logger.warn('Slack App Home: no active integration for team; skipping publish', {
				teamId,
				slackUserId,
			})
			return false
		}
		// Lazy import to break the registry → webhooks → registry cycle.
		const { getProvider } = await import('../../registry')
		const tokenManager = new TokenManager()
		accessToken = await tokenManager.getValidToken(db, integration.id, getProvider('slack'))
	}

	try {
		await slackViewsPublish(accessToken, {
			user_id: slackUserId,
			view: {
				type: 'home',
				blocks: view.blocks,
			},
		})
		logger.info('Slack App Home: published For You view', {
			teamId,
			slackUserId,
			linked: Boolean(link),
			rowCount: link ? view.blocks.length : 0,
		})
	} catch (err) {
		logger.error('Slack App Home: views.publish failed', {
			teamId,
			slackUserId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	return true
}

// Exposed for tests that want to assert the rendered view shape without
// hitting the network or Slack-side state.
export const _internal = {
	buildLinkedView,
	buildUnlinkedView,
	formatAgentSubscript,
	FALU_RED,
	APP_HOME_FEED_LIMIT,
}
