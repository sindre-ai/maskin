import type { Database } from '@maskin/db'
import { actors, conversationParticipants, messages, workspaces } from '@maskin/db/schema'
import { and, count, desc, eq, isNull, ne } from 'drizzle-orm'
import { resolveChatCredentials } from '../lib/llm-routing'
import type { LLMTool } from '../lib/llm/adapter'
import { createLLMAdapter } from '../lib/llm/index'
import { logger } from '../lib/logger'
import type { WorkspaceSettings } from '../lib/types'
import type { SessionManager } from './session-manager'

// Cap on consecutive agent-authored messages at the tail of a conversation —
// mirrors MAX_CONSECUTIVE_AGENT_REPLIES in routes/events.ts (thread-reply
// auto-spawn), same purpose: prevent runaway agent-to-agent ping-pong. Kept
// as its own constant since the two features can tune independently even
// though the value happens to match today.
const MAX_CONSECUTIVE_AGENT_REPLIES = 5
const LOOKBACK_LIMIT = 50
const HISTORY_CONTEXT_MESSAGES = 15

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
 */
export async function evaluateAndRespond(ctx: {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	conversationId: string
	messageId: number
}): Promise<void> {
	const { db, sessionManager, workspaceId, conversationId, messageId } = ctx

	const [message] = await db
		.select({
			id: messages.id,
			actorId: messages.actorId,
			content: messages.content,
			metadata: messages.metadata,
			authorName: actors.name,
		})
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(eq(messages.id, messageId))
		.limit(1)
	if (!message) return

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
			),
		)
	if (candidates.length === 0) return

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
	const isDirectConversation = (totalParticipantsRow[0]?.value ?? 0) === 2

	// Loop-prevention cap: walk from the most recent message back, count
	// consecutive agent-authored messages at the tail (the new message is
	// included, since it's already inserted at this point).
	const recent = await db
		.select({ actorType: actors.type })
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(eq(messages.conversationId, conversationId))
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
		return
	}

	const metadata = message.metadata as { mentions?: string[] } | null
	const mentioned = new Set(metadata?.mentions ?? [])

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	const wsSettings = (ws?.settings as WorkspaceSettings) ?? {}

	const historyRows = await db
		.select({ actorName: actors.name, content: messages.content })
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(eq(messages.conversationId, conversationId))
		.orderBy(desc(messages.id))
		.limit(HISTORY_CONTEXT_MESSAGES)
	const conversationHistory = historyRows.slice().reverse()

	await Promise.allSettled(
		candidates.map(async (agent) => {
			const wasMentioned = mentioned.has(agent.id)
			// @mention fast-path — skip the relevance check entirely, an
			// explicit @mention is already an unambiguous signal to respond.
			const shouldRespond = wasMentioned
				? true
				: await checkRelevance({
						agent,
						wsSettings,
						conversationHistory,
						newMessageContent: message.content,
						isDirectConversation,
					})
			if (!shouldRespond) return

			const existing = await sessionManager.findActiveConversationSession(conversationId, agent.id)
			if (existing) {
				try {
					await sessionManager.writeInput(existing.id, {
						type: 'user',
						message: {
							role: 'user',
							content: buildConversationTurnPrompt({
								authorName: message.authorName,
								newMessageContent: message.content,
								isDirectConversation,
								wasMentioned,
							}),
						},
					})
					return
				} catch (err) {
					logger.warn(
						'writeInput to existing interactive conversation session failed — spawning a fresh one',
						{ agentId: agent.id, conversationId, sessionId: existing.id, error: String(err) },
					)
					// Fall through to spawn fresh below — the old session is dead
					// (detached stdin, container gone), not just momentarily busy.
				}
			}

			await spawnOrJoinConversationSession({
				sessionManager,
				workspaceId,
				conversationId,
				messageId,
				agentId: agent.id,
				message,
				conversationHistory,
				isDirectConversation,
				wasMentioned,
			})
		}),
	)
}

/**
 * Spawns a fresh interactive session for (conversationId, agentId), seeded
 * with the recent conversation history as its first turn. If two replies for
 * the same agent race (both found no existing running session and both try
 * to spawn), the DB's sessions_conversation_actor_active_uniq partial unique
 * index rejects the loser's insert — on that specific failure, look up the
 * race winner's session and join it via writeInput instead of dropping the
 * reply. A single lookup attempt, not a retry loop: if the winner's session
 * isn't visible as `running` yet (still starting), this reply is dropped —
 * an acceptable, rare failure mode rather than blocking on an open-ended
 * poll.
 */
async function spawnOrJoinConversationSession(params: {
	sessionManager: SessionManager
	workspaceId: string
	conversationId: string
	messageId: number
	agentId: string
	message: { actorId: string; content: string; authorName: string }
	conversationHistory: Array<{ actorName: string; content: string }>
	isDirectConversation: boolean
	wasMentioned: boolean
}): Promise<void> {
	const {
		sessionManager,
		workspaceId,
		conversationId,
		messageId,
		agentId,
		message,
		conversationHistory,
		isDirectConversation,
		wasMentioned,
	} = params

	try {
		await sessionManager.createSession(workspaceId, {
			actorId: agentId,
			actionPrompt: buildConversationReplyPrompt({
				conversationId,
				conversationHistory,
				newMessageContent: message.content,
				authorName: message.authorName,
				authorActorId: message.actorId,
				isDirectConversation,
				wasMentioned,
			}),
			config: {
				interactive: true,
				conversation: { conversation_id: conversationId, message_id: messageId },
			},
			createdBy: message.actorId,
		})
		return
	} catch (err) {
		if (!isConversationSessionRaceViolation(err)) {
			logger.error('Failed to create conversation-responder session', {
				agentId,
				conversationId,
				error: String(err),
			})
			return
		}
	}

	const winner = await sessionManager.findActiveConversationSession(conversationId, agentId)
	if (!winner) {
		logger.warn('Conversation session race: no winner visible yet — dropping this reply', {
			agentId,
			conversationId,
		})
		return
	}
	await sessionManager
		.writeInput(winner.id, {
			type: 'user',
			message: {
				role: 'user',
				content: buildConversationTurnPrompt({
					authorName: message.authorName,
					newMessageContent: message.content,
					isDirectConversation,
					wasMentioned,
				}),
			},
		})
		.catch((err: unknown) =>
			logger.warn('Failed to join winning conversation session after race', {
				agentId,
				conversationId,
				sessionId: winner.id,
				error: String(err),
			}),
		)
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

async function checkRelevance(params: {
	agent: {
		id: string
		name: string
		description: string | null
		systemPrompt: string | null
		llmProvider: string | null
		llmConfig: unknown
	}
	wsSettings: WorkspaceSettings
	conversationHistory: Array<{ actorName: string; content: string }>
	newMessageContent: string
	isDirectConversation: boolean
}): Promise<boolean> {
	const { agent, wsSettings, conversationHistory, newMessageContent, isDirectConversation } = params
	const llmConfig = (agent.llmConfig as Record<string, unknown>) ?? {}
	const credentials = resolveChatCredentials({
		wsSettings,
		agent: {
			provider: agent.llmProvider,
			apiKey: (llmConfig.api_key as string | undefined) ?? null,
			model: (llmConfig.model as string | undefined)?.trim() || null,
		},
	})
	// No usable credential (e.g. this agent's only route is Claude OAuth, and
	// the workspace has no fallback configured either) — fail closed.
	if (!credentials) return false

	try {
		const adapter = createLLMAdapter(credentials.provider, {
			api_key: credentials.apiKey,
			base_url: credentials.baseUrl,
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
		return call?.arguments.should_respond === true
	} catch (err) {
		logger.warn('Conversation relevance check failed — staying silent', {
			agentId: agent.id,
			error: String(err),
		})
		return false
	}
}

/** Shared `{actorName}: {content}` transcript join, used both for the relevance check and the seed prompt. */
function formatConversationTranscript(
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
	wasMentioned: boolean
}): string {
	return [
		'A new message was posted in a conversation you are a participant in, and you decided a reply from you may add value. This session stays open for the rest of this conversation — later messages will arrive as further turns, not new prompts.',
		'',
		'Recent conversation history (oldest first):',
		'"""',
		formatConversationTranscript(ctx.conversationHistory) || '(no prior messages)',
		'"""',
		'',
		`The response can be any combination of: taking an action, or posting a reply via post_conversation_message. ${describeReplyExpectation(ctx)}`,
		'IMPORTANT: taking an action (reading data, calling other tools) is invisible to the user by itself — they only see a reply once you call post_conversation_message. If you take actions first, still call post_conversation_message afterward to report back, unless you deliberately chose silence per the guidance above.',
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
	wasMentioned: boolean
}): string {
	if (ctx.isDirectConversation) {
		return "This conversation is just you and the user — there's no one else for them to hear back from, so they are expecting a reply from you. Only stay silent if the message truly needs no response (e.g. a plain 'thanks')."
	}
	if (ctx.wasMentioned) {
		return 'The user @mentioned you directly, which is an explicit, unambiguous request for your reply — silence here reads as being ignored. Reply unless you have a clear reason not to.'
	}
	return "You judged this message relevant enough to act on, so lean toward replying. Doing nothing is still valid if, on reflection, a response from you doesn't actually add anything — but don't default to silence just because it's an option."
}

/**
 * Builds a follow-up turn for an already-running interactive session.
 * Deliberately minimal — the live CLI process already has every prior turn
 * in its own context, this only needs to carry the new message and who sent
 * it (a multi-party room isn't guaranteed to have the same sender turn after
 * turn).
 */
function buildConversationTurnPrompt(ctx: {
	authorName: string
	newMessageContent: string
	isDirectConversation: boolean
	wasMentioned: boolean
}): string {
	const reminder = ctx.isDirectConversation
		? " (it's just the two of you here — they're expecting a reply)"
		: ctx.wasMentioned
			? ' (they @mentioned you directly — expecting a reply)'
			: ''
	return `${ctx.authorName}: ${ctx.newMessageContent}${reminder}`
}
