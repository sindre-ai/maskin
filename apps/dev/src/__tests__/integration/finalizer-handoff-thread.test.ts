import { conversations, messages, sessionLogs } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { InteractiveTurnFinalizer } from '../../services/interactive-turn-finalizer'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, sql } from './global-setup'

/**
 * An agent's answer to a helper's result belongs with the hand-off, not in the middle of
 * the chat: it is posted in the thread of the message that handed the work off, and also
 * shows in the main timeline so the person sees the outcome. Everything else keeps its
 * old destination. Real Postgres, because the thread columns and the anchor lookups are
 * the whole point.
 */

function resultLine(text = 'The post is ready for approval') {
	return JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: text,
		duration_ms: 1,
		total_cost_usd: 0.01,
		usage: { input_tokens: 1, output_tokens: 1 },
	})
}

function userTurnLine(messageId: number) {
	return JSON.stringify({
		type: 'user',
		message: { role: 'user', content: 'hello' },
		maskin_message_id: messageId,
	})
}

describe('Interactive turn finalizer — hand-off threads (Integration)', () => {
	let workspaceId: string
	let agentId: string
	let humanId: string
	let conversationId: string
	let finalizer: InteractiveTurnFinalizer

	async function feed(sessionId: string, content: string) {
		const [log] = await db
			.insert(sessionLogs)
			.values({ sessionId, stream: 'stdout', content: `${content}\n` })
			.returning()
		if (!log) throw new Error('failed to insert log')
		await finalizer.onStdout(sessionId, `${content}\n`, log.id)
	}

	async function postMessage(values: Partial<typeof messages.$inferInsert> = {}) {
		const [row] = await db
			.insert(messages)
			.values({
				conversationId,
				actorId: agentId,
				content: 'a message',
				metadata: null,
				...values,
			})
			.returning()
		if (!row) throw new Error('failed to insert message')
		return row
	}

	/** The agent's chat session, a helper it spawned, and the hidden result handed back. */
	async function handOff(opts: { anchorMessageId: number | null }) {
		const primary = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!primary) throw new Error('no primary session')
		const helper = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: false,
			spawnedBySessionId: primary.id,
			spawnedByMessageId: opts.anchorMessageId,
			status: 'completed',
		})
		if (!helper) throw new Error('no helper session')
		const handedBack = await postMessage({
			content: 'The helper finished',
			metadata: { helper_return: helper.id },
		})
		return { primary, helper, handedBack }
	}

	async function agentAnswerFor(sessionId: string) {
		const rows = await db
			.select()
			.from(messages)
			.where(and(eq(messages.conversationId, conversationId), eq(messages.sessionId, sessionId)))
		const answer = rows.at(-1)
		if (!answer) throw new Error('the agent posted nothing')
		return answer
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
		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Hand-off chat', createdBy: humanId })
			.returning()
		if (!conversation) throw new Error('failed to seed conversation')
		conversationId = conversation.id
		finalizer = new InteractiveTurnFinalizer(db)
	})

	it('answers a helper result in the hand-off thread and also in the main chat', async () => {
		const anchor = await postMessage({ content: 'I have handed this to the content creator' })
		const { primary, handedBack } = await handOff({ anchorMessageId: anchor.id })

		await feed(primary.id, userTurnLine(handedBack.id))
		await feed(primary.id, resultLine())

		const answer = await agentAnswerFor(primary.id)
		expect(answer.threadRootId).toBe(anchor.id)
		expect(answer.threadAlsoInChannel).toBe(true)
	})

	it('keeps the thread when the hand-off message was itself a reply in a thread', async () => {
		const root = await postMessage({ content: 'Root of a side thread' })
		const anchor = await postMessage({
			content: 'Handing off from the thread',
			threadRootId: root.id,
		})
		const { primary, handedBack } = await handOff({ anchorMessageId: anchor.id })

		await feed(primary.id, userTurnLine(handedBack.id))
		await feed(primary.id, resultLine())

		const answer = await agentAnswerFor(primary.id)
		expect(answer.threadRootId).toBe(root.id)
		expect(answer.threadAlsoInChannel).toBe(true)
	})

	it('answers in the main chat when the hand-off has no anchor message yet', async () => {
		const { primary, handedBack } = await handOff({ anchorMessageId: null })

		await feed(primary.id, userTurnLine(handedBack.id))
		await feed(primary.id, resultLine())

		const answer = await agentAnswerFor(primary.id)
		expect(answer.threadRootId).toBeNull()
		expect(answer.threadAlsoInChannel).toBe(false)
	})

	it('never threads an anchor that lives in another conversation', async () => {
		const [other] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Another chat', createdBy: humanId })
			.returning()
		if (!other) throw new Error('no second conversation')
		const [foreign] = await db
			.insert(messages)
			.values({ conversationId: other.id, actorId: agentId, content: 'elsewhere' })
			.returning()
		if (!foreign) throw new Error('no foreign message')
		const { primary, handedBack } = await handOff({ anchorMessageId: foreign.id })

		await feed(primary.id, userTurnLine(handedBack.id))
		await feed(primary.id, resultLine())

		const answer = await agentAnswerFor(primary.id)
		expect(answer.threadRootId).toBeNull()
	})

	it('leaves an ordinary top-level turn in the main chat', async () => {
		const primary = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!primary) throw new Error('no primary session')
		const question = await postMessage({ actorId: humanId, content: 'hi' })

		await feed(primary.id, userTurnLine(question.id))
		await feed(primary.id, resultLine('Hello'))

		const answer = await agentAnswerFor(primary.id)
		expect(answer.threadRootId).toBeNull()
		expect(answer.threadAlsoInChannel).toBe(false)
	})
})
