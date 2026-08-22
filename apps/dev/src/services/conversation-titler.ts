import type { Database } from '@maskin/db'
import { events, actors, conversations, messages, workspaces } from '@maskin/db/schema'
import { CONVERSATION_TITLE_MAX_LENGTH } from '@maskin/shared'
import { and, asc, count, eq } from 'drizzle-orm'
import { resolveChatCredentials } from '../lib/llm-routing'
import type { LLMTool } from '../lib/llm/adapter'
import { createLLMAdapter } from '../lib/llm/index'
import { logger } from '../lib/logger'
import type { WorkspaceSettings } from '../lib/types'
import { formatConversationTranscript } from './conversation-responder'

/**
 * Conversations are created with a generic placeholder ("New chat") and get a
 * real, content-derived title from this service instead — a cheap same-process
 * LLM call on the fallback route, never a container agent session.
 *
 * Two passes: an immediate one off the very first message (so the sidebar is
 * scannable within a second of starting a chat), and one refinement once the
 * thread has enough turns to know what it's actually about. A human rename
 * (PATCH /conversations/:id sets title_auto_state = 'manual') permanently ends
 * both.
 */

/** Refine the initial title once the thread reaches this many messages. */
const REFINE_AT_MESSAGES = 5
/** Messages fed to the refinement pass. */
const REFINE_CONTEXT_MESSAGES = 10
/**
 * The adapters (lib/llm/anthropic.ts, openai.ts) have no timeout, retry, or
 * abort support, so the deadline has to live at the call site. A title is
 * cosmetic — a hung provider must not leave the state column claimed forever.
 */
const TITLE_CALL_TIMEOUT_MS = 15_000
/**
 * Well under CONVERSATION_TITLE_MAX_LENGTH (200) — that's the storage limit,
 * this is what actually fits a sidebar row without truncating.
 */
const TITLE_MAX_CHARS = 60

type TitleAutoState = 'none' | 'initial' | 'refined' | 'manual'

const SET_TITLE_TOOL: LLMTool = {
	name: 'set_conversation_title',
	description: 'Set a short, descriptive title for this conversation.',
	parameters: {
		type: 'object',
		properties: {
			title: {
				type: 'string',
				description:
					'A 3-6 word title describing what this conversation is about. No quotes, no trailing punctuation.',
			},
		},
		required: ['title'],
	},
}

const SYSTEM_PROMPT = [
	'You write short titles for chat conversations, like the ones in a chat app sidebar.',
	'Rules: 3-6 words. Describe the topic or task, never the participants ("Deploy pipeline failing", not "Chat with Code Reviewer").',
	'No quotes, no trailing punctuation, no "Conversation about" preamble. Capitalise the first word only, unless a proper noun follows.',
	'Call set_conversation_title with your answer.',
].join(' ')

/**
 * Decides whether this conversation is due for an (initial or refined) title
 * and, if so, generates one. Fire-and-forget from the message-post path —
 * never throws, and every failure mode leaves the existing title untouched.
 */
export async function maybeGenerateConversationTitle(ctx: {
	db: Database
	workspaceId: string
	conversationId: string
}): Promise<void> {
	const { db, workspaceId, conversationId } = ctx

	const [conversation] = await db
		.select({
			id: conversations.id,
			createdBy: conversations.createdBy,
			titleAutoState: conversations.titleAutoState,
		})
		.from(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.workspaceId, workspaceId)))
		.limit(1)
	if (!conversation) return

	const state = conversation.titleAutoState as TitleAutoState
	if (state === 'refined' || state === 'manual') return

	const [countRow] = await db
		.select({ value: count() })
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
	const messageCount = countRow?.value ?? 0

	let target: TitleAutoState
	let contextLimit: number
	if (state === 'none' && messageCount >= 1) {
		target = 'initial'
		contextLimit = 1
	} else if (state === 'initial' && messageCount >= REFINE_AT_MESSAGES) {
		target = 'refined'
		contextLimit = REFINE_CONTEXT_MESSAGES
	} else {
		return
	}

	// Claim the transition BEFORE calling the LLM. Every message post fires this
	// function, so without the claim a burst of messages would each see the same
	// pre-state and all call the provider. The conditional WHERE makes the claim
	// atomic: exactly one caller gets rows back, the rest return here.
	const claimed = await db
		.update(conversations)
		.set({ titleAutoState: target })
		.where(and(eq(conversations.id, conversationId), eq(conversations.titleAutoState, state)))
		.returning({ id: conversations.id })
	if (claimed.length === 0) return

	// Set once the title write has committed. Past that point the claim must NOT
	// be handed back: doing so would leave the conversation holding a real title
	// with an eligible state, so the next message would re-run the pass and
	// overwrite what was just written (with a second provider call).
	let committed = false

	// Any failure before that must hand the claim back, or the conversation is
	// stuck on its placeholder forever. Guarded on the target state so a manual
	// rename that lands mid-call isn't clobbered back to an auto state.
	const releaseClaim = async () => {
		try {
			await db
				.update(conversations)
				.set({ titleAutoState: state })
				.where(and(eq(conversations.id, conversationId), eq(conversations.titleAutoState, target)))
		} catch (err: unknown) {
			logger.error('Failed to release conversation title claim', {
				conversationId,
				error: String(err),
			})
		}
	}

	try {
		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
		const wsSettings = (ws?.settings as WorkspaceSettings) ?? {}

		// No agent config: fall straight through resolveChatCredentials' chain to
		// the workspace key and then the system fallback, which lands on the
		// small/cheap model. Titling isn't attributable to any one agent.
		const credentials = resolveChatCredentials({
			wsSettings,
			agent: { provider: null, apiKey: null, model: null },
		})
		if (!credentials) {
			// Not an error: a workspace with no LLM key of any kind simply keeps
			// its placeholder titles. Warn so an operator can tell titling was
			// skipped rather than failing.
			logger.warn('Conversation auto-title skipped — no chat-callable credentials', {
				workspaceId,
				conversationId,
			})
			await releaseClaim()
			return
		}

		const historyRows = await db
			.select({ actorName: actors.name, content: messages.content })
			.from(messages)
			.innerJoin(actors, eq(actors.id, messages.actorId))
			.where(eq(messages.conversationId, conversationId))
			.orderBy(asc(messages.id))
			.limit(contextLimit)
		if (historyRows.length === 0) {
			await releaseClaim()
			return
		}

		const adapter = createLLMAdapter(credentials.provider, {
			api_key: credentials.apiKey,
			base_url: credentials.baseUrl,
		})
		const response = await withTimeout(
			adapter.chat({
				model: credentials.model,
				temperature: 0,
				tools: [SET_TITLE_TOOL],
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: `Conversation:\n${formatConversationTranscript(historyRows)}` },
				],
			}),
			TITLE_CALL_TIMEOUT_MS,
		)

		const call = response.tool_calls.find((tc) => tc.name === 'set_conversation_title')
		const title = sanitizeTitle(call?.arguments.title)
		if (!title) {
			logger.warn('Conversation auto-title produced no usable title', {
				conversationId,
				model: credentials.model,
			})
			await releaseClaim()
			return
		}

		// Guarded on the state we claimed: if a human renamed the conversation
		// while the LLM call was in flight, title_auto_state is now 'manual' and
		// this write correctly does nothing.
		const updated = await db
			.update(conversations)
			.set({ title, updatedAt: new Date() })
			.where(and(eq(conversations.id, conversationId), eq(conversations.titleAutoState, target)))
			.returning({ id: conversations.id })
		if (updated.length === 0) return
		committed = true

		// Same action as the manual rename in routes/conversations.ts, with
		// `auto` in the payload to distinguish them in the audit log. This is also what drives
		// the live UI update: sse-invalidation.ts refreshes the conversation list
		// and detail on any entity_type 'conversation' event. actorId is the
		// conversation's creator — a background job has no acting actor (same
		// convention as TokenManager.markRevoked).
		await db.insert(events).values({
			workspaceId,
			actorId: conversation.createdBy,
			action: 'conversation_updated',
			entityType: 'conversation',
			entityId: conversationId,
			data: { title, auto: true, pass: target },
		})
	} catch (err) {
		// Network error, non-2xx, malformed response, or the timeout above — all
		// infra, since the model's own output arrives via tool_calls and is
		// handled there. Release the claim so a later message retries, and keep
		// the current title.
		//
		// Unless the title already landed: a throw after that point (the events
		// insert is the only candidate) means the audit row is missing and the
		// SSE refresh never fired, but the title itself is correct and final.
		// Releasing would turn that into a visible re-title on the next message.
		logger.error('Conversation auto-title failed', {
			conversationId,
			workspaceId,
			titleCommitted: committed,
			error: String(err),
		})
		if (!committed) await releaseClaim()
	}
}

/**
 * Models like to answer with a quoted string or a `Title: ...` preamble even
 * when told not to. Strip that, then bound the length. Returns null when
 * nothing usable is left.
 */
export function sanitizeTitle(raw: unknown): string | null {
	if (typeof raw !== 'string') return null
	let title = raw.trim().replace(/\s+/g, ' ')
	title = title.replace(/^title:\s*/i, '')
	// Wrapping quotes, straight or curly.
	title = title.replace(/^["'“‘]+/, '').replace(/["'”’]+$/, '')
	title = title
		.trim()
		.replace(/[.,;:]+$/, '')
		.trim()
	if (!title) return null
	const limit = Math.min(TITLE_MAX_CHARS, CONVERSATION_TITLE_MAX_LENGTH)
	if (title.length > limit) title = `${title.slice(0, limit - 1).trimEnd()}…`
	return title
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`LLM call timed out after ${ms}ms`)), ms)
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(err: unknown) => {
				clearTimeout(timer)
				reject(err)
			},
		)
	})
}
