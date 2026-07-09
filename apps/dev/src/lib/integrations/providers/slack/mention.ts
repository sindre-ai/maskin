import type { Database } from '@maskin/db'
import { actors, integrations, slackUserLinks, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { frontendBaseUrl } from '../../../file-urls'
import { logger } from '../../../logger'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'
import { slackPost } from './client'
import { isSlackBotToken } from './mcp-server'

// Falu-red pinned inline: Slack mrkdwn accepts colour only via the link-tag
// escape, and app.css tokens don't reach the Slack client. Matches T7's App
// Home usage — one hex, one place.
const FALU_RED = '#7C1F1A'
const WORKSPACE_COACH_NAME = 'Workspace Coach'

// Slack returns one of these on chat.* methods when the bot token is no
// longer valid — user uninstalled, keys rotated, admin disabled the install.
// Any match means we stop posting and flip the integration to `revoked` so
// the route's active-only filter catches the next delivery.
const TOKEN_REVOKED_ERROR_PATTERN = /token_revoked|invalid_auth|account_inactive|not_authed/

export const MENTION_ENTITY_TYPES = ['slack.app_mention', 'slack.direct_message'] as const
export type MentionEntityType = (typeof MENTION_ENTITY_TYPES)[number]

export function isMentionEntityType(entityType: string): entityType is MentionEntityType {
	return (MENTION_ENTITY_TYPES as readonly string[]).includes(entityType)
}

interface SlackEventEnvelope {
	team_id?: string
	event?: Record<string, unknown>
}

interface ExtractedMention {
	teamId: string
	slackUserId: string
	channel: string
	threadTs?: string
}

/**
 * Pull (team, user, channel, thread) off the normalized Slack event. Filters
 * bot-authored + subtyped messages: `message.im` covers every DM including our
 * own replies, edits, deletes, and joins — acking those would loop or misfire.
 * Returns null when the envelope isn't shaped like a user-initiated mention.
 */
export function extractMentionFields(data: Record<string, unknown>): ExtractedMention | null {
	const envelope = data as SlackEventEnvelope
	const teamId = envelope.team_id
	const event = envelope.event
	if (!teamId || !event) return null

	if (typeof event.subtype === 'string') return null
	if (event.bot_id || event.bot_profile) return null

	const slackUserId = event.user
	if (typeof slackUserId !== 'string' || slackUserId.length === 0) return null

	const channel = event.channel
	if (typeof channel !== 'string' || channel.length === 0) return null

	// Reply-in-thread if the mention is in a thread; otherwise use the message
	// ts so the ack lands as the first reply of a new thread rather than as a
	// sibling top-level message. Channel-wide posts are the failure mode T4
	// closes.
	const threadTsRaw = event.thread_ts ?? event.ts
	const threadTs = typeof threadTsRaw === 'string' ? threadTsRaw : undefined

	return { teamId, slackUserId, channel, threadTs }
}

function buildSubscriptBlock(label: string): Record<string, unknown> {
	return {
		type: 'context',
		elements: [{ type: 'mrkdwn', text: `<${FALU_RED}|↳ ${label}>` }],
	}
}

export function buildWorkingAckBlocks(
	label = WORKSPACE_COACH_NAME,
): Array<Record<string, unknown>> {
	return [
		{ type: 'section', text: { type: 'mrkdwn', text: '_Working…_' } },
		buildSubscriptBlock(label),
	]
}

export function buildUnlinkedAckBlocks(
	label = WORKSPACE_COACH_NAME,
): Array<Record<string, unknown>> {
	const linkUrl = `${frontendBaseUrl()}/integrations/slack`
	return [
		{
			type: 'section',
			text: {
				type: 'mrkdwn',
				text: `Link your Maskin account to use \`@Maskin\` here: <${linkUrl}|Open Maskin → Slack>. You can also tap the *For You* home tab to connect.`,
			},
		},
		buildSubscriptBlock(label),
	]
}

interface PostEphemeralArgs {
	channel: string
	user: string
	thread_ts?: string
	text: string
	blocks: Array<Record<string, unknown>>
	username: string
}

async function postEphemeral(accessToken: string, args: PostEphemeralArgs): Promise<void> {
	const body: Record<string, unknown> = {
		channel: args.channel,
		user: args.user,
		text: args.text,
		blocks: args.blocks,
		// chat:write.customize honours `username` on chat.postEphemeral only when
		// the token is a workspace bot token. User tokens silently fall back to
		// the installer's identity — the exact regression this bet closes, so we
		// hard-stop earlier if the stored token isn't `xoxb-`.
		username: args.username,
	}
	if (args.thread_ts) body.thread_ts = args.thread_ts
	await slackPost('chat.postEphemeral', accessToken, body)
}

function isTokenInvalidError(err: unknown): boolean {
	if (!(err instanceof Error)) return false
	return TOKEN_REVOKED_ERROR_PATTERN.test(err.message)
}

async function markIntegrationRevoked(db: Database, integrationId: string): Promise<void> {
	try {
		await db
			.update(integrations)
			.set({ status: 'revoked', updatedAt: new Date() })
			.where(eq(integrations.id, integrationId))
		logger.warn('Slack mention: integration auto-revoked after token rejection', { integrationId })
	} catch (err) {
		logger.error('Slack mention: failed to mark integration revoked', {
			integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

async function findWorkspaceCoach(
	db: Database,
	workspaceId: string,
): Promise<{ id: string; name: string } | null> {
	const rows = await db
		.select({ id: actors.id, name: actors.name })
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, WORKSPACE_COACH_NAME)),
		)
		.limit(1)
	return rows[0] ?? null
}

export interface HandleMentionArgs {
	db: Database
	integrationId: string
	workspaceId: string
	teamId: string
	slackUserId: string
	channel: string
	threadTs?: string
}

/**
 * Handle an inbound Slack `app_mention` or DM. Side-effect only — the caller
 * still passes the event through so downstream triggers fire.
 *
 * Idempotency is owned by the route's `webhook_deliveries` claim (AC-T1);
 * this handler assumes at-most-once per unique delivery per active
 * integration and does not re-check.
 *
 * On token rejection anywhere in the flow the integration row is flipped to
 * `revoked` (AC-U5) so the route's active-only filter takes the 200-with-zero
 * work path on the next delivery.
 */
export async function handleSlackMention(args: HandleMentionArgs): Promise<void> {
	const { db, integrationId, workspaceId, teamId, slackUserId, channel, threadTs } = args

	const [link] = await db
		.select({
			actorId: slackUserLinks.actorId,
			defaultWorkspaceId: slackUserLinks.defaultWorkspaceId,
		})
		.from(slackUserLinks)
		.where(and(eq(slackUserLinks.slackTeamId, teamId), eq(slackUserLinks.slackUserId, slackUserId)))
		.limit(1)

	let accessToken: string
	try {
		const tokenManager = new TokenManager()
		accessToken = await tokenManager.getValidToken(db, integrationId, getProvider('slack'))
	} catch (err) {
		if (isTokenInvalidError(err)) {
			await markIntegrationRevoked(db, integrationId)
		} else {
			logger.error('Slack mention: failed to resolve bot token', {
				integrationId,
				teamId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
		return
	}

	if (!isSlackBotToken(accessToken)) {
		// xoxp/user tokens silently ignore `username` — posting anyway would
		// impersonate the installer, the exact regression this bet closes.
		logger.error('Slack mention: stored token is not a bot token; refusing to post', {
			integrationId,
			teamId,
		})
		return
	}

	const coach = link ? await findWorkspaceCoach(db, link.defaultWorkspaceId) : null
	const agentLabel = coach?.name ?? WORKSPACE_COACH_NAME

	const blocks = link ? buildWorkingAckBlocks(agentLabel) : buildUnlinkedAckBlocks(agentLabel)
	const text = link
		? `${agentLabel} is working on it…`
		: 'Link your Maskin account to use @Maskin here.'

	try {
		await postEphemeral(accessToken, {
			channel,
			user: slackUserId,
			thread_ts: threadTs,
			blocks,
			text,
			username: agentLabel,
		})
		logger.info('Slack mention: posted ephemeral working ack', {
			integrationId,
			workspaceId,
			teamId,
			slackUserId,
			channel,
			linked: Boolean(link),
			coachActorId: coach?.id,
			threadTs,
		})
	} catch (err) {
		if (isTokenInvalidError(err)) {
			await markIntegrationRevoked(db, integrationId)
			return
		}
		// Rate limits, transient 5xx, etc. — log loudly and let the delivery
		// still land. The route's dedup claim was already committed, so the
		// provider's next retry won't double-post.
		logger.error('Slack mention: ephemeral ack failed', {
			integrationId,
			teamId,
			slackUserId,
			channel,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
