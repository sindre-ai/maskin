import type { Database } from '@maskin/db'
import { actors, messages, workspaceMembers, workspaces } from '@maskin/db/schema'
import type { FirstStep, MessageMetadata } from '@maskin/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { isEnterprise } from '../lib/enterprise'
import { listProviders } from '../lib/integrations/registry'
import { hasConfiguredOAuthSlot, resolveChatCredentials } from '../lib/llm-routing'
import { logger } from '../lib/logger'
import type { WorkspaceSettings } from '../lib/types'
import type { IntroScanRunner } from './agent-intro-scan'
import {
	type AgentIntroInput,
	type RenderedIntro,
	renderAgentIntro,
	renderIntroFollowUp,
	renderMinimalAgentIntro,
} from './agent-intro-template'
import { findOrCreateDirectChat, postToDirectChat } from './direct-chat'
import { resolveHumanBehindSession } from './session-origin'

/** At this many intros to one person inside the last 10 minutes, the next one is skipped. */
const INTRO_CAP = 5
/** The intro names at most this many needed tools. */
const MAX_NEEDED_TOOLS = 3

type IntroStage = 'resolve' | 'dm' | 'lock' | 'find' | 'insert' | 'render' | 'scan'
type ResolvedVia = 'creator' | 'chat' | 'person_started'
type SkipReason =
	| 'no_session'
	| 'session_claim_invalid'
	| 'unattended_origin'
	| 'origin_group_chat'
	| 'rate_cap'
	| 'not_member'
	| 'exists'

/** What the creator passed on the create call to shape the intro. Nothing here is stored. */
export type IntroHints = {
	firstSteps?: FirstStep[]
	neededIntegrations?: string[]
}

export type IntroduceArgs = {
	db: Database
	actor: typeof actors.$inferSelect
	workspaceId: string
	/** actors.type of the caller: 'human' or 'agent'. */
	creator: { id: string; type: string }
	claimedSessionId: string | undefined
	clientSource: string | undefined
	hints?: IntroHints
	/**
	 * Looks around the workspace as the new agent and suggests where it can help. When
	 * given, the hello goes out at once with no buttons and a second message with the
	 * steps follows; without it the one-message intro with generic steps is posted.
	 */
	scan?: IntroScanRunner
}

/**
 * Posts the "Meet {name}" intro into a 1-1 between the new agent and the
 * person it was made for: the creator when a person made it, otherwise the
 * person behind the creating agent's session. Template only, no model call, and
 * it never wakes a session (postToDirectChat does not call evaluateAndRespond).
 *
 * Fire and forget from POST /api/actors. It never throws: a failure is logged
 * and captured as agent_intro_failed so agent creation is unaffected.
 */
export async function introduceAgentToRecipient(args: IntroduceArgs): Promise<void> {
	const { actor, creator } = args
	let stage: IntroStage = 'resolve'
	try {
		const recipient = await resolveRecipient(args)
		if (!recipient.ok) return skip(args, recipient.reason)

		if (!(await bothAreMembers(args.db, args.workspaceId, recipient.humanId, actor.id))) {
			return skip(args, 'not_member')
		}
		// The person who made the agent has a DM with it from now on, whether or not the
		// intro below is sent, skipped by the cap, or fails while it renders.
		stage = 'dm'
		await findOrCreateDirectChat(args.db, {
			workspaceId: args.workspaceId,
			humanId: recipient.humanId,
			agentId: actor.id,
			title: actor.name,
			createdBy: recipient.humanId,
		})
		if ((await introsDeliveredTo(args.db, recipient.humanId)) >= INTRO_CAP) {
			return skip(args, 'rate_cap')
		}

		stage = 'render'
		const neededTools = resolveNeededTools(args.hints?.neededIntegrations)
		const { rendered, scanPending } = await renderIntro(
			args,
			recipient.humanId,
			neededTools.names,
			args.scan !== undefined,
		)

		stage = 'lock'
		const posted = await args.db.transaction(async (tx) => {
			const chat = await findOrCreateDirectChat(tx, {
				workspaceId: args.workspaceId,
				humanId: recipient.humanId,
				agentId: actor.id,
				title: actor.name,
				createdBy: recipient.humanId,
			})
			stage = 'find'
			const [earliest] = await tx
				.select({ metadata: messages.metadata })
				.from(messages)
				.where(eq(messages.conversationId, chat.id))
				.orderBy(asc(messages.id))
				.limit(1)
			const earliestKind = (earliest?.metadata as { delivery?: { kind?: string } } | null)?.delivery
				?.kind
			if (earliestKind === 'agent_intro') return null

			stage = 'insert'
			await postToDirectChat(tx, {
				conversationId: chat.id,
				workspaceId: args.workspaceId,
				agentId: actor.id,
				content: rendered.content,
				delivery: { kind: 'agent_intro', version: 1 },
				extraMetadata: introMetadata(rendered, neededTools.providers),
			})
			return chat.id
		})
		if (!posted) return skip(args, 'exists')

		const creatorSteps = args.hints?.firstSteps?.length ?? 0
		void capturePosthogEvent('agent_intro_sent', recipient.humanId, {
			agent_id: actor.id,
			workspace_id: args.workspaceId,
			conversation_id: posted,
			variant: 'template',
			client_source: args.clientSource,
			ms_since_created: actor.createdAt ? Date.now() - actor.createdAt.getTime() : null,
			creator_actor_type: creator.type,
			creator_actor_id: creator.id,
			resolved_via: recipient.via,
			origin_hops: recipient.hops,
			steps_source: creatorSteps > 0 ? 'creator' : 'generic',
			steps_count: rendered.steps.length,
			needed_tools_count: rendered.neededToolNames.length,
			hints_dropped: neededTools.dropped,
			scan_pending: scanPending,
		})

		// The hello is out. The agent now looks around and the steps follow; this is the
		// slow part, so it runs after the capture above and never holds the hello back.
		if (scanPending && args.scan) {
			stage = 'scan'
			await postScannedFollowUp(args, args.scan, recipient.humanId, posted)
		}
	} catch (err) {
		logger.error('Agent intro failed', { agentId: actor.id, stage, err })
		void capturePosthogEvent('agent_intro_failed', creator.id, {
			agent_id: actor.id,
			workspace_id: args.workspaceId,
			stage,
		})
	}
}

/**
 * Second message of a scanned intro. Runs the scan, then posts the steps: the agent's own
 * when the scan produced any, the generic ones when it did not (no credentials, billing
 * cap, a failed or slow session, unreadable output). Skipped when the person has already
 * written in the chat: the agent is talking with them and buttons would only get in the way.
 */
async function postScannedFollowUp(
	args: IntroduceArgs,
	scan: IntroScanRunner,
	humanId: string,
	chatId: string,
): Promise<void> {
	const { db, actor, workspaceId } = args
	const startedAt = Date.now()
	const [human] = await db
		.select({ name: actors.name })
		.from(actors)
		.where(eq(actors.id, humanId))
		.limit(1)

	const result = await scan({
		workspaceId,
		agent: { id: actor.id, name: actor.name, description: actor.description },
		recipient: { id: humanId, name: human?.name ?? '' },
	}).catch((err: unknown) => {
		logger.warn('Agent intro scan threw', { agentId: actor.id, err })
		return null
	})

	const [written] = await db
		.select({ id: messages.id })
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(and(eq(messages.conversationId, chatId), eq(actors.type, 'human')))
		.limit(1)
	if (written) {
		void capturePosthogEvent('agent_intro_followup_skipped', humanId, {
			agent_id: actor.id,
			workspace_id: workspaceId,
			reason: 'person_replied',
		})
		return
	}

	const tools = resolveNeededTools([
		...(args.hints?.neededIntegrations ?? []),
		...(result?.neededIntegrations ?? []),
	])
	const rendered = renderIntroFollowUp({
		creatorSteps: args.hints?.firstSteps,
		scannedSteps: result?.steps,
		neededToolNames: tools.names,
	})
	await postToDirectChat(db, {
		conversationId: chatId,
		workspaceId,
		agentId: actor.id,
		content: rendered.content,
		delivery: { kind: 'agent_intro_steps', version: 1 },
		extraMetadata: introMetadata(rendered, tools.providers),
	})
	void capturePosthogEvent('agent_intro_followup_sent', humanId, {
		agent_id: actor.id,
		workspace_id: workspaceId,
		conversation_id: chatId,
		variant: result ? 'scanned' : 'generic_fallback',
		ms_scan: Date.now() - startedAt,
		steps_count: rendered.steps.length,
		needed_tools_count: rendered.neededToolNames.length,
	})
}

/**
 * The buttons and rows data written once with the intro, never edited. Keys are
 * left out when there is nothing to draw, so a no-key intro and the minimal
 * fallback stay plain text. The tools are provider names only: their status is
 * read live by the web.
 */
function introMetadata(
	rendered: RenderedIntro,
	providers: string[],
): Pick<MessageMetadata, 'suggested_steps' | 'needed_tools' | 'plain_tail'> {
	const metadata: Pick<MessageMetadata, 'suggested_steps' | 'needed_tools' | 'plain_tail'> = {}
	if (rendered.steps.length > 0) metadata.suggested_steps = rendered.steps
	if (rendered.neededToolNames.length > 0) {
		metadata.needed_tools = providers
			.slice(0, rendered.neededToolNames.length)
			.map((provider) => ({ provider }))
	}
	if ((metadata.suggested_steps || metadata.needed_tools) && rendered.plainTailCount > 0) {
		metadata.plain_tail = rendered.plainTailCount
	}
	return metadata
}

function skip(args: IntroduceArgs, reason: SkipReason): void {
	void capturePosthogEvent('agent_intro_skipped', args.creator.id, {
		agent_id: args.actor.id,
		workspace_id: args.workspaceId,
		reason,
		creator_actor_type: args.creator.type,
		creator_actor_id: args.creator.id,
	})
}

type Recipient =
	| { ok: true; humanId: string; via: ResolvedVia; hops: number }
	| { ok: false; reason: SkipReason }

async function resolveRecipient(args: IntroduceArgs): Promise<Recipient> {
	if (args.creator.type === 'human') {
		return { ok: true, humanId: args.creator.id, via: 'creator', hops: 0 }
	}
	const resolved = await resolveHumanBehindSession(args.db, {
		claimedSessionId: args.claimedSessionId,
		creatorId: args.creator.id,
		workspaceId: args.workspaceId,
	})
	if (!resolved.ok) return { ok: false, reason: resolved.reason }
	return { ok: true, humanId: resolved.humanId, via: resolved.via, hops: resolved.hops }
}

async function bothAreMembers(
	db: Database,
	workspaceId: string,
	humanId: string,
	agentId: string,
): Promise<boolean> {
	const rows = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				inArray(workspaceMembers.actorId, [humanId, agentId]),
			),
		)
	return new Set(rows.map((r) => r.actorId)).size === 2
}

/** Intro messages already delivered to this person in the cap window (no new table). */
async function introsDeliveredTo(db: Database, recipientId: string): Promise<number> {
	const rows = (await db.execute(sql`
		SELECT count(*)::int AS n
		FROM messages m
		JOIN conversations c ON c.id = m.conversation_id
		WHERE c.created_by = ${recipientId}
			AND c.created_at > now() - interval '10 minutes'
			AND m.metadata->'delivery'->>'kind' = 'agent_intro'
	`)) as unknown as Array<{ n: number }>
	return rows[0]?.n ?? 0
}

/**
 * The display names of the integrations the creator says the agent needs, in the
 * creator's order. A name is dropped when it is not in the catalog, or when its
 * provider has no tools an agent could use (no MCP surface: skjald, google-search-
 * console), or when it repeats. Only the first 3 are shown; every dropped or cut
 * name counts in hints_dropped. Never throws on content.
 */
function resolveNeededTools(names: string[] | undefined): {
	/** Catalog provider names, parallel to the display names. */
	providers: string[]
	names: string[]
	dropped: number
} {
	if (!names || names.length === 0) return { providers: [], names: [], dropped: 0 }
	const usable = new Map(
		listProviders()
			.filter((p) => p.config.mcp)
			.map((p) => [p.config.name, p.config.displayName] as const),
	)
	const shown: string[] = []
	const shownProviders: string[] = []
	const seen = new Set<string>()
	for (const raw of names) {
		const provider = raw.trim().toLowerCase()
		const display = usable.get(provider)
		if (!display || seen.has(provider)) continue
		seen.add(provider)
		shown.push(display)
		shownProviders.push(provider)
	}
	const kept = shown.slice(0, MAX_NEEDED_TOOLS)
	return {
		providers: shownProviders.slice(0, MAX_NEEDED_TOOLS),
		names: kept,
		dropped: names.length - kept.length,
	}
}

async function renderIntro(
	args: IntroduceArgs,
	recipientId: string,
	neededToolNames: string[],
	scanRequested: boolean,
): Promise<{ rendered: RenderedIntro; scanPending: boolean }> {
	const { db, actor, workspaceId, creator } = args
	const [recipient] = await db
		.select({ name: actors.name })
		.from(actors)
		.where(eq(actors.id, recipientId))
		.limit(1)
	let creatorName = ''
	if (creator.type !== 'human') {
		const [row] = await db
			.select({ name: actors.name })
			.from(actors)
			.where(eq(actors.id, creator.id))
			.limit(1)
		creatorName = row?.name ?? ''
	}

	const input: AgentIntroInput = {
		agentName: actor.name,
		description: actor.description,
		recipientName: recipient?.name ?? '',
		createdByAgent: creator.type !== 'human',
		creatorName,
		canRun: true,
		creatorSteps: args.hints?.firstSteps,
		neededToolNames,
	}

	try {
		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
		const llmConfig = (actor.llmConfig as Record<string, unknown> | null) ?? {}
		const credentials = resolveChatCredentials({
			wsSettings: (ws?.settings as WorkspaceSettings) ?? {},
			// Same stance as the relevance check: a workspace row we cannot read is
			// treated as entitled, which refuses Maskin's own key.
			workspace: {
				enterpriseGranted: ws ? ws.enterpriseGranted : true,
				billingOwnerId: ws?.billingOwnerId ?? null,
			},
			agent: {
				provider: actor.llmProvider,
				apiKey: (llmConfig.api_key as string | undefined) ?? null,
				model: (llmConfig.model as string | undefined)?.trim() || null,
			},
		})
		// resolveChatCredentials skips Claude OAuth on purpose (it feeds a small chat
		// heuristic), so null there does not mean the workspace cannot run an agent.
		// A BYO Claude subscription is what real sessions launch on for an entitled
		// workspace: existence only, never a token refresh or a probe.
		const hasClaudeSubscription =
			ws !== undefined &&
			isEnterprise(ws) &&
			hasConfiguredOAuthSlot((ws.settings as WorkspaceSettings)?.claude_oauth)
		input.canRun = credentials !== null || hasClaudeSubscription
		// A workspace that cannot run an agent has nothing to scan with: it gets the
		// connect-a-key hello, the same as without a scan.
		const scanPending = scanRequested && input.canRun
		input.scanPending = scanPending
		return { rendered: renderAgentIntro(input), scanPending }
	} catch (err) {
		// A failure here must not cost the person their hello: fall back to name and
		// description only.
		logger.warn('Agent intro render fell back to the minimal template', {
			agentId: actor.id,
			err,
		})
		void capturePosthogEvent('agent_intro_failed', creator.id, {
			agent_id: actor.id,
			workspace_id: workspaceId,
			stage: 'render',
		})
		return {
			rendered: {
				content: renderMinimalAgentIntro(input),
				steps: [],
				neededToolNames: [],
				plainTailCount: 0,
			},
			scanPending: false,
		}
	}
}
