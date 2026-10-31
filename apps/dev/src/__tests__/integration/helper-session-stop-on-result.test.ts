import { sessionLogs, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { InteractiveTurnFinalizer } from '../../services/interactive-turn-finalizer'
import { resolveAskConversationId } from '../../services/spawned-sessions'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, sql } from './global-setup'

/**
 * A helper session (started by an agent from a chat) is interactive so it can
 * ask the person a question, but it ends when it returns its result — unless it
 * is mid-question. These run the real finalizer against real Postgres.
 */

function resultLine(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'Found 3 gigs',
		duration_ms: 1000,
		total_cost_usd: 0.1,
		usage: { input_tokens: 1, output_tokens: 2 },
		...overrides,
	})
}

describe('Helper sessions end on their result (Integration)', () => {
	let workspaceId: string
	let agentId: string
	let humanId: string
	let onHelperResult: ReturnType<typeof vi.fn>
	let onLimitResult: ReturnType<typeof vi.fn>
	let finalizer: InteractiveTurnFinalizer

	async function feed(sessionId: string, content: string) {
		const [log] = await db
			.insert(sessionLogs)
			.values({ sessionId, stream: 'stdout', content })
			.returning()
		if (!log) throw new Error('failed to insert log')
		await finalizer.onStdout(sessionId, content, log.id)
	}

	function helper(config: Record<string, unknown>) {
		return insertSession(db, workspaceId, agentId, agentId, {
			interactive: true,
			conversationId: null,
			status: 'running',
			config: { interactive: true, stop_on_result: true, ...config },
		})
	}

	beforeEach(async () => {
		await sql`TRUNCATE messages, conversations CASCADE`
		const human = await insertActor(db, { type: 'human' })
		const agent = await insertActor(db, { type: 'agent' })
		if (!human || !agent) throw new Error('failed to seed actors')
		humanId = human.id
		agentId = agent.id
		const workspace = await insertWorkspace(db, humanId)
		if (!workspace) throw new Error('failed to seed workspace')
		workspaceId = workspace.id
		onHelperResult = vi.fn().mockResolvedValue(undefined)
		onLimitResult = vi.fn().mockResolvedValue(undefined)
		finalizer = new InteractiveTurnFinalizer(db, { onHelperResult, onLimitResult })
	})

	it('ends the session when it returns a result with nothing pending', async () => {
		const session = await helper({})
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine()}\n`)

		expect(onHelperResult).toHaveBeenCalledWith(session.id, {
			isError: false,
			text: 'Found 3 gigs',
		})
	})

	it('keeps the session alive while it waits on an answer', async () => {
		const session = await helper({ awaiting: { message_id: 7, question: {} } })
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine({ result: '' })}\n`)

		expect(onHelperResult).not.toHaveBeenCalled()
	})

	it('ends the session on the result that follows the answer', async () => {
		const session = await helper({ awaiting: { message_id: 7, question: {} } })
		if (!session) throw new Error('no session')
		await feed(session.id, `${resultLine({ result: '' })}\n`)

		// The input route clears the wait when the answer is delivered.
		await db
			.update(sessions)
			.set({ config: { interactive: true, stop_on_result: true } })
			.where(eq(sessions.id, session.id))
		await feed(session.id, `${resultLine({ result: 'Done after the answer' })}\n`)

		expect(onHelperResult).toHaveBeenCalledOnce()
	})

	it('does not end an ordinary chat session', async () => {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			status: 'running',
			config: { interactive: true },
		})
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine()}\n`)

		expect(onHelperResult).not.toHaveBeenCalled()
	})

	describe('a limit error that leaves the CLI running', () => {
		const limitText = "You've hit your session limit · resets 2:20pm (Europe/Copenhagen)"

		function interactive() {
			return insertSession(db, workspaceId, agentId, humanId, {
				interactive: true,
				conversationId: null,
				status: 'running',
				config: { interactive: true },
			})
		}

		it('ends a session whose final result is a limit error', async () => {
			const session = await interactive()
			if (!session) throw new Error('no session')

			await feed(session.id, `${resultLine({ is_error: true, result: limitText })}\n`)

			expect(onLimitResult).toHaveBeenCalledWith(session.id, { isError: true, text: limitText })
			expect(onHelperResult).not.toHaveBeenCalled()
		})

		it('leaves a helper to its own ending, once', async () => {
			const session = await helper({})
			if (!session) throw new Error('no session')

			await feed(session.id, `${resultLine({ is_error: true, result: limitText })}\n`)

			expect(onHelperResult).toHaveBeenCalledOnce()
			expect(onLimitResult).not.toHaveBeenCalled()
		})

		it('does not end a session that only quotes the banner', async () => {
			const session = await interactive()
			if (!session) throw new Error('no session')

			await feed(
				session.id,
				`${resultLine({ is_error: true, result: `Another session said: ${limitText}` })}\n`,
			)
			await feed(session.id, `${resultLine({ result: limitText })}\n`)

			expect(onLimitResult).not.toHaveBeenCalled()
		})

		it('does not end a session on an old limit result that a later turn has followed', async () => {
			const session = await interactive()
			if (!session) throw new Error('no session')
			const [old] = await db
				.insert(sessionLogs)
				.values({
					sessionId: session.id,
					stream: 'stdout',
					content: `${resultLine({ is_error: true, result: limitText })}\n`,
				})
				.returning()
			if (!old) throw new Error('failed to insert log')
			await feed(session.id, `${resultLine({ result: 'Back after the reset' })}\n`)

			await finalizer.onStdout(
				session.id,
				`${resultLine({ is_error: true, result: limitText })}\n`,
				old.id,
			)

			expect(onLimitResult).not.toHaveBeenCalled()
		})
	})
})

describe('resolveAskConversationId (Integration)', () => {
	it('inherits the chat through a helper of a helper', async () => {
		const human = await insertActor(db, { type: 'human' })
		const agent = await insertActor(db, { type: 'agent' })
		if (!human || !agent) throw new Error('failed to seed actors')
		const workspace = await insertWorkspace(db, human.id)
		if (!workspace) throw new Error('failed to seed workspace')
		const chat = await insertSession(db, workspace.id, agent.id, human.id, {
			interactive: true,
			status: 'running',
		})
		const helper = await insertSession(db, workspace.id, agent.id, agent.id, {
			interactive: true,
			conversationId: null,
			config: { ask_conversation_id: '11111111-1111-4111-8111-111111111111' },
		})
		if (!chat || !helper) throw new Error('no sessions')

		expect(await resolveAskConversationId(db, helper.id)).toBe(
			'11111111-1111-4111-8111-111111111111',
		)
		// A chat session without a conversation has nowhere to ask.
		expect(await resolveAskConversationId(db, chat.id)).toBeNull()
	})
})
