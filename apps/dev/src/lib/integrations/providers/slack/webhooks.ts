import type { Database } from '@maskin/db'
import {
	actors,
	events as eventsTable,
	integrations as integrationsTable,
	notifications,
	slackUserLinks,
	triggers,
	workspaces,
} from '@maskin/db/schema'
import { and, desc, eq, ne, or, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../../../analytics/posthog'
import { decrypt } from '../../../crypto'
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
	member_left_channel: { entityType: 'slack.member', action: 'left' },
	app_home_opened: { entityType: 'slack.app_home_opened', action: 'opened' },
	link_shared: { entityType: 'slack.link_shared', action: 'shared' },
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
 * Slack mrkdwn link tags (`<URL|text>`, `<#HEX|text>`) treat `|`, `<`, `>` as
 * structural metacharacters. A `|` in the link `text` closes it early; a `<`
 * inside the text can begin a sibling tag. Escape both names before they hit
 * the `<#HEX|↳ name (workspace)>` form so user-controlled actor/workspace names
 * can't break the colour wrapper or smuggle a fake user-mention tag.
 */
function escapeMrkdwnText(value: string): string {
	return value.replace(/[<|>]/g, (ch) => (ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&#124;'))
}

/**
 * `↳ <agent display name> (<workspace name>)` — the per-bot-message subscript
 * shipped across all Slack surfaces (chat replies, unfurls, App Home). The
 * agent name is the `actors.name` for the resolved Maskin actor; the workspace
 * name is the linked Maskin workspace pulled from `slack_user_links` (or the
 * per-session override from `/maskin workspace`). No fixed allow-list — any
 * agent role surfaces by its real display name so we never silently drop the
 * subscript for a new agent.
 *
 * Returns `''` when no actor is available (no slack_user_links → no caller).
 * Workspace name is optional: if absent we render just `↳ <agent>` rather than
 * a dangling `()` so the subscript stays meaningful when the link table is
 * mid-migration or a workspace was deleted out from under the link row.
 */
function formatAgentSubscript(
	actorName: string | null | undefined,
	workspaceName?: string | null,
): string {
	if (!actorName) return ''
	const safeActor = escapeMrkdwnText(actorName)
	if (!workspaceName) return `↳ ${safeActor}`
	return `↳ ${safeActor} (${escapeMrkdwnText(workspaceName)})`
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
	// Coarse TTL sweep on each write so the Map is bounded by active-user churn
	// within a 2s window (DEBOUNCE_MS * 2), not by process lifetime. Anything
	// older than that can't affect the next debounce check anyway.
	const cutoff = now - DEBOUNCE_MS * 2
	for (const [k, ts] of lastPublishByUser) {
		if (ts < cutoff) lastPublishByUser.delete(k)
	}
	lastPublishByUser.set(key, now)
	return false
}

/** Debounce map size — exported for tests to assert the TTL sweep bounds it. */
export function _appHomeDebounceSize(): number {
	return lastPublishByUser.size
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
	workspaceName: string | null
	rows: InboxRow[]
}

/**
 * Linked-state view shape:
 *  - header "For You — N unread"
 *  - primary CTA "Open For You in Maskin ↗"
 *  - one section per inbox row + a Falu-red `↳ <agent> (<workspace>)` context
 *    block beneath
 *
 * `views.publish` requires a `home` view; sections > 100 blocks are rejected
 * by Slack, and APP_HOME_FEED_LIMIT * 3 (section + context + divider) keeps
 * us well under that.
 */
function buildLinkedView({ workspaceId, workspaceName, rows }: LinkedViewArgs): UnlinkedView {
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
		const subscript = formatAgentSubscript(row.sourceActorName, workspaceName)
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
	let rowCount = 0
	if (!link) {
		view = buildUnlinkedView()
	} else {
		const [workspace] = await db
			.select({ name: workspaces.name })
			.from(workspaces)
			.where(eq(workspaces.id, link.defaultWorkspaceId))
			.limit(1)
		const rows = await fetchInbox(db, link.defaultWorkspaceId, link.actorId)
		rowCount = rows.length
		view = buildLinkedView({
			workspaceId: link.defaultWorkspaceId,
			workspaceName: workspace?.name ?? null,
			rows,
		})
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
			rowCount,
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

// ── member_left_channel auto-pause handler ─────────────────────────────────
//
// Slack fires `member_left_channel` whenever a user (bot or human) leaves a
// channel; Slack does NOT distinguish kicked-vs-voluntary at the event level.
// When the leaving user IS our own bot, every trigger that lists this channel
// in `config.conditions[*].value` is auto-paused: the trigger row is disabled,
// `metadata.auto_paused` is stamped for the banner to read, an audit row is
// appended, an in-app inbox notification is created for the trigger owner, and
// a PostHog metric fires. Slack DM fallback to the installer is deferred to v2
// because `parseTokenResponse` doesn't currently persist `authed_user.id` — the
// audit call-out in the parent task's completion note is Q2.
//
// The handler is invoked from `slackWebhookFanOut` (fan-out.ts) as a
// side-effect-only branch (returns `[]`); the fan-out already runs per matched
// integration for the team, so this handler iterates every matching integration
// itself to survive standalone / test-only invocations that don't come through
// the fan-out. Multiple invocations for the same delivery are idempotent via
// the recency guard below — `enabled=false` + `metadata.auto_paused` overwrite
// are stable, and repeated invocations short-circuit once the stamp is fresh.
//
// Gated behind the `SLACK_AUTO_PAUSE_ON_KICK` env var (backend kill switch —
// the repo's `FLAGS` registry is visual-layer only per `.claude/rules/feature-
// flags.md`, so this uses the plain env-var mechanism instead). Flag OFF =
// event is normalized and dispatched, handler no-ops and returns immediately.

export interface SlackMemberLeftEvent {
	type: 'member_left_channel'
	user?: string
	channel?: string
	channel_type?: string
	event_ts?: string
	team?: string
}

export interface SlackMemberLeftPayload {
	type: 'event_callback'
	team_id?: string
	event?: SlackMemberLeftEvent
	[key: string]: unknown
}

/**
 * Shape stamped on `triggers.metadata.auto_paused` when the bot is kicked out
 * of a channel a trigger listens on. The banner in
 * `apps/web/src/components/triggers/slack-trigger-setup-status.tsx` reads
 * `reason === 'slack_member_left'` to flip to the red state. `previous_enabled`
 * captures whether the trigger was enabled before auto-pause so Task 4's
 * Resume flow can restore the pre-pause state instead of blindly enabling.
 */
export interface AutoPausedMetadata {
	reason: 'slack_member_left'
	channel_id: string
	paused_at: string
	previous_enabled: boolean
}

// Multiple fan-out calls can land inside seconds of each other for a
// multi-workspace-per-Slack-team install (one fan-out per matched integration
// × N iterations in the handler). Second and later runs see this stamp and
// short-circuit before writing an events / notifications row again. The 5-min
// window is long enough to cover Slack's own retries plus one minute of DB
// latency and short enough that a legitimate re-kick a while later still
// re-notifies.
const RECENT_AUTO_PAUSE_WINDOW_MS = 5 * 60_000

/** Kill switch (Architect §10 + comment 488058 on task 3643cf14). */
function slackAutoPauseOnKickEnabled(): boolean {
	const raw = process.env.SLACK_AUTO_PAUSE_ON_KICK?.trim()
	return raw === '1' || raw === 'true'
}

function readBotUserIdFromCredentials(rawCredentials: string): string | null {
	try {
		const parsed = JSON.parse(decrypt(rawCredentials)) as { botUserId?: unknown }
		const id = parsed.botUserId
		return typeof id === 'string' && id.length > 0 ? id : null
	} catch (err) {
		logger.warn('Slack auto-pause: could not decrypt credentials', {
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}
}

function readSystemActorId(rawConfig: unknown): string | null {
	if (!rawConfig || typeof rawConfig !== 'object') return null
	const id = (rawConfig as { system_actor_id?: unknown }).system_actor_id
	return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Auto-pause every trigger in every workspace bound to the Slack team whose bot
 * was just kicked from `payload.event.channel`.
 *
 * See the block comment above for design context (kill switch, idempotency,
 * multi-workspace fan-out semantics). Never throws — the caller (fan-out) is
 * fire-and-forget by contract, so any failure is logged and swallowed to keep
 * the webhook ack path clean.
 */
export async function handleMemberLeftChannel(
	db: Database,
	payload: SlackMemberLeftPayload,
): Promise<{ pausedTriggerIds: string[] }> {
	if (!slackAutoPauseOnKickEnabled()) return { pausedTriggerIds: [] }

	const teamId = payload.team_id
	const event = payload.event
	const channelId = typeof event?.channel === 'string' ? event.channel : ''
	const leavingUserId = typeof event?.user === 'string' ? event.user : ''
	if (!teamId || !channelId || !leavingUserId) return { pausedTriggerIds: [] }

	// (a) All active Slack integrations for this team. Do NOT `.limit(1)` — a
	// single Slack workspace can be connected to several Maskin workspaces and
	// each one's triggers need to be paused independently.
	const activeIntegrations = await db
		.select()
		.from(integrationsTable)
		.where(
			and(
				eq(integrationsTable.provider, 'slack'),
				eq(integrationsTable.externalId, teamId),
				eq(integrationsTable.status, 'active'),
			),
		)
	if (activeIntegrations.length === 0) return { pausedTriggerIds: [] }

	const pausedTriggerIds: string[] = []
	for (const integration of activeIntegrations) {
		// (b) Bot-only guard. A human leaving a channel Maskin lives in is
		// noise — only bot removals should trip an auto-pause. If credentials
		// don't decrypt or the botUserId isn't stashed (pre-`parseTokenResponse`
		// installs), the guard fails closed and we skip this integration.
		const botUserId = readBotUserIdFromCredentials(integration.credentials as string)
		if (!botUserId || leavingUserId !== botUserId) continue

		// (c) One workspace-scoped JSONB match. Slack event triggers store the
		// channel filter as either `event.channel` (channel-message /
		// app-mention) or `event.item.channel` (reaction / member). `@>`
		// containment is index-friendly (once a GIN on `config->'conditions'`
		// exists — Architect §7 deferred that) and picker-shape-safe: an LHS
		// value with more channels still matches when RHS includes just this
		// one channel.
		const containsChannel = JSON.stringify([
			{ field: 'event.channel', operator: 'in', value: [channelId] },
		])
		const containsItemChannel = JSON.stringify([
			{ field: 'event.item.channel', operator: 'in', value: [channelId] },
		])
		const matchedTriggers = await db
			.select()
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, integration.workspaceId),
					or(
						sql`${triggers.config}->'conditions' @> ${containsChannel}::jsonb`,
						sql`${triggers.config}->'conditions' @> ${containsItemChannel}::jsonb`,
					),
				),
			)
		if (matchedTriggers.length === 0) continue

		const systemActorId = readSystemActorId(integration.config)
		const slackTeamId = integration.externalId

		for (const trigger of matchedTriggers) {
			const md = (trigger.metadata as Record<string, unknown> | null) ?? {}
			const existing = md.auto_paused as AutoPausedMetadata | undefined

			// Recency dedup: the same (channel, team) auto-pause was just
			// written. Fan-out runs once per integration and this handler
			// itself iterates every integration for the team, so N fan-out
			// invocations × N integrations would otherwise emit N² events /
			// notifications rows. The recency window is well below Slack's
			// retry ceiling (~1 minute) with headroom.
			if (
				existing?.reason === 'slack_member_left' &&
				existing.channel_id === channelId &&
				typeof existing.paused_at === 'string' &&
				Date.now() - Date.parse(existing.paused_at) < RECENT_AUTO_PAUSE_WINDOW_MS
			) {
				continue
			}

			// Preserve the original pre-pause enabled state so Task 4's Resume
			// button restores the trigger's true prior state instead of blindly
			// flipping to enabled. If the trigger is being auto-paused a second
			// time (`already-disabled-still-stamps` per AC), carry the earlier
			// `previous_enabled` forward.
			const previousEnabled =
				typeof existing?.previous_enabled === 'boolean' ? existing.previous_enabled : trigger.enabled

			const pausedAt = new Date().toISOString()
			const autoPaused: AutoPausedMetadata = {
				reason: 'slack_member_left',
				channel_id: channelId,
				paused_at: pausedAt,
				previous_enabled: previousEnabled,
			}

			// (d) Single-row txn — cheap, but keeps the enabled flip and the
			// metadata stamp atomic against a concurrent PATCH from the trigger
			// form. Merge additively so PR B's `metadata.slack_setup` sibling
			// (and any future sibling) is preserved.
			try {
				await db.transaction(async (tx) => {
					await tx
						.update(triggers)
						.set({
							enabled: false,
							metadata: { ...md, auto_paused: autoPaused },
						})
						.where(eq(triggers.id, trigger.id))
				})
			} catch (err) {
				logger.error('Slack auto-pause: pause update failed', {
					triggerId: trigger.id,
					workspaceId: integration.workspaceId,
					error: err instanceof Error ? err.message : String(err),
				})
				continue
			}
			pausedTriggerIds.push(trigger.id)

			// (e) Audit trail. The webhook route writes `events` rows with
			// `actorId = integration.config.system_actor_id`; we mirror that so
			// this row belongs to the same actor for downstream filters.
			if (systemActorId) {
				try {
					await db.insert(eventsTable).values({
						workspaceId: integration.workspaceId,
						actorId: systemActorId,
						action: 'auto_paused',
						entityType: 'trigger',
						entityId: trigger.id,
						data: { reason: 'slack_member_left', channel_id: channelId },
					})
				} catch (err) {
					logger.warn('Slack auto-pause: events insert failed', {
						triggerId: trigger.id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			// (f) In-app inbox item for the trigger owner. The For You feed
			// (App Home + web) reads `notifications` directly, so this row is
			// what surfaces the auto-pause outside the trigger form.
			if (systemActorId) {
				try {
					await db.insert(notifications).values({
						workspaceId: integration.workspaceId,
						type: 'trigger.auto_paused',
						title: 'Trigger auto-paused',
						content: `Maskin was removed from a Slack channel — reinvite the app in Slack, then resume "${trigger.name}".`,
						sourceActorId: systemActorId,
						targetActorId: trigger.createdBy,
						metadata: {
							reason: 'slack_member_left',
							trigger_id: trigger.id,
							channel_id: channelId,
						},
						status: 'unresolved',
					})
				} catch (err) {
					logger.warn('Slack auto-pause: notifications insert failed', {
						triggerId: trigger.id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			// (g) Slack DM to installer — DEFERRED to v2. Audit Q2: the OAuth
			// callback doesn't persist `authed_user.id`, only the bot user id.
			// Enabling the DM path is a follow-up (parseTokenResponse extension +
			// backfill on connect); once persisted, the DM copy + reinvite deep
			// link belong here so the installer surface stays in one place.

			// (h) Metric fire-and-forget, same shape PR B uses.
			void capturePosthogEvent('slack.trigger.auto_paused', integration.workspaceId, {
				workspace_id: integration.workspaceId,
				slack_team_id: slackTeamId ?? null,
				trigger_id: trigger.id,
				channel_id: channelId,
				reason: 'member_left',
			})
		}
	}
	return { pausedTriggerIds }
}
