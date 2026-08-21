import { events, conversations, messages, sessionLogs } from '@maskin/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { InteractiveTurnFinalizer } from '../../services/interactive-turn-finalizer'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db } from './global-setup'

/**
 * The auto-posted end-of-turn reply, against real Postgres.
 *
 * The idempotency behaviour here CANNOT be verified with a mocked DB: the
 * guard is a partial unique index on a JSON expression, and the whole point of
 * the test is that the index — not the in-process cache — is what stops a
 * Docker log replay from re-posting every past turn.
 */

function resultLine(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'Here is the answer.',
		duration_ms: 1234,
		total_cost_usd: 0.42,
		usage: { input_tokens: 10, output_tokens: 20 },
		...overrides,
	})
}

describe('Interactive turn finalizer', () => {
	let workspaceId: string
	let agentId: string
	let humanId: string
	let conversationId: string
	let finalizer: InteractiveTurnFinalizer

	async function seedSession(overrides: Record<string, unknown> = {}) {
		return insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
			...overrides,
		})
	}

	/** Persists a log row the way the ingest path does, then feeds the finalizer. */
	async function feed(sessionId: string, content: string) {
		const [log] = await db
			.insert(sessionLogs)
			.values({ sessionId, stream: 'stdout', content })
			.returning()
		if (!log) throw new Error('failed to insert log')
		await finalizer.onStdout(sessionId, content, log.id)
		return log
	}

	async function messagesFor(conversation: string) {
		return db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversation))
			.orderBy(messages.id)
	}

	beforeEach(async () => {
		const human = await insertActor(db, { type: 'human' })
		const agent = await insertActor(db, { type: 'agent' })
		if (!human || !agent) throw new Error('failed to seed actors')
		humanId = human.id
		agentId = agent.id

		const workspace = await insertWorkspace(db, humanId)
		if (!workspace) throw new Error('failed to seed workspace')
		workspaceId = workspace.id

		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Test chat', createdBy: humanId })
			.returning()
		if (!conversation) throw new Error('failed to seed conversation')
		conversationId = conversation.id

		finalizer = new InteractiveTurnFinalizer(db)
	})

	it('posts the end-of-turn output as a message from the agent', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine()}\n`)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe('Here is the answer.')
		expect(rows[0]?.actorId).toBe(agentId)
		expect(rows[0]?.sessionId).toBe(session.id)
		expect((rows[0]?.metadata as { source?: string })?.source).toBe('final_output')
	})

	it('bumps lastMessageAt and logs a message_posted event', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine()}\n`)

		const [conversation] = await db
			.select()
			.from(conversations)
			.where(eq(conversations.id, conversationId))
		expect(conversation?.lastMessageAt).not.toBeNull()

		const eventRows = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, conversationId), eq(events.action, 'message_posted')))
		expect(eventRows).toHaveLength(1)
	})

	it('posts only once when the same result line is replayed', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')
		const line = resultLine()

		await feed(session.id, `${line}\n`)
		await feed(session.id, `${line}\n`)
		// Clearing the in-process cache proves the DB unique index is the guard.
		// The local Docker path replays a session's ENTIRE log on first connect
		// (`tail: 'all'`), and after an apps/dev restart the cache is empty — so
		// if the index weren't doing the work, every past turn would re-post.
		finalizer.clearSeenCache()
		await feed(session.id, `${line}\n`)

		expect(await messagesFor(conversationId)).toHaveLength(1)
	})

	it('treats two distinct turns as distinct messages', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine({ result: 'first', duration_ms: 1 })}\n`)
		await feed(session.id, `${resultLine({ result: 'second', duration_ms: 2 })}\n`)

		const rows = await messagesFor(conversationId)
		expect(rows.map((r) => r.content)).toEqual(['first', 'second'])
	})

	it('reassembles a result envelope split across two chunks', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')
		const line = resultLine()
		const cut = Math.floor(line.length / 2)

		// Docker delivers chunks, not lines — a chunk can end mid-JSON.
		await feed(session.id, line.slice(0, cut))
		await feed(session.id, `${line.slice(cut)}\n`)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe('Here is the answer.')
	})

	it('posts nothing when the turn produced no text', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine({ result: '' })}\n`)
		await feed(session.id, `${resultLine({ result: '   ', duration_ms: 9 })}\n`)

		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('posts an error result and tags it', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(
			session.id,
			`${resultLine({ is_error: true, subtype: 'error_max_turns', result: 'Ran out of turns.' })}\n`,
		)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		const finalOutput = (rows[0]?.metadata as { final_output?: Record<string, unknown> })
			?.final_output
		expect(finalOutput?.is_error).toBe(true)
		expect(finalOutput?.subtype).toBe('error_max_turns')
	})

	it('truncates output longer than the message limit', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine({ result: 'x'.repeat(9000) })}\n`)

		const rows = await messagesFor(conversationId)
		expect(rows[0]?.content).toHaveLength(8000)
		expect(
			(rows[0]?.metadata as { final_output?: { truncated?: boolean } })?.final_output?.truncated,
		).toBe(true)
	})

	it('ignores sub-agent result envelopes', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		// A Task tool's own result — intermediate output, not the agent's reply.
		await feed(session.id, `${resultLine({ parent_tool_use_id: 'toolu_1' })}\n`)

		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('ignores non-interactive sessions and interactive ones with no conversation', async () => {
		const oneShot = await seedSession({ interactive: false })
		const detached = await seedSession({ conversationId: null })
		if (!oneShot || !detached) throw new Error('no session')

		await feed(oneShot.id, `${resultLine()}\n`)
		await feed(detached.id, `${resultLine({ duration_ms: 7 })}\n`)

		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('attributes the output to the chat message whose turn produced it', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		const [trigger] = await db
			.insert(messages)
			.values({ conversationId, actorId: humanId, content: 'what is the status?' })
			.returning()
		if (!trigger) throw new Error('no trigger message')

		// writeInput persists the user turn tagged with the message id.
		await feed(
			session.id,
			`${JSON.stringify({
				type: 'user',
				message: { role: 'user', content: 'what is the status?' },
				maskin_message_id: trigger.id,
			})}\n`,
		)
		await feed(session.id, `${resultLine()}\n`)

		const [posted] = await db
			.select()
			.from(messages)
			.where(eq(messages.actorId, agentId))
			.orderBy(desc(messages.id))
			.limit(1)
		expect(
			(posted?.metadata as { final_output?: { message_id?: number } })?.final_output?.message_id,
		).toBe(trigger.id)
	})

	it('records a null turn attribution when no tagged turn precedes the result', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine()}\n`)

		const rows = await messagesFor(conversationId)
		expect(
			(rows[0]?.metadata as { final_output?: { message_id?: number | null } })?.final_output
				?.message_id,
		).toBeNull()
	})

	it('does not create any session — an auto-post cannot wake another agent', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		const before = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
		await feed(session.id, `${resultLine()}\n`)
		const after = await messagesFor(conversationId)

		// The finalizer never calls evaluateAndRespond, so exactly one message
		// appears and no responder chain can start from it.
		expect(after).toHaveLength(before.length + 1)
	})
})
