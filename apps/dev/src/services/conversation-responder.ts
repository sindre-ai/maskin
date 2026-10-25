import type { Database } from '@maskin/db'
import {
	actors,
	conversationParticipants,
	conversationPendingTurns,
	messages,
	workspaces,
} from '@maskin/db/schema'
import { HUMAN_MESSAGE_STYLE_SHORT, decideWakes } from '@maskin/shared'
import { and, count, desc, eq, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import {
	type AgentRoutingOutcome,
	type GroupChatDelivery,
	type GroupChatRoutingRule,
	type GroupChatRoutingTrigger,
	type GroupChatWakeReason,
	trackGroupChatMessageRouted,
} from '../lib/analytics/group-chat-routing-events'
import { FLAGS, isFlagEnabledForWorkspace } from '../lib/feature-flags'
import { resolveChatCredentials } from '../lib/llm-routing'
import type { LLMTool } from '../lib/llm/adapter'
import { createLLMAdapter } from '../lib/llm/index'
import { logger } from '../lib/logger'
import type { WorkspaceSettings } from '../lib/types'
import { startSession } from './session-lifecycle'
import type { SessionManager } from './session-manager'

// Cap on consecutive agent-authored messages at the tail of a conversation —
// mirrors MAX_CONSECUTIVE_AGENT_REPLIES in routes/events.ts (thread-reply
// auto-spawn), same purpose: prevent runaway agent-to-agent ping-pong. Kept
// as its own constant since the two features can tune independently even
// though the value happens to match today.
const MAX_CONSECUTIVE_AGENT_REPLIES = 5
const LOOKBACK_LIMIT = 50
const HISTORY_CONTEXT_MESSAGES = 15

/**
 * Why an agent was handed a turn, as the chat prompts word it. `legacy` is today's wording for
 * an untagged wake from the model check (flag off); the other three come from an explicit tag
 * or from the wake rule (flag on).
 */
export type ConversationWakeReason =
	| 'tagged'
	| 'last_speaker'
	| 'first_message_lone_agent'
	| 'legacy'

const RESPOND_DECISION_TOOL: LLMTool = {
	name: 'decide_response',
	description: 'Decide whether to respond to the latest message in this conversation.',
	parameters: {
		type: 'object',
		properties: {
			should_respond: {
				type: 'boolean',
				description: 'Whether a reply from you specifically adds value right now.',
			},
			reason: { type: 'string', description: 'One sentence explaining the decision.' },
		},
		required: ['should_respond'],
	},
}

// Wording for the wake reasons the group-chat wake rule adds (flag on).
const LAST_SPEAKER_WAKE_TEXT =
	'This looks like a follow-up to your last reply, so it was routed to you. Reply unless it clearly was not meant for you.'
const LONE_AGENT_WAKE_TEXT = 'You are the only agent in this chat and this is its first message.'
const GROUP_HANDOFF_HINT =
	'To hand something to another agent, post with the chat tool and tag them; tagging in your final reply wakes nobody.'

/**
 * Fire-and-forget entry point called after a message is committed. For every
 * active agent participant (other than the message's own author), decides
 * whether that agent should respond — via a cheap same-process LLM call, not
 * a full container session. Agents that decide to respond reuse their
 * existing running interactive session for this conversation if one exists
 * (a stdin write via writeInput), or spawn a fresh interactive session
 * seeded with the recent conversation history otherwise — covers both the
 * first-ever reply and recovery after the previous session died (timeout,
 * crash, manual stop). Never throws; every failure mode degrades to "stay
 * silent" so a broken relevance check can't spam a conversation.
 *
 * Returns 'agent_cap' when the turn is dropped because the conversation already
 * ends in 5 agent messages in a row, so a caller that cannot afford a silent
 * drop can record it. Every other path returns nothing.
 */
export async function evaluateAndRespond(ctx: {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	conversationId: string
	messageId: number
	options?: {
		/**
		 * Skip the relevance heuristic and treat every candidate agent as
		 * responding — set by an explicit human retry, where "should I reply?"
		 * has already been answered by the user clicking the button.
		 */
		forceRespond?: boolean
		/**
		 * The message is an edit of an already-posted message — prefix the
		 * agent-facing turn so the agent knows it replaces the earlier version
		 * rather than being a brand-new message.
		 */
		isEdit?: boolean
		/**
		 * Restrict the run to this one agent — set by "Redo this response",
		 * where re-running every participant would post duplicate replies from
		 * agents whose answers the user didn't ask to regenerate.
		 */
		targetAgentId?: string
	}
}): Promise<'agent_cap' | undefined> {
	const { db, sessionManager, workspaceId, conversationId, messageId, options } = ctx
	// Read once, per workspace and with no actor, so one chat never runs two rules.
	const wakeRuleOn = isFlagEnabledForWorkspace(workspaceId, FLAGS.GROUP_CHAT_WAKE_RULE)

	const [message] = await db
		.select({
			id: messages.id,
			actorId: messages.actorId,
			content: messages.content,
			metadata: messages.metadata,
			authorName: actors.name,
			authorType: actors.type,
		})
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(eq(messages.id, messageId))
		.limit(1)
	if (!message) return undefined

	const candidates = await db
		.select({
			id: actors.id,
			name: actors.name,
			description: actors.description,
			systemPrompt: actors.systemPrompt,
			llmProvider: actors.llmProvider,
			llmConfig: actors.llmConfig,
		})
		.from(conversationParticipants)
		.innerJoin(actors, eq(actors.id, conversationParticipants.actorId))
		.where(
			and(
				eq(conversationParticipants.conversationId, conversationId),
				isNull(conversationParticipants.leftAt),
				eq(actors.type, 'agent'),
				ne(conversationParticipants.actorId, message.actorId),
				options?.targetAgentId
					? eq(conversationParticipants.actorId, options.targetAgentId)
					: undefined,
			),
		)
	if (candidates.length === 0) return undefined

	// A conversation with exactly two active participants total (the author
	// + this one agent) is a direct 1:1 — the user has nobody else to expect
	// a reply from, so the "silence is fine" framing below should be much
	// weaker than in a group chat where relevance was only inferred.
	const totalParticipantsRow = await db
		.select({ value: count() })
		.from(conversationParticipants)
		.where(
			and(
				eq(conversationParticipants.conversationId, conversationId),
				isNull(conversationParticipants.leftAt),
			),
		)
	const participantCount = totalParticipantsRow[0]?.value ?? 0
	const isDirectConversation = participantCount === 2
	const emitsRoutingEvent = participantCount >= 3
	const trigger: GroupChatRoutingTrigger = options?.isEdit
		? 'edit'
		: options?.forceRespond
			? options.targetAgentId
				? 'redo'
				: 'retry'
			: 'new_message'

	// Loop-prevention cap: walk from the most recent message back, count
	// consecutive agent-authored messages at the tail (the new message is
	// included, since it's already inserted at this point).
	//
	// Auto-posted end-of-turn output is excluded. The cap exists to bound
	// responder-triggered agent-to-agent chains, and a final_output message
	// cannot start one — the finalizer never calls evaluateAndRespond. Every
	// agent turn now yields up to two rows (an optional MCP heads-up plus the
	// automatic final output), so counting both would halve the effective cap
	// and mute a conversation after ~3 turns.
	const recent = await db
		.select({ actorType: actors.type })
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(
			and(
				eq(messages.conversationId, conversationId),
				sql`${messages.metadata}->>'source' IS DISTINCT FROM 'final_output'`,
			),
		)
		.orderBy(desc(messages.id))
		.limit(LOOKBACK_LIMIT)
	let consecutiveAgents = 0
	for (const row of recent) {
		if (row.actorType === 'agent') consecutiveAgents++
		else break
	}
	if (consecutiveAgents >= MAX_CONSECUTIVE_AGENT_REPLIES) {
		logger.info('Skipping conversation responder (consecutive agent cap reached)', {
			conversationId,
			consecutiveAgents,
		})
		if (emitsRoutingEvent) {
			emitGroupChatRouting({
				db,
				workspaceId,
				conversationId,
				message,
				participantCount,
				trigger,
				flagOn: wakeRuleOn,
				rule: wakeRuleOn ? 'agent_cap' : 'legacy',
				candidateCount: candidates.length,
				outcomes: candidates.map((a) => ({
					agentId: a.id,
					decision: 'skip' as const,
					reason: 'dropped_agent_cap' as const,
					delivery: 'none' as const,
				})),
				capHit: true,
			})
		}
		return 'agent_cap'
	}

	const metadata = message.metadata as {
		mentions?: string[]
		context_objects?: Array<{ id: string; title?: string; type?: string }>
		context_notifications?: Array<{ id: string; title?: string }>
		attachments?: Array<{ file_id: string; name?: string; mime_type?: string }>
	} | null
	const mentioned = new Set(metadata?.mentions ?? [])
	// The composer sends attached objects/notifications/files as structured
	// metadata (rendered as chips in the UI) rather than inlined into
	// `content` — rebuild a compact context block here so the agent's prompt
	// still carries it.
	const promptContent = appendContextBlock(message.content, metadata)
	const messageForPrompt = {
		...message,
		content: options?.isEdit
			? `[${message.authorName} edited an earlier message — the corrected version below replaces what they wrote before.]\n${promptContent}`
			: promptContent,
	}

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	const wsSettings = (ws?.settings as WorkspaceSettings) ?? {}
	// BYO-LLM entitlement, for resolveChatCredentials' fallback gate. Absent
	// row => treat as entitled, i.e. refuse the Maskin key: declining to spend
	// on a workspace we can't read is the safe direction, and this heuristic
	// fails open anyway.
	const wsEntitlement = {
		enterpriseGranted: ws ? ws.enterpriseGranted : true,
		billingOwnerId: ws?.billingOwnerId ?? null,
	}

	const historyRows = await db
		.select({ actorName: actors.name, content: messages.content })
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(eq(messages.conversationId, conversationId))
		.orderBy(desc(messages.id))
		.limit(HISTORY_CONTEXT_MESSAGES)
	const conversationHistory = historyRows.slice().reverse()

	// Group chat with the wake rule on: a plain rule decides, never the model. Direct chats
	// (exactly 2 participants) keep today's path whatever the flag says.
	if (wakeRuleOn && emitsRoutingEvent) {
		await routeByWakeRule({
			db,
			sessionManager,
			workspaceId,
			conversationId,
			messageId,
			message,
			messageForPrompt,
			mentions: [...mentioned],
			candidates,
			participantCount,
			trigger,
			consecutiveAgents,
			retryTargetId: options?.forceRespond ? options.targetAgentId : undefined,
			conversationHistory,
		})
		return undefined
	}

	// Recorded before delivery so a delivery that throws still reports the reason.
	const wokenReasons = new Map<string, GroupChatWakeReason>()
	const settled = await Promise.allSettled(
		candidates.map(async (agent): Promise<AgentRoutingOutcome> => {
			const wasMentioned = mentioned.has(agent.id)
			// Direct 1:1 conversations and explicit @mentions are unambiguous
			// signals to respond — skip the relevance heuristic (and its
			// narrower, non-OAuth credential resolver) entirely and let the
			// real session launch, whose resolveLlmRoute is the sole authority
			// on available credentials, be the final word.
			const relevance: { respond: boolean; reason: GroupChatWakeReason } = options?.forceRespond
				? { respond: true, reason: 'forced_retry' }
				: wasMentioned
					? { respond: true, reason: 'tagged' }
					: isDirectConversation
						? { respond: true, reason: 'direct_1to1' }
						: await checkRelevance({
								agent,
								wsSettings,
								wsEntitlement,
								conversationHistory,
								newMessageContent: messageForPrompt.content,
								isDirectConversation,
							})
			if (!relevance.respond) {
				return {
					agentId: agent.id,
					decision: 'skip',
					reason: relevance.reason,
					delivery: 'none',
				}
			}
			wokenReasons.set(agent.id, relevance.reason)
			const woke = (delivery: GroupChatDelivery): AgentRoutingOutcome => ({
				agentId: agent.id,
				decision: 'wake',
				reason: relevance.reason,
				delivery,
			})

			return woke(
				await deliverTurnToAgent({
					db,
					sessionManager,
					workspaceId,
					conversationId,
					messageId,
					agentId: agent.id,
					message: messageForPrompt,
					conversationHistory,
					isDirectConversation,
					wakeReason: wasMentioned ? 'tagged' : 'legacy',
				}),
			)
		}),
	)

	if (emitsRoutingEvent) {
		emitGroupChatRouting({
			db,
			workspaceId,
			conversationId,
			message,
			participantCount,
			trigger,
			flagOn: false,
			rule: 'legacy',
			candidateCount: candidates.length,
			outcomes: settled.map((result, i): AgentRoutingOutcome => {
				if (result.status === 'fulfilled') return result.value
				// The candidate threw: a decided wake reports nothing delivered, else it is a skip.
				const agentId = candidates[i]?.id ?? ''
				const woken = wokenReasons.get(agentId)
				return woken
					? { agentId, decision: 'wake', reason: woken, delivery: 'start_failed' }
					: { agentId, decision: 'skip', reason: 'model_no_decision', delivery: 'none' }
			}),
			capHit: false,
		})
	}
	return undefined
}

/** Fire-and-forget, never throws: its lookups and the capture can never delay a wake. */
function emitGroupChatRouting(ctx: {
	db: Database
	workspaceId: string
	conversationId: string
	message: {
		id: number
		actorId: string
		authorType: string
		metadata: unknown
	}
	participantCount: number
	trigger: GroupChatRoutingTrigger
	flagOn: boolean
	rule: GroupChatRoutingRule
	candidateCount: number
	outcomes: AgentRoutingOutcome[]
	capHit: boolean
}): void {
	const { db, message, conversationId } = ctx
	const run = async () => {
		const rawMentions = (message.metadata as { mentions?: unknown } | null)?.mentions
		const taggedActorIds = Array.isArray(rawMentions)
			? [...new Set(rawMentions.filter((m): m is string => typeof m === 'string'))]
			: []
		const taggedRows =
			taggedActorIds.length > 0
				? await db
						.select({ id: actors.id, type: actors.type })
						.from(actors)
						.where(inArray(actors.id, taggedActorIds))
				: []
		const [agentParticipants] = await db
			.select({ value: count() })
			.from(conversationParticipants)
			.innerJoin(actors, eq(actors.id, conversationParticipants.actorId))
			.where(
				and(
					eq(conversationParticipants.conversationId, conversationId),
					isNull(conversationParticipants.leftAt),
					eq(actors.type, 'agent'),
				),
			)
		const previous = await loadPreviousOther(db, conversationId, message.id, message.actorId)

		await trackGroupChatMessageRouted({
			workspaceId: ctx.workspaceId,
			conversationId,
			messageId: message.id,
			trigger: ctx.trigger,
			flagOn: ctx.flagOn,
			rule: ctx.rule,
			authorActorId: message.actorId,
			authorType: message.authorType === 'agent' ? 'agent' : 'human',
			participantCount: ctx.participantCount,
			agentParticipantCount: agentParticipants?.value ?? 0,
			candidateCount: ctx.candidateCount,
			taggedActorIds,
			taggedAgentIds: taggedRows.filter((r) => r.type === 'agent').map((r) => r.id),
			taggedHumanCount: taggedRows.filter((r) => r.type === 'human').length,
			previousOtherActorId: previous?.actorId ?? '',
			outcomes: ctx.outcomes,
			capHit: ctx.capHit,
		})
	}
	run().catch((err: unknown) =>
		logger.warn('Failed to assemble group_chat_message_routed', {
			conversationId,
			messageId: message.id,
			error: String(err),
		}),
	)
}

/** Latest real message before this one by someone other than the author (an auto-posted end-of-turn reply counts). */
async function loadPreviousOther(
	db: Database,
	conversationId: string,
	messageId: number,
	authorId: string,
): Promise<{ actorId: string; actorType: 'human' | 'agent' } | null> {
	const [previous] = await db
		.select({ actorId: messages.actorId, actorType: actors.type })
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.kind, 'message'),
				lt(messages.id, messageId),
				ne(messages.actorId, authorId),
			),
		)
		.orderBy(desc(messages.id))
		.limit(1)
	return previous
		? { actorId: previous.actorId, actorType: previous.actorType === 'agent' ? 'agent' : 'human' }
		: null
}

/** Whether the chat has no earlier real message than this one. */
async function isFirstChatMessage(
	db: Database,
	conversationId: string,
	messageId: number,
): Promise<boolean> {
	const [earlier] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.kind, 'message'),
				lt(messages.id, messageId),
			),
		)
		.limit(1)
	return !earlier
}

/**
 * Group-chat routing with the wake rule on: decideWakes says who is woken, no model is called,
 * and anything that cannot be worked out wakes nobody (skip_resolver_error, logged at error
 * level). Delivery is the same as the legacy path. Emits the routing event with flag_on true.
 */
async function routeByWakeRule(ctx: {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	conversationId: string
	messageId: number
	message: {
		id: number
		actorId: string
		authorType: string
		authorName: string
		metadata: unknown
		content: string
	}
	messageForPrompt: { actorId: string; content: string; authorName: string; authorType: string }
	mentions: string[]
	candidates: Array<{ id: string }>
	participantCount: number
	trigger: GroupChatRoutingTrigger
	consecutiveAgents: number
	retryTargetId: string | undefined
	conversationHistory: Array<{ actorName: string; content: string }>
}): Promise<void> {
	const { db, workspaceId, conversationId, messageId, message, candidates } = ctx
	const emit = (rule: GroupChatRoutingRule, outcomes: AgentRoutingOutcome[]) =>
		emitGroupChatRouting({
			db,
			workspaceId,
			conversationId,
			message,
			participantCount: ctx.participantCount,
			trigger: ctx.trigger,
			flagOn: true,
			rule,
			candidateCount: candidates.length,
			outcomes,
			capHit: false,
		})

	let decision: ReturnType<typeof decideWakes>
	try {
		const [participantRows, previousOther, isFirstMessage] = await Promise.all([
			db
				.select({ id: actors.id, type: actors.type })
				.from(conversationParticipants)
				.innerJoin(actors, eq(actors.id, conversationParticipants.actorId))
				.where(
					and(
						eq(conversationParticipants.conversationId, conversationId),
						isNull(conversationParticipants.leftAt),
					),
				),
			loadPreviousOther(db, conversationId, message.id, message.actorId),
			isFirstChatMessage(db, conversationId, message.id),
		])
		decision = decideWakes({
			author: { id: message.actorId, type: message.authorType === 'agent' ? 'agent' : 'human' },
			mentions: ctx.mentions,
			participants: participantRows.map((p) => ({
				id: p.id,
				type: p.type === 'agent' ? 'agent' : 'human',
			})),
			previousOther: previousOther
				? { authorId: previousOther.actorId, authorType: previousOther.actorType }
				: null,
			isFirstMessage,
			consecutiveAgentTail: ctx.consecutiveAgents,
			maxConsecutiveAgents: MAX_CONSECUTIVE_AGENT_REPLIES,
			retryTargetId: ctx.retryTargetId,
		})
	} catch (err) {
		logger.error('Group chat wake rule could not read its inputs — waking nobody', {
			conversationId,
			messageId,
			error: String(err),
		})
		emit(
			'resolver_error',
			candidates.map((a) => ({
				agentId: a.id,
				decision: 'skip' as const,
				reason: 'skip_resolver_error' as const,
				delivery: 'none' as const,
			})),
		)
		return
	}

	const candidateIds = new Set(candidates.map((a) => a.id))
	const mentioned = new Set(ctx.mentions)
	const wakes = decision.wakes.filter((w) => candidateIds.has(w.agentId))
	const woken = new Map(wakes.map((w) => [w.agentId, w.reason]))
	const settled = await Promise.allSettled(
		wakes.map(
			async (wake): Promise<GroupChatDelivery> =>
				deliverTurnToAgent({
					db,
					sessionManager: ctx.sessionManager,
					workspaceId,
					conversationId,
					messageId,
					agentId: wake.agentId,
					message: ctx.messageForPrompt,
					conversationHistory: ctx.conversationHistory,
					isDirectConversation: false,
					wakeReason: wakeReasonForRule(wake.reason, mentioned.has(wake.agentId)),
					groupWakeRule: true,
				}),
		),
	)
	const deliveries = new Map<string, GroupChatDelivery>(
		wakes.map((w, i) => {
			const result = settled[i]
			return [w.agentId, result?.status === 'fulfilled' ? result.value : 'start_failed']
		}),
	)

	emit(decision.rule, [
		...wakes.map(
			(w): AgentRoutingOutcome => ({
				agentId: w.agentId,
				decision: 'wake',
				reason: w.reason,
				delivery: deliveries.get(w.agentId) ?? 'start_failed',
			}),
		),
		...decision.skips
			.filter((s) => candidateIds.has(s.agentId) && !woken.has(s.agentId))
			.map(
				(s): AgentRoutingOutcome => ({
					agentId: s.agentId,
					decision: 'skip',
					reason: s.reason,
					delivery: 'none',
				}),
			),
	])
}

/** The prompt wording for a wake from the rule. A redo keeps today's wording unless the agent was tagged. */
function wakeReasonForRule(
	reason:
		| 'rule_tagged'
		| 'rule_retry_target'
		| 'rule_last_speaker'
		| 'rule_first_message_lone_agent',
	wasTagged: boolean,
): ConversationWakeReason {
	switch (reason) {
		case 'rule_tagged':
			return 'tagged'
		case 'rule_last_speaker':
			return 'last_speaker'
		case 'rule_first_message_lone_agent':
			return 'first_message_lone_agent'
		case 'rule_retry_target':
			return wasTagged ? 'tagged' : 'legacy'
	}
}

/**
 * Hands one turn to an agent in a conversation: written into its running session, buffered
 * while that session boots, or seeding a fresh session when there is none. `messageId` is
 * the chat message the turn answers; the agent's reply is anchored after it.
 *
 * Shared by the responder (a turn for a message just posted) and a chat card's approve or
 * status change, which tells the agent without posting a message (see chat-card-wake.ts).
 */
export async function deliverTurnToAgent(params: {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	conversationId: string
	messageId: number
	agentId: string
	message: { actorId: string; content: string; authorName: string; authorType: string }
	conversationHistory: Array<{ actorName: string; content: string }>
	isDirectConversation: boolean
	wakeReason: ConversationWakeReason
	/** The group-chat wake rule is on: the seed prompt explains how to hand off to another agent. */
	groupWakeRule?: boolean
}): Promise<GroupChatDelivery> {
	const {
		db,
		sessionManager,
		workspaceId,
		conversationId,
		messageId,
		agentId,
		message,
		conversationHistory,
		isDirectConversation,
		wakeReason,
		groupWakeRule,
	} = params

	const turnPayload = {
		type: 'user' as const,
		message: {
			role: 'user' as const,
			content: buildConversationTurnPrompt({
				authorName: message.authorName,
				authorType: message.authorType,
				authorActorId: message.actorId,
				newMessageContent: message.content,
				isDirectConversation,
				wakeReason,
			}),
		},
	}

	const existing = await sessionManager.findConversationSessionAnyActive(conversationId, agentId)
	if (existing && existing.status !== 'running') {
		// The agent's session is still booting (pending/starting/queued) —
		// its stdin isn't attached yet, so a writeInput would fail and a
		// second createSession would lose to sessions_conversation_actor_
		// active_uniq. Buffer the turn; drainPendingConversationTurns
		// delivers it once the session comes up.
		await bufferPendingTurn(db, {
			conversationId,
			agentId,
			messageId,
			payload: turnPayload,
		})
		// Close the race: the session may have reached `running` (and
		// already drained) between the lookup above and the buffer insert —
		// nothing would ever drain this row, so re-check and drain now.
		const nowRunning = await sessionManager.findActiveConversationSession(conversationId, agentId)
		if (nowRunning) await sessionManager.drainPendingConversationTurns(nowRunning.id)
		return 'buffered_for_booting_session'
	}
	if (existing) {
		try {
			await sessionManager.writeInput(existing.id, turnPayload, undefined, messageId)
			return 'wrote_to_running_session'
		} catch (err) {
			logger.warn(
				'writeInput to existing interactive conversation session failed — spawning a fresh one',
				{ agentId, conversationId, sessionId: existing.id, error: String(err) },
			)
			// The old session is dead (detached stdin, container gone), not
			// just momentarily busy. Mark it failed now — otherwise it keeps
			// satisfying sessions_conversation_actor_active_uniq and the
			// fresh createSession() below collides with its own zombie.
			await sessionManager
				.markSessionFailedAfterContainerLoss(existing.id, existing.workspaceId)
				.catch((markErr: unknown) =>
					logger.warn('Failed to mark dead conversation session as failed', {
						agentId,
						conversationId,
						sessionId: existing.id,
						error: String(markErr),
					}),
				)
			// Fall through to spawn fresh below.
		}
	}

	return spawnOrJoinConversationSession({
		db,
		sessionManager,
		workspaceId,
		conversationId,
		messageId,
		agentId,
		message,
		conversationHistory,
		isDirectConversation,
		wakeReason,
		groupWakeRule,
	})
}

/**
 * Spawns a fresh interactive session for (conversationId, agentId), seeded
 * with the recent conversation history as its first turn. If two replies for
 * the same agent race (both found no existing running session and both try
 * to spawn), the DB's sessions_conversation_actor_active_uniq partial unique
 * index rejects the loser's insert — on that specific failure, look up the
 * race winner's session and join it: via writeInput when it is already
 * `running`, or by buffering the turn in conversation_pending_turns when it
 * is still booting (drainPendingConversationTurns delivers it once the
 * session's stdin attaches). No reply is dropped on this path any more.
 */
async function spawnOrJoinConversationSession(params: {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	conversationId: string
	messageId: number
	agentId: string
	message: { actorId: string; content: string; authorName: string; authorType: string }
	conversationHistory: Array<{ actorName: string; content: string }>
	/** The group-chat wake rule is on: the seed prompt explains how to hand off to another agent. */
	groupWakeRule?: boolean
	isDirectConversation: boolean
	wakeReason: ConversationWakeReason
}): Promise<GroupChatDelivery> {
	const {
		db,
		sessionManager,
		workspaceId,
		conversationId,
		messageId,
		agentId,
		message,
		conversationHistory,
		isDirectConversation,
		wakeReason,
		groupWakeRule,
	} = params

	try {
		await startSession({
			workspaceId,
			actorId: agentId,
			callerKind: 'chat',
			actionPrompt: buildConversationReplyPrompt({
				conversationId,
				conversationHistory,
				newMessageContent: message.content,
				authorName: message.authorName,
				authorActorId: message.actorId,
				isDirectConversation,
				wakeReason,
				groupWakeRule,
			}),
			config: {
				interactive: true,
				conversation: { conversation_id: conversationId, message_id: messageId },
			},
			createdBy: message.actorId,
			// Chat-only spawn: the conversation_id column on the session row
			// already carries the linkage a UI needs. Explicit null/null per spec
			// §3.3 (conversation responder branch).
			initiatedFromObjectId: null,
			await: 'first-response',
		})
		// The seed prompt above inlines recent history up to and including this
		// message — any turn still buffered for this pair from a previous, dead
		// session is already covered by it. Clear those rows so the post-boot
		// drain doesn't re-deliver them as duplicates.
		try {
			await db
				.delete(conversationPendingTurns)
				.where(
					and(
						eq(conversationPendingTurns.conversationId, conversationId),
						eq(conversationPendingTurns.actorId, agentId),
						lte(conversationPendingTurns.messageId, messageId),
					),
				)
		} catch (err) {
			logger.warn('Failed to clear seed-covered pending turns', {
				agentId,
				conversationId,
				error: String(err),
			})
		}
		return 'started_new_session'
	} catch (err) {
		if (!isConversationSessionRaceViolation(err)) {
			logger.error('Failed to create conversation-responder session', {
				agentId,
				conversationId,
				error: String(err),
			})
			return 'start_failed'
		}
	}

	const turnPayload = {
		type: 'user' as const,
		message: {
			role: 'user' as const,
			content: buildConversationTurnPrompt({
				authorName: message.authorName,
				authorType: message.authorType,
				authorActorId: message.actorId,
				newMessageContent: message.content,
				isDirectConversation,
				wakeReason,
			}),
		},
	}

	const winner = await sessionManager.findConversationSessionAnyActive(conversationId, agentId)
	if (!winner) {
		// The race winner already died between rejecting our insert and this
		// lookup — vanishingly rare. The next message spawns a fresh session
		// whose seed history covers this one.
		logger.warn('Conversation session race: no winner visible — deferring to next spawn', {
			agentId,
			conversationId,
		})
		return 'start_failed'
	}
	if (winner.status !== 'running') {
		// Winner is still booting — same buffer-and-recheck as the primary path.
		await bufferPendingTurn(db, { conversationId, agentId, messageId, payload: turnPayload })
		const nowRunning = await sessionManager.findActiveConversationSession(conversationId, agentId)
		if (nowRunning) await sessionManager.drainPendingConversationTurns(nowRunning.id)
		return 'joined_race_winner'
	}
	let delivery: GroupChatDelivery = 'joined_race_winner'
	await sessionManager
		.writeInput(winner.id, turnPayload, undefined, messageId)
		.catch(async (err: unknown) => {
			// The turn never reached the winner.
			delivery = 'start_failed'
			logger.warn('Failed to join winning conversation session after race', {
				agentId,
				conversationId,
				sessionId: winner.id,
				error: String(err),
			})
			// The "winner" is itself dead (same self-heal as the primary reuse
			// path above) — mark it failed so it stops blocking the unique index
			// for the *next* message, instead of wedging the conversation until
			// the 2h timeout reaper catches it.
			await sessionManager
				.markSessionFailedAfterContainerLoss(winner.id, winner.workspaceId)
				.catch((markErr: unknown) =>
					logger.warn('Failed to mark dead race-winner conversation session as failed', {
						agentId,
						conversationId,
						sessionId: winner.id,
						error: String(markErr),
					}),
				)
		})
	return delivery
}

/**
 * Buffers one turn for a (conversation, agent) pair whose session is still
 * booting. Idempotent per (conversation, agent, message) via the table's
 * unique index — a duplicate insert (e.g. a retried message) updates the
 * payload in place so an edited message replaces its stale buffered turn.
 * Never throws: a buffering failure degrades to the pre-buffer behaviour
 * (the turn is covered by the next spawn's seed history).
 */
async function bufferPendingTurn(
	db: Database,
	params: {
		conversationId: string
		agentId: string
		messageId: number
		payload: { type: 'user'; message: { role: 'user'; content: string } }
	},
): Promise<void> {
	try {
		await db
			.insert(conversationPendingTurns)
			.values({
				conversationId: params.conversationId,
				actorId: params.agentId,
				messageId: params.messageId,
				payload: params.payload,
			})
			// Upsert, not DO NOTHING: an edit re-buffers the same
			// (conversation, agent, message) key and the newest payload —
			// the edited content — must win over the stale one.
			.onConflictDoUpdate({
				target: [
					conversationPendingTurns.conversationId,
					conversationPendingTurns.actorId,
					conversationPendingTurns.messageId,
				],
				set: { payload: params.payload },
			})
		logger.info('Buffered conversation turn while agent session boots', {
			agentId: params.agentId,
			conversationId: params.conversationId,
			messageId: params.messageId,
		})
	} catch (err) {
		logger.error('Failed to buffer conversation turn', {
			agentId: params.agentId,
			conversationId: params.conversationId,
			messageId: params.messageId,
			error: String(err),
		})
	}
}

/** Walks err.cause chain for the sessions_conversation_actor_active_uniq unique violation (23505). */
function isConversationSessionRaceViolation(err: unknown): boolean {
	for (let cur: unknown = err; cur && typeof cur === 'object'; ) {
		const e = cur as {
			code?: string
			constraint_name?: string
			constraint?: string
			message?: string
			cause?: unknown
		}
		if (e.code === '23505') {
			const name = e.constraint_name ?? e.constraint
			if (name === 'sessions_conversation_actor_active_uniq') return true
			if (
				typeof e.message === 'string' &&
				e.message.includes('sessions_conversation_actor_active_uniq')
			)
				return true
		}
		cur = e.cause
	}
	return false
}

export type RelevanceReason = Extract<
	GroupChatWakeReason,
	| 'model_yes'
	| 'model_no'
	| 'model_no_decision'
	| 'default_yes_no_credentials'
	| 'default_yes_check_error'
>

export async function checkRelevance(params: {
	agent: {
		id: string
		name: string
		description: string | null
		systemPrompt: string | null
		llmProvider: string | null
		llmConfig: unknown
	}
	wsSettings: WorkspaceSettings
	wsEntitlement: { enterpriseGranted: boolean | null; billingOwnerId: string | null }
	conversationHistory: Array<{ actorName: string; content: string }>
	newMessageContent: string
	isDirectConversation: boolean
}): Promise<{ respond: boolean; reason: RelevanceReason }> {
	const {
		agent,
		wsSettings,
		wsEntitlement,
		conversationHistory,
		newMessageContent,
		isDirectConversation,
	} = params
	const llmConfig = (agent.llmConfig as Record<string, unknown>) ?? {}
	const credentials = resolveChatCredentials({
		wsSettings,
		workspace: wsEntitlement,
		agent: {
			provider: agent.llmProvider,
			apiKey: (llmConfig.api_key as string | undefined) ?? null,
			model: (llmConfig.model as string | undefined)?.trim() || null,
		},
	})
	// No usable credential for this same-process call (e.g. this agent's only
	// route is Claude OAuth, which resolveChatCredentials intentionally can't
	// use — see its doc comment). Fail OPEN rather than silently staying
	// quiet forever: the real session launch consults the broader
	// resolveLlmRoute (which does support OAuth) and is the actual authority
	// on whether this agent can respond. Log so an operator can tell this
	// heuristic was skipped rather than deliberately declining to reply.
	if (!credentials) {
		logger.warn(
			'Conversation relevance check has no chat-callable credentials — defaulting to respond and letting session launch decide',
			{ agentId: agent.id },
		)
		return { respond: true, reason: 'default_yes_no_credentials' }
	}

	try {
		const adapter = createLLMAdapter(credentials.provider, {
			api_key: credentials.apiKey,
			base_url: credentials.baseUrl,
			extra_body: credentials.providerPrefs && { provider: credentials.providerPrefs },
		})
		const transcript = formatConversationTranscript(conversationHistory)
		const response = await adapter.chat({
			model: credentials.model,
			temperature: 0,
			tools: [RESPOND_DECISION_TOOL],
			messages: [
				{
					role: 'system',
					content: [
						`You are ${agent.name}${agent.description ? `, ${agent.description}` : ''}.`,
						agent.systemPrompt ?? '',
						isDirectConversation
							? "This is a direct 1:1 chat between you and the user — there's no one else who could reply instead. A new message just arrived. Decide whether it warrants a reply from you. Default to responding; only decide against it if the message clearly needs no response (e.g. a plain acknowledgment). Call decide_response with your answer."
							: 'You are one of several participants in a group chat. A new message just arrived. Decide whether YOU specifically should reply — not whether someone could reply. Stay silent when the message is directed at someone else, already answered, small talk between humans, or you have nothing useful to add. Call decide_response with your answer.',
					]
						.filter(Boolean)
						.join('\n\n'),
				},
				{
					role: 'user',
					content: `Recent conversation:\n${transcript || '(no prior messages)'}\n\nNew message:\n${newMessageContent}`,
				},
			],
		})
		const call = response.tool_calls.find((tc) => tc.name === 'decide_response')
		if (!call) return { respond: false, reason: 'model_no_decision' }
		return call.arguments.should_respond === true
			? { respond: true, reason: 'model_yes' }
			: { respond: false, reason: 'model_no' }
	} catch (err) {
		// Every throw in the block above is a call/infra failure (network error,
		// non-2xx HTTP, malformed response) — the model's actual "no, don't
		// reply" decision is returned via tool_calls above, not an exception.
		// So this catch never represents a legitimate decline; failing closed
		// here would indistinguishably conflate "the model declined" with "a
		// credential expired" or "the provider is down" — exactly the silent,
		// permanent-silence bug this heuristic exists to avoid. Fail OPEN, same
		// as the no-credentials branch above, and use logger.error (not warn)
		// so a systemic outage actually creates a Sentry issue instead of a
		// breadcrumb nobody sees.
		logger.error(
			'Conversation relevance check call failed — defaulting to respond and letting session launch decide',
			{ agentId: agent.id, error: String(err) },
		)
		return { respond: true, reason: 'default_yes_check_error' }
	}
}

/**
 * Rebuilds the compact "Context objects:" / "Context notifications:" /
 * "Attached files:" block the composer used to inline directly into message
 * content — now that the composer sends this as structured metadata (so the
 * UI can render chips instead of literal text), the agent-facing prompt has
 * to reconstruct it. Attached files are listed by id + name only; the agent
 * has to call the `get_file` MCP tool to actually read the content.
 */
function appendContextBlock(
	content: string,
	metadata: {
		context_objects?: Array<{ id: string; title?: string; type?: string }>
		context_notifications?: Array<{ id: string; title?: string }>
		attachments?: Array<{ file_id: string; name?: string; mime_type?: string }>
	} | null,
): string {
	const objects = metadata?.context_objects ?? []
	const notifications = metadata?.context_notifications ?? []
	const attachments = metadata?.attachments ?? []
	if (objects.length === 0 && notifications.length === 0 && attachments.length === 0) return content
	const lines: string[] = [content, '', '---']
	if (objects.length > 0) {
		lines.push('Context objects:')
		for (const o of objects) {
			const label = o.title?.trim() || o.id
			const typeTag = o.type ? ` (${o.type})` : ''
			lines.push(`- ${label}${typeTag} — id: ${o.id}`)
		}
	}
	if (notifications.length > 0) {
		if (objects.length > 0) lines.push('')
		lines.push('Context notifications:')
		for (const n of notifications) {
			const label = n.title?.trim() || n.id
			lines.push(`- ${label} — id: ${n.id}`)
		}
	}
	if (attachments.length > 0) {
		if (objects.length > 0 || notifications.length > 0) lines.push('')
		lines.push('Attached files (call the get_file MCP tool with the file id to read the content):')
		for (const f of attachments) {
			const label = f.name?.trim() || f.file_id
			const mimeTag = f.mime_type ? ` (${f.mime_type})` : ''
			lines.push(`- ${label}${mimeTag} — file id: ${f.file_id}`)
		}
	}
	return lines.join('\n')
}

/** Shared `{actorName}: {content}` transcript join, used by the relevance check, the seed prompt, and the auto-titler. */
export function formatConversationTranscript(
	history: Array<{ actorName: string; content: string }>,
): string {
	return history.map((m) => `${m.actorName}: ${m.content}`).join('\n')
}

/**
 * Builds the seed prompt for a freshly-spawned interactive conversation
 * session — sent as the first stdin turn (see launchContainer in
 * session-manager.ts). Unlike the old one-shot prompt, history is inlined
 * directly rather than telling the agent to go fetch it via MCP tools, since
 * this only runs once per session (not once per reply).
 */
function buildConversationReplyPrompt(ctx: {
	conversationId: string
	conversationHistory: Array<{ actorName: string; content: string }>
	newMessageContent: string
	authorName: string
	authorActorId: string
	isDirectConversation: boolean
	wakeReason: ConversationWakeReason
	groupWakeRule?: boolean
}): string {
	return [
		'A new message was posted in a conversation you are a participant in. This session stays open for the rest of this conversation — later messages will arrive as further turns, not new prompts.',
		'',
		'Recent conversation history (oldest first):',
		'"""',
		formatConversationTranscript(ctx.conversationHistory) || '(no prior messages)',
		'"""',
		'',
		`Your reply is whatever you write at the end of this turn — it is posted into the chat automatically, so finish with the actual response to them. ${HUMAN_MESSAGE_STYLE_SHORT} ${describeReplyExpectation(ctx)}`,
		"If this turn will take a while before you can answer — research, a long tool chain, work across several files — you may post a brief heads-up first with post_conversation_message so they aren't left waiting in silence. That's optional, and worth skipping when the message just wants a direct answer. Both the heads-up and your final reply appear in the chat, so don't repeat yourself.",
		...(ctx.groupWakeRule && !ctx.isDirectConversation ? [GROUP_HANDOFF_HINT] : []),
		'',
		`Conversation ID: ${ctx.conversationId}`,
		`Author of the new message: ${ctx.authorName} (actor ID: ${ctx.authorActorId})`,
		'New message content:',
		'"""',
		ctx.newMessageContent,
		'"""',
	].join('\n')
}

/**
 * Calibrates how strongly the seed/turn prompt should push toward an actual
 * reply. Silence is always technically available, but it means something
 * different depending on context: in a 1:1 with the user, or when directly
 * @mentioned, there's no one else to answer — silence reads as being ignored,
 * not as "someone else has it." In a group chat where relevance was only
 * inferred, silence is a normal, frequent outcome.
 */
function describeReplyExpectation(ctx: {
	isDirectConversation: boolean
	wakeReason: ConversationWakeReason
}): string {
	if (ctx.isDirectConversation) {
		return "This conversation is just you and the user — there's no one else for them to hear back from, so they are expecting a reply from you. Only stay silent if the message truly needs no response (e.g. a plain 'thanks')."
	}
	if (ctx.wakeReason === 'tagged') {
		return 'The user @mentioned you directly, which is an explicit, unambiguous request for your reply — silence here reads as being ignored. Reply unless you have a clear reason not to.'
	}
	if (ctx.wakeReason === 'last_speaker') return LAST_SPEAKER_WAKE_TEXT
	if (ctx.wakeReason === 'first_message_lone_agent') return LONE_AGENT_WAKE_TEXT
	return "This message wasn't addressed to you directly, but it touched on something within your area, so it was routed to you as plausibly worth a response — lean toward replying. Doing nothing is still valid if, on reflection, a response from you doesn't actually add anything — but don't default to silence just because it's an option."
}

/**
 * Builds a follow-up turn for an already-running interactive session.
 * Deliberately minimal — the live CLI process already has every prior turn
 * in its own context, this only needs to carry the new message and who sent
 * it (a multi-party room isn't guaranteed to have the same sender turn after
 * turn). Tags fellow-agent authors explicitly: without it, a peer agent's
 * reply reads as indistinguishable from the human's, and the model infers
 * "someone already answered" from mere proximity in the transcript — even
 * when that peer's message is itself a question waiting on the human.
 *
 * Carries the sender's stable actor ID alongside their display name so the
 * receiving agent can attribute the message reliably — names collide, change,
 * and don't distinguish a human from an agent. The fresh-session seed prompt
 * (buildConversationReplyPrompt) already does this.
 */
function buildConversationTurnPrompt(ctx: {
	authorName: string
	authorType: string
	authorActorId: string
	newMessageContent: string
	isDirectConversation: boolean
	wakeReason: ConversationWakeReason
}): string {
	const speaker =
		ctx.authorType === 'agent'
			? `${ctx.authorName} (fellow agent, not the user — their reply doesn't mean the user's message has been handled; actor ID: ${ctx.authorActorId})`
			: `${ctx.authorName} (actor ID: ${ctx.authorActorId})`
	const reminder = ctx.isDirectConversation
		? " (it's just the two of you here — they're expecting a reply)"
		: ctx.wakeReason === 'tagged'
			? ' (they @mentioned you directly — expecting a reply)'
			: ctx.wakeReason === 'last_speaker'
				? ` (${LAST_SPEAKER_WAKE_TEXT})`
				: ctx.wakeReason === 'first_message_lone_agent'
					? ` (${LONE_AGENT_WAKE_TEXT})`
					: ''
	return `${speaker}: ${ctx.newMessageContent}${reminder}`
}
