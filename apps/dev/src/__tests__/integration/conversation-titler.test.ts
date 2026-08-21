import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	conversationParticipants,
	conversations,
	messages,
	workspaces,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

// The titler resolves credentials and then calls the provider over the network.
// Stub the adapter factory so the state machine (which is the part with real DB
// semantics) is exercised against real Postgres without a live LLM.
const chat = vi.fn()
vi.mock('../../lib/llm/index', () => ({
	createLLMAdapter: () => ({ chat }),
}))

const { maybeGenerateConversationTitle } = await import('../../services/conversation-titler')
const { default: conversationsRoutes } = await import('../../routes/conversations')

function titleResponse(title: string) {
	return {
		content: null,
		tool_calls: [{ id: 'call_1', name: 'set_conversation_title', arguments: { title } }],
		finish_reason: 'tool_calls' as const,
	}
}

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: { createSession: ReturnType<typeof vi.fn> }
	}
}

function createConversationsApp(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('sessionManager', {
			createSession: vi.fn().mockResolvedValue({ id: 'fake-session-id' }),
			findActiveConversationSession: vi.fn().mockResolvedValue(null),
			writeInput: vi.fn().mockResolvedValue(undefined),
		} as never)
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

describe('Conversation auto-titler Integration', () => {
	let ownerId: string
	let workspaceId: string
	let conversationId: string

	beforeEach(async () => {
		chat.mockReset()
		ownerId = getTestActorId()
		const ws = await insertWorkspace(db, ownerId)
		if (!ws) throw new Error('failed to create workspace')
		workspaceId = ws.id
		// resolveChatCredentials walks agent key → custom_llm → workspace key →
		// system fallback. Give the workspace a key so the test doesn't depend on
		// MASKIN_FALLBACK_OPENROUTER_KEY being set in the environment.
		await db
			.update(workspaces)
			.set({ settings: { llm_keys: { anthropic: 'sk-ant-test' } } })
			.where(eq(workspaces.id, workspaceId))

		const [created] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'New chat', createdBy: ownerId })
			.returning()
		if (!created) throw new Error('failed to create conversation')
		conversationId = created.id
	})

	async function postMessages(count: number, contentPrefix = 'message') {
		for (let i = 0; i < count; i++) {
			await db
				.insert(messages)
				.values({ conversationId, actorId: ownerId, content: `${contentPrefix} ${i}` })
		}
	}

	async function readConversation() {
		const [row] = await db
			.select({ title: conversations.title, titleAutoState: conversations.titleAutoState })
			.from(conversations)
			.where(eq(conversations.id, conversationId))
			.limit(1)
		if (!row) throw new Error('conversation vanished')
		return row
	}

	it('titles the conversation from the first message and marks it initial', async () => {
		await postMessages(1, 'the deploy pipeline keeps failing on migrate')
		chat.mockResolvedValue(titleResponse('Deploy pipeline failing'))

		await maybeGenerateConversationTitle({ db, workspaceId, conversationId })

		expect(chat).toHaveBeenCalledTimes(1)
		expect(await readConversation()).toEqual({
			title: 'Deploy pipeline failing',
			titleAutoState: 'initial',
		})
	})

	it('logs a conversation_updated event so SSE refreshes the UI', async () => {
		await postMessages(1)
		chat.mockResolvedValue(titleResponse('Deploy pipeline failing'))

		await maybeGenerateConversationTitle({ db, workspaceId, conversationId })

		const rows = await db
			.select({ data: events.data })
			.from(events)
			.where(and(eq(events.entityType, 'conversation'), eq(events.entityId, conversationId)))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.data).toMatchObject({ title: 'Deploy pipeline failing', auto: true })
	})

	it('does not re-title between the initial pass and the refine threshold', async () => {
		await postMessages(1)
		chat.mockResolvedValue(titleResponse('First title'))
		await maybeGenerateConversationTitle({ db, workspaceId, conversationId })
		chat.mockClear()

		// Messages 2-4: still 'initial', still below REFINE_AT_MESSAGES.
		for (let i = 2; i <= 4; i++) {
			await postMessages(1)
			await maybeGenerateConversationTitle({ db, workspaceId, conversationId })
		}

		expect(chat).not.toHaveBeenCalled()
		expect(await readConversation()).toEqual({ title: 'First title', titleAutoState: 'initial' })
	})

	it('refines once the thread reaches five messages, then never again', async () => {
		await postMessages(1)
		chat.mockResolvedValue(titleResponse('First title'))
		await maybeGenerateConversationTitle({ db, workspaceId, conversationId })

		await postMessages(4)
		chat.mockResolvedValue(titleResponse('Refined title'))
		await maybeGenerateConversationTitle({ db, workspaceId, conversationId })
		expect(await readConversation()).toEqual({
			title: 'Refined title',
			titleAutoState: 'refined',
		})

		chat.mockClear()
		await postMessages(5)
		await maybeGenerateConversationTitle({ db, workspaceId, conversationId })
		expect(chat).not.toHaveBeenCalled()
		expect((await readConversation()).title).toBe('Refined title')
	})

	it('never overwrites a manual rename', async () => {
		const app = createConversationsApp(ownerId)
		// The PATCH route is participants-only.
		await db.insert(conversationParticipants).values({ conversationId, actorId: ownerId })

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/conversations/${conversationId}`,
				{ title: 'My own title' },
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(200)
		expect((await readConversation()).titleAutoState).toBe('manual')

		await postMessages(6)
		await maybeGenerateConversationTitle({ db, workspaceId, conversationId })

		expect(chat).not.toHaveBeenCalled()
		expect(await readConversation()).toEqual({ title: 'My own title', titleAutoState: 'manual' })
	})

	it('releases the claim and keeps the title when the LLM call fails', async () => {
		await postMessages(1)
		chat.mockRejectedValue(new Error('provider is down'))

		await maybeGenerateConversationTitle({ db, workspaceId, conversationId })

		// Back to 'none' so a later message retries, rather than being stuck.
		expect(await readConversation()).toEqual({ title: 'New chat', titleAutoState: 'none' })
	})

	it('keeps the claim when the title landed but the audit-log insert failed', async () => {
		await postMessages(1)
		chat.mockResolvedValue(titleResponse('Deploy pipeline failing'))

		// Fail only the events insert, leaving every other statement on the real
		// connection. This is the one throw that can happen *after* the title
		// write has already committed.
		const failingDb = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'insert') {
					return (table: unknown) => {
						if (table === events) throw new Error('events insert exploded')
						return target.insert(table as Parameters<typeof target.insert>[0])
					}
				}
				return Reflect.get(target, prop, receiver)
			},
		}) as Database

		await maybeGenerateConversationTitle({ db: failingDb, workspaceId, conversationId })

		// The claim must NOT be released: the title is correct and final, so
		// handing it back would re-run the pass on the next message and overwrite
		// what the user is already looking at.
		expect(await readConversation()).toEqual({
			title: 'Deploy pipeline failing',
			titleAutoState: 'initial',
		})

		// And a subsequent message must not re-title it.
		chat.mockClear()
		await postMessages(1)
		await maybeGenerateConversationTitle({ db, workspaceId, conversationId })
		expect(chat).not.toHaveBeenCalled()
		expect((await readConversation()).title).toBe('Deploy pipeline failing')
	})

	it('keeps the title when the model returns no tool call', async () => {
		await postMessages(1)
		chat.mockResolvedValue({ content: 'sure!', tool_calls: [], finish_reason: 'stop' })

		await maybeGenerateConversationTitle({ db, workspaceId, conversationId })

		expect(await readConversation()).toEqual({ title: 'New chat', titleAutoState: 'none' })
	})

	it('calls the provider exactly once when two messages race', async () => {
		await postMessages(1)
		chat.mockResolvedValue(titleResponse('Deploy pipeline failing'))

		await Promise.all([
			maybeGenerateConversationTitle({ db, workspaceId, conversationId }),
			maybeGenerateConversationTitle({ db, workspaceId, conversationId }),
		])

		// The conditional-claim UPDATE is what enforces this — without it both
		// callers would read state 'none' and both would call the provider.
		expect(chat).toHaveBeenCalledTimes(1)
		expect((await readConversation()).titleAutoState).toBe('initial')
	})

	it('leaves the placeholder alone when the workspace has no LLM credential', async () => {
		await db.update(workspaces).set({ settings: {} }).where(eq(workspaces.id, workspaceId))
		const previous = process.env.MASKIN_FALLBACK_OPENROUTER_KEY
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = ''
		try {
			await postMessages(1)
			await maybeGenerateConversationTitle({ db, workspaceId, conversationId })
		} finally {
			// Restoring '' rather than deleting when it was unset is equivalent for
			// readFallbackConfig, which only checks truthiness.
			process.env.MASKIN_FALLBACK_OPENROUTER_KEY = previous ?? ''
		}

		expect(chat).not.toHaveBeenCalled()
		expect(await readConversation()).toEqual({ title: 'New chat', titleAutoState: 'none' })
	})
})
