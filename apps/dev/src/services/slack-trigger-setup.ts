import type { Database } from '@maskin/db'
import { events, integrations, triggers } from '@maskin/db/schema'
import type { SlackSetupJoinAttempt, SlackSetupMetadata } from '@maskin/shared'
import { buildWebAppHref, resolveWebAppBaseUrl } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { decrypt } from '../lib/crypto'
import {
	type SlackJoinResult,
	joinSlackChannel,
	listSlackConversations,
	slackPost,
} from '../lib/integrations/providers/slack/client'
import { isSlackBotToken } from '../lib/integrations/providers/slack/mcp-server'
import type { StoredCredentials } from '../lib/integrations/types'
import { logger } from '../lib/logger'
import {
	claimSlackConfirmation,
	setSlackSetupPreservingConfirmations,
	slackConfirmationUnclaimed,
} from '../lib/trigger-metadata'

// Statuses we persist per-channel in `slack_setup.join_attempts[*].status`.
// Kept in-sync with `slackSetupJoinStatusSchema` in @maskin/shared.
type JoinStatus = SlackSetupJoinAttempt['status']

interface SlackTriggerSetupInput {
	triggerId: string
	workspaceId: string
	channelIds: string[]
	triggerName: string
	actorId: string
}

/**
 * Post-commit fire-and-forget service that runs the Slack setup steps for a
 * newly created / updated trigger (spec §2, §4):
 *   1. Look up the workspace's Slack integration + bot token.
 *   2. For each channel: skip private channels (Slack refuses join), join the
 *      rest via `conversations.join`. Classify outcomes per spec §3.
 *   3. For every successfully joined / already-in channel that has not been
 *      confirmed yet, post the `Maskin is now listening here…` attachment
 *      card via `chat.postMessage` (spec §4, Strategist lock decision 2/4).
 *   4. Persist outcomes to `triggers.metadata.slack_setup`. Never throws to
 *      the caller — a setup failure must not roll back the trigger row.
 *
 * Called from `POST /api/triggers` and `PATCH /api/triggers/:id` post-commit.
 * The trigger response goes out immediately; the frontend polls / refetches
 * to render the results.
 */
export async function runSlackTriggerSetup(
	db: Database,
	input: SlackTriggerSetupInput,
): Promise<void> {
	try {
		await runSlackTriggerSetupInner(db, input)
	} catch (err) {
		// Absolute guarantee: setup failure ≠ save failure. The trigger row is
		// already committed. Log and move on so the fire-and-forget path can't
		// crash the process.
		logger.error('runSlackTriggerSetup crashed', {
			triggerId: input.triggerId,
			workspaceId: input.workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

async function runSlackTriggerSetupInner(
	db: Database,
	{ triggerId, workspaceId, channelIds, triggerName, actorId }: SlackTriggerSetupInput,
): Promise<void> {
	if (channelIds.length === 0) {
		// Nothing to do — clear stale outcomes so the banner stops showing them.
		await persistSetupResult(
			db,
			{ triggerId, workspaceId, actorId },
			{
				channel_ids: [],
				join_attempts: [],
				last_setup_at: new Date().toISOString(),
			},
		)
		return
	}

	const resolved = await resolveSlackContext(db, workspaceId)
	if (!resolved) {
		// No active bot-token integration — record `not_authed` for every channel
		// so the banner explains the reconnect step, rather than staying silent.
		const attempts = channelIds.map(
			(channel_id): SlackSetupJoinAttempt => ({
				channel_id,
				status: 'not_authed',
				attempted_at: new Date().toISOString(),
			}),
		)
		for (const a of attempts) {
			void capturePosthogEvent('slack.auto_join.attempted', workspaceId, {
				workspace_id: workspaceId,
				slack_team_id: null,
				channel_id: a.channel_id,
				is_private: null,
				outcome: 'not_authed',
				error_code: 'not_authed',
				trigger_id: triggerId,
				actor_id: actorId,
			})
		}
		await persistSetupResult(
			db,
			{ triggerId, workspaceId, actorId },
			{
				channel_ids: channelIds,
				join_attempts: attempts,
				last_setup_at: new Date().toISOString(),
			},
		)
		return
	}
	const { botToken, integrationId, slackTeamId } = resolved

	// Note: nothing is loaded up-front to decide whether to post a confirmation.
	// The dedupe is a claim made atomically at post time (see `claimConfirmation`
	// below) — a snapshot read here would be stale by the time the loop reaches
	// the channel, several Slack round-trips later.

	// Resolve which channel ids are private — a private channel picker pick must
	// skip the join API call and land as 'not_public' (spec §2/§3).
	const conversations = await safeListConversations(integrationId, botToken)
	const privacyById = new Map<string, boolean>()
	for (const c of conversations) privacyById.set(c.id, c.is_private)

	const attempts: SlackSetupJoinAttempt[] = []

	for (const channelId of channelIds) {
		const isPrivate = privacyById.get(channelId) ?? false

		let status: JoinStatus
		let errorCode: string | undefined

		if (isPrivate) {
			status = 'not_public'
		} else {
			// Always call `conversations.join`, even when the last run recorded a
			// success. The call is idempotent (`already_in_channel` instead of an
			// error), which is precisely why caching the previous status is the
			// wrong trade: after the bot is kicked and the user hits Resume, a
			// cached 'joined' would skip the Slack round-trip and re-persist
			// 'already_in' — leaving the trigger green while the bot is still out
			// of the channel and the trigger can never fire. Re-posting the
			// confirmation is separately deduped on `confirmation_posted_at`.
			try {
				const result = await joinSlackChannel(botToken, channelId)
				status = classifyJoinResult(result)
				if (!result.ok) errorCode = result.error
			} catch (err) {
				// Belt-and-braces: `joinSlackChannel` is contractually no-throw, but
				// one channel must never cost the whole run. Without this, an
				// unexpected throw skips `persistSetupResult` entirely — dropping
				// the `confirmation_posted_at` entries for channels already handled
				// this pass, so the next save re-posts "Maskin is now listening
				// here" into a customer channel.
				status = 'error'
				errorCode = err instanceof Error ? err.message : String(err)
				logger.warn('Slack join threw unexpectedly', {
					triggerId,
					channelId,
					error: errorCode,
				})
			}
		}

		attempts.push({
			channel_id: channelId,
			status,
			error: errorCode,
			attempted_at: new Date().toISOString(),
		})

		void capturePosthogEvent('slack.auto_join.attempted', workspaceId, {
			workspace_id: workspaceId,
			slack_team_id: slackTeamId ?? null,
			channel_id: channelId,
			is_private: isPrivate,
			outcome: status,
			error_code: errorCode ?? null,
			trigger_id: triggerId,
			actor_id: actorId,
		})

		// Fire the confirmation only for a fresh successful join or a first-time
		// verification of a channel the bot was already in.
		//
		// The claim is taken BEFORE the post and in a single SQL statement, so
		// two overlapping saves of the same trigger cannot both decide the
		// channel is unconfirmed and both announce into it. Claiming first also
		// means a crash between claim and post costs a missing announcement
		// rather than a duplicate one — the safer direction to fail in, since
		// the duplicate lands in a customer's channel.
		if (status === 'joined' || status === 'already_in') {
			const claimed = await claimConfirmation(db, triggerId, channelId)
			if (claimed) {
				const posted = await postConfirmation({
					botToken,
					channelId,
					triggerId,
					triggerName,
					workspaceId,
					slackTeamId,
					actorId,
				})
				if (!posted) {
					// Release the claim so a later save retries the announcement.
					// Losing this release (process death) is the one case that can
					// permanently skip a confirmation; a duplicate post is worse.
					await releaseConfirmationClaim(db, triggerId, channelId)
				}
			}
		}
	}

	// `confirmation_posted_at` is deliberately not passed here — it is owned by
	// the atomic claims above, and `persistSetupResult` unions whatever is
	// stored rather than overwriting it.
	await persistSetupResult(
		db,
		{ triggerId, workspaceId, actorId },
		{
			channel_ids: channelIds,
			join_attempts: attempts,
			last_setup_at: new Date().toISOString(),
		},
	)
}

// ── Slack API result → persisted status ──────────────────────────────────

function classifyJoinResult(result: SlackJoinResult): JoinStatus {
	if (result.ok) return result.already_in ? 'already_in' : 'joined'
	switch (result.error) {
		case 'is_private':
		case 'method_not_supported_for_channel_type':
			return 'not_public'
		case 'not_authed':
		case 'invalid_auth':
		case 'token_revoked':
		case 'account_inactive':
			return 'not_authed'
		case 'channel_not_found':
			return 'channel_not_found'
		case 'restricted_action':
		case 'org_login_required':
			return 'restricted_action'
		default:
			return 'error'
	}
}

// ── Confirmation-in-channel post (spec §4) ───────────────────────────────

interface ConfirmationInput {
	botToken: string
	channelId: string
	triggerId: string
	triggerName: string
	workspaceId: string
	slackTeamId: string | undefined
	actorId: string
}

async function postConfirmation({
	botToken,
	channelId,
	triggerId,
	triggerName,
	workspaceId,
	slackTeamId,
	actorId,
}: ConfirmationInput): Promise<boolean> {
	// Strategist lock decision 2 — exact copy. Do NOT edit without a design pass.
	const text = `Maskin is now listening here for "${triggerName}" — @-mention me or reply to fire.`

	// Product Designer PR #1477 SPEC.md chose an attachment card with two
	// buttons. Uses Slack's `attachments`+`blocks` combo so the coloured left
	// border reads as "this is a status card, not a normal Maskin post".
	const baseUrl = resolveWebAppBaseUrl(process.env)
	const triggerUrl = buildWebAppHref(baseUrl, workspaceId, { kind: 'trigger', id: triggerId })

	try {
		await slackPost('chat.postMessage', botToken, {
			channel: channelId,
			text,
			username: 'Maskin',
			// System message — no `agentLabel` context block (spec §4). The
			// attachment carries the CTA buttons; the plain-text `text` above is
			// the fallback for notifications and mobile previews.
			attachments: [
				{
					color: '#2563eb',
					fallback: text,
					blocks: [
						{ type: 'section', text: { type: 'mrkdwn', text } },
						{
							type: 'actions',
							elements: [
								{
									type: 'button',
									text: { type: 'plain_text', text: 'View trigger' },
									url: triggerUrl,
									action_id: 'slack_setup.view_trigger',
									value: triggerId,
								},
								{
									type: 'button',
									text: { type: 'plain_text', text: 'Pause' },
									// Pause resolves at the trigger detail page (the Enabled/Disabled
									// chip lives there). Interactive-endpoint-driven pause is
									// tracked as a follow-up — deep-linking keeps this PR small
									// and there is no listening-side pause action handler yet.
									url: triggerUrl,
									action_id: 'slack_setup.pause_trigger',
									value: triggerId,
									style: 'danger',
								},
							],
						},
					],
				},
			],
		})
		void capturePosthogEvent('slack.message.posted', workspaceId, {
			workspace_id: workspaceId,
			slack_team_id: slackTeamId ?? null,
			posted_as_machine: isSlackBotToken(botToken),
			has_agent_subscript: false,
			agent_actor_id: actorId,
			// Extension per Product Validator ask (spec §4/§9) — lets the setup
			// funnel be distinguished from FDE traffic in the same `slack.message.posted`
			// event.
			confirmation_type: 'trigger_setup',
			trigger_id: triggerId,
		})
		return true
	} catch (err) {
		logger.warn('Slack confirmation post failed', {
			workspaceId,
			channelId,
			triggerId,
			error: err instanceof Error ? err.message : String(err),
		})
		return false
	}
}

// ── DB access helpers ────────────────────────────────────────────────────

interface ResolvedSlackContext {
	botToken: string
	integrationId: string
	slackTeamId: string | undefined
}

async function resolveSlackContext(
	db: Database,
	workspaceId: string,
): Promise<ResolvedSlackContext | null> {
	const [integration] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, 'slack'),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	if (!integration) return null

	let credentials: StoredCredentials
	try {
		credentials = JSON.parse(decrypt(integration.credentials as string)) as StoredCredentials
	} catch (err) {
		logger.error('runSlackTriggerSetup could not decrypt Slack credentials', {
			workspaceId,
			integrationId: integration.id,
			error: String(err),
		})
		return null
	}
	const token = credentials.accessToken
	if (!isSlackBotToken(token)) return null
	return {
		botToken: token as string,
		integrationId: integration.id,
		slackTeamId: integration.externalId ?? undefined,
	}
}

interface SetupAuditContext {
	triggerId: string
	workspaceId: string
	actorId: string
}

/**
 * Claim the right to announce in `channelId`, atomically.
 *
 * Returns true only if this call is the one that wrote the timestamp. The
 * guard and the write are one statement, so of two concurrent runs exactly one
 * sees an unclaimed channel.
 */
async function claimConfirmation(
	db: Database,
	triggerId: string,
	channelId: string,
): Promise<boolean> {
	try {
		const claimed = await db
			.update(triggers)
			.set({ metadata: claimSlackConfirmation(channelId, new Date().toISOString()) })
			.where(and(eq(triggers.id, triggerId), slackConfirmationUnclaimed(channelId)))
			.returning({ id: triggers.id })
		return claimed.length > 0
	} catch (err) {
		// Failing closed (no post) beats failing open (a possible duplicate post
		// into someone's channel). The next save retries.
		logger.warn('Slack confirmation claim failed', {
			triggerId,
			channelId,
			error: err instanceof Error ? err.message : String(err),
		})
		return false
	}
}

/** Undo a claim whose `chat.postMessage` did not land, so a later save retries. */
async function releaseConfirmationClaim(
	db: Database,
	triggerId: string,
	channelId: string,
): Promise<void> {
	try {
		await db
			.update(triggers)
			.set({
				metadata: sql`jsonb_set(coalesce(${triggers.metadata}, '{}'::jsonb), '{slack_setup,confirmation_posted_at}', coalesce(${triggers.metadata} -> 'slack_setup' -> 'confirmation_posted_at', '{}'::jsonb) - ${channelId}::text)`,
			})
			.where(eq(triggers.id, triggerId))
	} catch (err) {
		logger.warn('Slack confirmation claim release failed', {
			triggerId,
			channelId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

async function persistSetupResult(
	db: Database,
	{ triggerId, workspaceId, actorId }: SetupAuditContext,
	slack_setup: Omit<SlackSetupMetadata, 'confirmation_posted_at'>,
): Promise<void> {
	// Single-statement jsonb merge — see `lib/trigger-metadata.ts`. A JS-side
	// read-modify-write here would clobber a `metadata.auto_paused` stamped by
	// `handleMemberLeftChannel` between the read and the write, silently
	// disabling the trigger with no banner explaining why.
	const updated = await db
		.update(triggers)
		.set({ metadata: setSlackSetupPreservingConfirmations(slack_setup) })
		.where(eq(triggers.id, triggerId))
		.returning({ id: triggers.id })

	if (updated.length === 0) {
		// The trigger was deleted between the route's commit and this write.
		// Nothing to audit, and no events row should claim otherwise.
		logger.warn('Slack setup result not persisted — trigger row is gone', {
			triggerId,
			workspaceId,
		})
		return
	}

	// Audit + real-time. This is the only thing that tells the open trigger
	// form the setup finished: the save response was sent before any of this
	// ran, and `sse-invalidation` refetches triggers on an `events` row with
	// `entityType: 'trigger'`. Without it a failed join sits in the column
	// unread until the user navigates away and back.
	try {
		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'trigger',
			entityId: triggerId,
			// Statuses only — no channel ids or Slack error strings. The events
			// NOTIFY trigger has an 8KB payload ceiling and a trigger can carry
			// many channels; the full record is on the row the client refetches.
			data: {
				slack_setup: {
					outcomes: slack_setup.join_attempts.map((a) => a.status),
					last_setup_at: slack_setup.last_setup_at,
				},
			},
		})
	} catch (err) {
		// An audit failure must not undo the setup work already done.
		logger.warn('Slack setup events insert failed', {
			triggerId,
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

async function safeListConversations(integrationId: string, botToken: string) {
	try {
		// Cached in-process for 5 min per integration; the picker warms it, and
		// this call typically hits the cache.
		return await listSlackConversations(integrationId, botToken)
	} catch (err) {
		logger.warn('runSlackTriggerSetup failed to list conversations for privacy check', {
			integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
		return []
	}
}

/**
 * Extract the channel ids the trigger listens on from `config.conditions`.
 * Called from the trigger route to build the setup service's input list —
 * finds every `field='event.channel'` or `field='event.item.channel'`
 * condition with `operator='in'` and returns the union of its values.
 * Non-Slack triggers return an empty list, which short-circuits the service.
 */
export function extractSlackChannelIds(config: Record<string, unknown> | null): string[] {
	if (!config) return []
	const conditions = (config.conditions as Array<Record<string, unknown>> | undefined) ?? []
	const out: string[] = []
	for (const c of conditions) {
		const field = c.field
		const operator = c.operator
		if (operator !== 'in') continue
		if (field !== 'event.channel' && field !== 'event.item.channel') continue
		if (!Array.isArray(c.value)) continue
		for (const v of c.value) if (typeof v === 'string') out.push(v)
	}
	// Dedup while preserving order — same picker can send the field twice under
	// the two entity-type paths (`event.channel` vs `event.item.channel`).
	return Array.from(new Set(out))
}
