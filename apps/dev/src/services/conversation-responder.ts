import type { Database } from '@maskin/db'
import { actors, conversationParticipants, messages, workspaces } from '@maskin/db/schema'
import { and, desc, eq, isNull, ne } from 'drizzle-orm'
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
 * a full container session — and spawns a real one-shot session only for
 * agents that decide to. Never throws; every failure mode degrades to
 * "stay silent" so a broken relevance check can't spam a conversation.
 */
export async function evaluateAndRespond(ctx: {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	conversationId: string
	messageId: number
}): Promise<void> {
	const { db, sessionManager, workspaceId, conversationId, messageId } = ctx

	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
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
			// @mention fast-path — skip the relevance check entirely, an
			// explicit @mention is already an unambiguous signal to respond.
			const shouldRespond = mentioned.has(agent.id)
				? true
				: await checkRelevance({
						agent,
						wsSettings,
						conversationHistory,
						newMessageContent: message.content,
					})
			if (!shouldRespond) return

			await sessionManager
				.createSession(workspaceId, {
					actorId: agent.id,
					actionPrompt: buildConversationReplyPrompt({
						conversationId,
						newMessageContent: message.content,
						authorActorId: message.actorId,
					}),
					config: { conversation: { conversation_id: conversationId, message_id: messageId } },
					createdBy: message.actorId,
				})
				.catch((err: unknown) =>
					logger.error('Failed to create conversation-responder session', {
						agentId: agent.id,
						conversationId,
						error: String(err),
					}),
				)
		}),
	)
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
}): Promise<boolean> {
	const { agent, wsSettings, conversationHistory, newMessageContent } = params
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
		const transcript = conversationHistory.map((m) => `${m.actorName}: ${m.content}`).join('\n')
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
						'You are one of several participants in a group chat. A new message just arrived. Decide whether YOU specifically should reply — not whether someone could reply. Stay silent when the message is directed at someone else, already answered, small talk between humans, or you have nothing useful to add. Call decide_response with your answer.',
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

function buildConversationReplyPrompt(ctx: {
	conversationId: string
	newMessageContent: string
	authorActorId: string
}): string {
	return [
		'A new message was posted in a conversation you are a participant in, and you decided a reply from you may add value. Use the conversation MCP tools (list_conversation_messages, get_conversation) to read the full thread context before replying — the excerpt below is only the triggering message.',
		'',
		'The response can be any combination of: taking an action, posting a reply via post_conversation_message, or doing nothing if on reflection no response is warranted after all — silence is a valid outcome.',
		'',
		`Conversation ID: ${ctx.conversationId}`,
		`Author of the new message (actor ID): ${ctx.authorActorId}`,
		'New message content:',
		'"""',
		ctx.newMessageContent,
		'"""',
	].join('\n')
}
