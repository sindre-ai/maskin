import type { Database } from '@maskin/db'
import {
	actors,
	integrations,
	slackUserLinks,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { decrypt } from '../../../crypto'
import { logger } from '../../../logger'
import type { PreDisconnectContext, StoredCredentials } from '../../types'
import { isSlackBotToken } from './mcp-server'

const SLACK_API_BASE = 'https://slack.com/api'
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Identifier we put on every Block Kit element this module emits so the
 * interactive endpoint can route an inbound `block_actions` / `view_submission`
 * back to `dispatchAccountLinkAction` without colliding with other interactive
 * surfaces (T6's status / driver edits use `obj:<ws>:<id>`).
 */
const BLOCK_ID_PREFIX = 'maskin_account_link'
const WORKSPACE_SELECT_ACTION = `${BLOCK_ID_PREFIX}:workspace_select`
const SET_DEFAULT_ACTION = `${BLOCK_ID_PREFIX}:set_default`
const CONFIRM_ACTION = `${BLOCK_ID_PREFIX}:confirm`

interface SlackChatPostEphemeralResponse {
	ok: boolean
	message_ts?: string
	error?: string
}

interface SlackUsersInfoResponse {
	ok: boolean
	user?: {
		id: string
		profile?: { email?: string }
		is_bot?: boolean
	}
	error?: string
}

async function slackJsonPost(
	path: string,
	accessToken: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${SLACK_API_BASE}/${path}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	if (!res.ok) {
		throw new Error(`Slack ${path} HTTP ${res.status}`)
	}
	return (await res.json()) as Record<string, unknown>
}

async function slackUsersInfo(
	accessToken: string,
	userId: string,
): Promise<SlackUsersInfoResponse> {
	const url = new URL(`${SLACK_API_BASE}/users.info`)
	url.searchParams.set('user', userId)
	url.searchParams.set('include_locale', 'false')
	const res = await fetch(url.toString(), {
		headers: { Authorization: `Bearer ${accessToken}` },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	return (await res.json()) as SlackUsersInfoResponse
}

/**
 * Read a usable bot token directly off the integration row. Bypasses the
 * generic TokenManager because we don't want a refresh attempt for a Slack
 * token (it never expires) and we want a hard failure if the credential is
 * not a bot token — posting as a user token here would defeat the whole
 * point of `chat:write.customize`.
 */
function readBotToken(integrationCredentials: string): string {
	const credentials = JSON.parse(decrypt(integrationCredentials)) as StoredCredentials
	const token = credentials.accessToken
	if (!isSlackBotToken(token)) {
		throw new Error('Slack integration credential is not a bot token (xoxb-) — cannot post')
	}
	return token as string
}

interface WorkspaceOption {
	id: string
	name: string
}

/**
 * Resolve the Maskin workspaces a given Slack user could plausibly link to.
 * Filters to workspaces that (a) have an active Slack integration for this
 * `teamId` and (b) have the resolved Maskin actor as a member. Returns at most
 * 100 options — Slack's `static_select` limit — sorted by workspace name.
 */
async function resolveLinkableWorkspaces(
	db: Database,
	teamId: string,
	actorId: string,
): Promise<WorkspaceOption[]> {
	const integrationRows = await db
		.select({ workspaceId: integrations.workspaceId })
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, 'slack'),
				eq(integrations.externalId, teamId),
				eq(integrations.status, 'active'),
			),
		)
	const integrationWorkspaceIds = Array.from(
		new Set(integrationRows.map((r) => r.workspaceId).filter(Boolean)),
	)
	if (integrationWorkspaceIds.length === 0) return []

	const memberRows = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, actorId),
				inArray(workspaceMembers.workspaceId, integrationWorkspaceIds),
			),
		)
	const memberWorkspaceIds = memberRows.map((r) => r.workspaceId)
	if (memberWorkspaceIds.length === 0) return []

	const workspaceRows = await db
		.select({ id: workspaces.id, name: workspaces.name })
		.from(workspaces)
		.where(inArray(workspaces.id, memberWorkspaceIds))
	return workspaceRows
		.map((w) => ({ id: w.id, name: w.name ?? 'Unnamed workspace' }))
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, 100)
}

async function resolveActorByEmail(
	db: Database,
	email: string | undefined,
): Promise<{ id: string; email: string } | null> {
	if (!email) return null
	const normalised = email.trim().toLowerCase()
	if (!normalised) return null
	const rows = await db
		.select({ id: actors.id, email: actors.email })
		.from(actors)
		.where(sql`lower(${actors.email}) = ${normalised}`)
		.limit(1)
	const row = rows[0]
	if (!row || !row.email) return null
	return { id: row.id, email: row.email }
}

/**
 * Build the ephemeral payload sent on first @mention / DM. Three variants:
 *  1. No matching Maskin actor → "connect Maskin first" with a sign-up link.
 *  2. Actor exists but no workspaces match → "no workspace installed Maskin yet".
 *  3. Actor exists with N workspaces → static_select picker + default checkbox.
 *
 * Exported for the route + tests so the route doesn't need to know the picker
 * internals.
 */
export function buildAccountLinkBlocks(args: {
	frontendUrl: string
	slackTeamId: string
	slackUserId: string
	actorEmail: string | null
	workspaces: WorkspaceOption[]
}): Array<Record<string, unknown>> {
	const { frontendUrl, slackTeamId, slackUserId, actorEmail, workspaces: options } = args

	if (!actorEmail) {
		return [
			{
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: "I don't recognise this Slack user as a Maskin teammate yet. Sign in to Maskin with the same email and try again.",
				},
			},
			{
				type: 'actions',
				block_id: `${BLOCK_ID_PREFIX}:connect_cta`,
				elements: [
					{
						type: 'button',
						text: { type: 'plain_text', text: 'Open Maskin' },
						url: frontendUrl,
						action_id: `${BLOCK_ID_PREFIX}:open_maskin`,
					},
				],
			},
		]
	}

	if (options.length === 0) {
		return [
			{
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: `Hi <@${slackUserId}> — Maskin recognises you as *${actorEmail}* but none of your Maskin workspaces have installed the Slack app for this team yet. Ask a workspace owner to connect Slack, then come back here.`,
				},
			},
		]
	}

	// Persist the (team, user) tuple on each element via the deterministic
	// block_id so the interactive endpoint can identify the requester without a
	// state cookie. Slack guarantees block_id round-trips on actions.
	// `static_select` rejects payloads with >100 options — slice defensively so
	// callers can pass the full membership list without thinking about it.
	const optionElements = options
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, 100)
		.map((w) => ({
			text: { type: 'plain_text', text: w.name },
			value: w.id,
		}))
	return [
		{
			type: 'section',
			text: {
				type: 'mrkdwn',
				text: 'Pick the Maskin workspace this Slack workspace should talk to. You can change it anytime with `/maskin workspace <name>`.',
			},
		},
		{
			type: 'input',
			block_id: `${BLOCK_ID_PREFIX}:picker:${slackTeamId}:${slackUserId}`,
			label: { type: 'plain_text', text: 'Maskin workspace' },
			element: {
				type: 'static_select',
				action_id: WORKSPACE_SELECT_ACTION,
				placeholder: { type: 'plain_text', text: 'Choose a workspace' },
				options: optionElements,
			},
		},
		{
			type: 'actions',
			block_id: `${BLOCK_ID_PREFIX}:default:${slackTeamId}:${slackUserId}`,
			elements: [
				{
					type: 'checkboxes',
					action_id: SET_DEFAULT_ACTION,
					initial_options: [
						{
							text: { type: 'plain_text', text: 'Set as default for this Slack workspace' },
							value: 'set_default',
						},
					],
					options: [
						{
							text: { type: 'plain_text', text: 'Set as default for this Slack workspace' },
							value: 'set_default',
						},
					],
				},
			],
		},
		{
			type: 'actions',
			block_id: `${BLOCK_ID_PREFIX}:confirm:${slackTeamId}:${slackUserId}`,
			elements: [
				{
					type: 'button',
					style: 'primary',
					text: { type: 'plain_text', text: 'Link this workspace' },
					action_id: CONFIRM_ACTION,
					value: 'confirm',
				},
			],
		},
	]
}

interface PromptArgs {
	db: Database
	integrationId: string
	integrationCredentials: string
	slackTeamId: string
	slackUserId: string
	channelId: string
	frontendUrl: string
}

/**
 * Check whether the @mentioning Slack user already has a `slack_user_links`
 * row; if not, post an ephemeral picker so they can pick a Maskin workspace
 * (AC-U3, AC-U5). No-op when the link already exists.
 *
 * Best-effort: a failure here logs and returns false rather than rejecting,
 * because the calling fan-out must never lose the underlying mention event.
 */
export async function maybePromptAccountLink(args: PromptArgs): Promise<boolean> {
	const {
		db,
		integrationId,
		integrationCredentials,
		slackTeamId,
		slackUserId,
		channelId,
		frontendUrl,
	} = args
	try {
		const existing = await db
			.select({ slackUserId: slackUserLinks.slackUserId })
			.from(slackUserLinks)
			.where(
				and(
					eq(slackUserLinks.slackTeamId, slackTeamId),
					eq(slackUserLinks.slackUserId, slackUserId),
				),
			)
			.limit(1)
		if (existing.length > 0) return false

		const botToken = readBotToken(integrationCredentials)
		const info = await slackUsersInfo(botToken, slackUserId)
		if (info.user?.is_bot) {
			// A bot @mentioning Maskin is not a user we can link; skip silently.
			return false
		}
		const email = info.ok ? info.user?.profile?.email : undefined
		const actor = await resolveActorByEmail(db, email)
		const linkable = actor ? await resolveLinkableWorkspaces(db, slackTeamId, actor.id) : []
		const blocks = buildAccountLinkBlocks({
			frontendUrl,
			slackTeamId,
			slackUserId,
			actorEmail: actor?.email ?? null,
			workspaces: linkable,
		})

		const response = (await slackJsonPost('chat.postEphemeral', botToken, {
			channel: channelId,
			user: slackUserId,
			text: 'Link your Maskin account to keep going.',
			blocks,
		})) as unknown as SlackChatPostEphemeralResponse
		if (!response.ok) {
			throw new Error(`chat.postEphemeral failed: ${response.error ?? 'unknown error'}`)
		}
		logger.info('Slack account-link prompt posted', {
			integrationId,
			slackTeamId,
			slackUserId,
			matchedActor: actor?.id ?? null,
			workspaceOptions: linkable.length,
		})
		return true
	} catch (err) {
		logger.warn('Slack account-link prompt failed; mention will proceed unlinked', {
			integrationId,
			slackTeamId,
			slackUserId,
			error: err instanceof Error ? err.message : String(err),
		})
		return false
	}
}

interface BlockAction {
	action_id?: string
	block_id?: string
	selected_option?: { value?: string }
	selected_options?: Array<{ value?: string }>
	value?: string
}

interface InteractivePayload {
	type?: string
	user?: { id?: string }
	team?: { id?: string }
	response_url?: string
	actions?: BlockAction[]
	state?: { values?: Record<string, Record<string, BlockAction>> }
}

export interface AccountLinkAction {
	kind: 'unhandled' | 'noop' | 'linked' | 'invalid'
	message?: string
}

/**
 * Whether an interactivity payload belongs to the account-link picker. Slack
 * apps get exactly one Interactivity Request URL, so the shared interactive
 * route uses this to decide between `dispatchAccountLinkAction` and the
 * object-edit handler. Every element the picker emits carries the
 * `maskin_account_link` prefix on its block_id and action_id.
 */
export function ownsAccountLinkInteraction(payload: {
	actions?: Array<{ action_id?: string; block_id?: string }>
}): boolean {
	return (payload.actions ?? []).some(
		(a) =>
			(a.block_id ?? '').startsWith(BLOCK_ID_PREFIX) ||
			(a.action_id ?? '').startsWith(BLOCK_ID_PREFIX),
	)
}

/**
 * Apply an inbound interactive payload to the `slack_user_links` table. Only
 * acts on payloads whose block_ids start with `BLOCK_ID_PREFIX`, so the route
 * can call this unconditionally on every interactivity POST. Returns the
 * outcome so the caller can choose the ephemeral reply copy.
 */
export async function dispatchAccountLinkAction(
	db: Database,
	payload: InteractivePayload,
): Promise<AccountLinkAction> {
	const teamId = payload.team?.id
	const slackUserId = payload.user?.id
	if (!teamId || !slackUserId) return { kind: 'invalid', message: 'Missing team or user id' }

	// Only respond to the confirm button — workspace_select and the checkbox
	// alone are not commits.
	const confirmAction = (payload.actions ?? []).find((a) => a.action_id === CONFIRM_ACTION)
	const ownsAnyBlock = (payload.actions ?? []).some((a) =>
		(a.block_id ?? '').startsWith(BLOCK_ID_PREFIX),
	)
	if (!confirmAction && !ownsAnyBlock) return { kind: 'unhandled' }
	if (!confirmAction) return { kind: 'noop' }

	const values = payload.state?.values ?? {}
	let selectedWorkspaceId: string | undefined
	let setAsDefault = false
	for (const [blockId, actionsByActionId] of Object.entries(values)) {
		if (!blockId.startsWith(BLOCK_ID_PREFIX)) continue
		for (const [actionId, action] of Object.entries(actionsByActionId)) {
			if (actionId === WORKSPACE_SELECT_ACTION) {
				selectedWorkspaceId = action.selected_option?.value
			}
			if (actionId === SET_DEFAULT_ACTION) {
				setAsDefault = (action.selected_options ?? []).some((o) => o.value === 'set_default')
			}
		}
	}
	if (!selectedWorkspaceId) {
		return { kind: 'invalid', message: 'Pick a workspace first, then press Link.' }
	}

	// Verify the chosen workspace genuinely has an active Slack integration for
	// this team and the linking actor is a member — block_id round-trips can be
	// trusted for routing, never for authorisation.
	const integrationRows = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, 'slack'),
				eq(integrations.externalId, teamId),
				eq(integrations.workspaceId, selectedWorkspaceId),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	if (integrationRows.length === 0) {
		return {
			kind: 'invalid',
			message: 'That workspace no longer has Slack installed. Pick another.',
		}
	}

	// Re-resolve the actor; the user could have signed up between the prompt
	// and the click.
	const credentialsForTeam = await db
		.select({ credentials: integrations.credentials })
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, 'slack'),
				eq(integrations.externalId, teamId),
				eq(integrations.workspaceId, selectedWorkspaceId),
			),
		)
		.limit(1)
	const credentialsRow = credentialsForTeam[0]
	if (!credentialsRow) return { kind: 'invalid', message: 'Internal: no credentials row' }
	let actorEmail: string | undefined
	try {
		const botToken = readBotToken(credentialsRow.credentials)
		const info = await slackUsersInfo(botToken, slackUserId)
		actorEmail = info.user?.profile?.email
	} catch (err) {
		logger.warn('account-link: users.info lookup failed; cannot link', {
			teamId,
			slackUserId,
			error: err instanceof Error ? err.message : String(err),
		})
		return {
			kind: 'invalid',
			message: 'Could not reach Slack to confirm your identity. Try again in a moment.',
		}
	}
	const actor = await resolveActorByEmail(db, actorEmail)
	if (!actor) return { kind: 'invalid', message: 'No Maskin account matches your Slack email.' }

	const memberRows = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, actor.id),
				eq(workspaceMembers.workspaceId, selectedWorkspaceId),
			),
		)
		.limit(1)
	if (memberRows.length === 0) {
		return { kind: 'invalid', message: "You're not a member of that Maskin workspace." }
	}

	// `setAsDefault` is the checkbox state, but for now `default_workspace_id`
	// is the only routing column we have — when unchecked we still write the row
	// so re-prompting stops, but it stays correct because the user just told us
	// where to route. Future per-session overrides will live in their own table.
	await db
		.insert(slackUserLinks)
		.values({
			slackTeamId: teamId,
			slackUserId,
			actorId: actor.id,
			defaultWorkspaceId: selectedWorkspaceId,
		})
		.onConflictDoUpdate({
			target: [slackUserLinks.slackTeamId, slackUserLinks.slackUserId],
			set: {
				actorId: actor.id,
				defaultWorkspaceId: selectedWorkspaceId,
				updatedAt: new Date(),
			},
		})

	logger.info('Slack user link saved', {
		teamId,
		slackUserId,
		actorId: actor.id,
		workspaceId: selectedWorkspaceId,
		setAsDefault,
	})

	return {
		kind: 'linked',
		message: setAsDefault
			? 'Linked — Maskin will route your @mentions here by default.'
			: 'Linked.',
	}
}

export interface SlashCommandPayload {
	team_id?: string
	user_id?: string
	command?: string
	text?: string
	response_url?: string
}

export interface SlashCommandResult {
	/** Ephemeral text to send back to Slack via the immediate 200 body. */
	responseText: string
	/** True when the link row was modified. */
	updated: boolean
}

/**
 * Handle the `/maskin workspace <name>` slash command. Per the brief this is
 * the per-session override: it updates the link row so subsequent mentions
 * route to the chosen Maskin workspace. If no matching workspace is found,
 * returns an ephemeral with the available options so the user can retry.
 */
export async function dispatchMaskinWorkspaceCommand(
	db: Database,
	payload: SlashCommandPayload,
): Promise<SlashCommandResult> {
	const teamId = payload.team_id
	const slackUserId = payload.user_id
	if (!teamId || !slackUserId) {
		return { responseText: 'Missing Slack team/user — command ignored.', updated: false }
	}

	const rawText = (payload.text ?? '').trim()
	const parts = rawText.split(/\s+/).filter(Boolean)
	if (parts.length === 0 || parts[0]?.toLowerCase() === 'help') {
		return {
			responseText:
				'Usage: `/maskin workspace <name>` — switch which Maskin workspace your Slack mentions route to.',
			updated: false,
		}
	}

	const subcommand = parts[0]?.toLowerCase()
	if (subcommand !== 'workspace') {
		return {
			responseText: `Unknown subcommand \`${subcommand}\`. Try \`/maskin workspace <name>\`.`,
			updated: false,
		}
	}

	const wantedName = parts.slice(1).join(' ').trim()
	if (!wantedName) {
		return {
			responseText: 'Pass the workspace name: `/maskin workspace <name>`.',
			updated: false,
		}
	}

	const existingLinkRows = await db
		.select({ actorId: slackUserLinks.actorId })
		.from(slackUserLinks)
		.where(and(eq(slackUserLinks.slackTeamId, teamId), eq(slackUserLinks.slackUserId, slackUserId)))
		.limit(1)
	const existingLink = existingLinkRows[0]
	if (!existingLink) {
		return {
			responseText:
				"You haven't linked Slack to a Maskin workspace yet — @mention `@Maskin` once first to pick one.",
			updated: false,
		}
	}

	const linkable = await resolveLinkableWorkspaces(db, teamId, existingLink.actorId)
	const wantedLower = wantedName.toLowerCase()
	const match = linkable.find((w) => w.name.toLowerCase() === wantedLower)
	if (!match) {
		const list = linkable.map((w) => `• ${w.name}`).join('\n')
		return {
			responseText: list
				? `No Maskin workspace called *${wantedName}*. You can route to:\n${list}`
				: 'No Maskin workspaces match for this Slack team.',
			updated: false,
		}
	}

	await db
		.update(slackUserLinks)
		.set({ defaultWorkspaceId: match.id, updatedAt: new Date() })
		.where(and(eq(slackUserLinks.slackTeamId, teamId), eq(slackUserLinks.slackUserId, slackUserId)))

	logger.info('Slack user link switched via /maskin workspace', {
		teamId,
		slackUserId,
		newWorkspaceId: match.id,
	})

	return {
		responseText: `Routed to *${match.name}*.`,
		updated: true,
	}
}

/**
 * Reap `slack_user_links` rows for the (team, user) pairs covered by this
 * integration so the next mention re-prompts (AC-T5). Best-effort: failures
 * are logged but never rethrown — the surrounding disconnect must always
 * succeed so a user can fix a broken state.
 *
 * Note on scope: we delete rows by Slack `team_id`, not by Maskin
 * `workspace_id`. The same team can be wired to multiple Maskin workspaces;
 * disconnecting one of them means @mentions from this team to that workspace
 * should stop routing. Other Maskin workspaces still connected to the same
 * Slack team will re-prompt the user on their next mention because they no
 * longer have a link row — exactly the rebuild path AC-T5 specifies.
 */
export async function reapSlackUserLinks(ctx: PreDisconnectContext): Promise<void> {
	const db = ctx.db as Database
	try {
		const [integration] = await db
			.select({
				id: integrations.id,
				externalId: integrations.externalId,
				workspaceId: integrations.workspaceId,
			})
			.from(integrations)
			.where(eq(integrations.id, ctx.integrationId))
			.limit(1)
		if (!integration?.externalId) {
			logger.info('preDisconnect: Slack integration has no team id; nothing to reap', {
				integrationId: ctx.integrationId,
			})
			return
		}

		const deleted = await db
			.delete(slackUserLinks)
			.where(
				and(
					eq(slackUserLinks.slackTeamId, integration.externalId),
					eq(slackUserLinks.defaultWorkspaceId, integration.workspaceId),
				),
			)
			.returning({ slackUserId: slackUserLinks.slackUserId })

		logger.info('Slack user links reaped on disconnect', {
			integrationId: ctx.integrationId,
			slackTeamId: integration.externalId,
			workspaceId: integration.workspaceId,
			reaped: deleted.length,
		})
	} catch (err) {
		logger.warn('preDisconnect: reapSlackUserLinks failed (continuing with disconnect)', {
			integrationId: ctx.integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

export const _internals = {
	BLOCK_ID_PREFIX,
	WORKSPACE_SELECT_ACTION,
	SET_DEFAULT_ACTION,
	CONFIRM_ACTION,
}
