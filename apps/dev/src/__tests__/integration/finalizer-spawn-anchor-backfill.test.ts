import { conversations, messages, sessionLogs, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { InteractiveTurnFinalizer } from '../../services/interactive-turn-finalizer'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, sql } from './global-setup'

/**
 * The finalizer backfills sessions.spawned_by_message_id at turn close for
 * every sub-agent that was spawned inside the closing turn's session_logs
 * window. Task 1a (3276ab69).
 *
 * The WHERE is anchored on the session_logs row that opened the turn (the
 * maskin_message_id envelope), not on a wall-clock turnStart, so a replay of
 * the same result line reads the same window and stays correct. These tests
 * exercise both the live-ingest path and the recovery-scan replay path
 * against real Postgres.
 */

function resultLine(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'closing turn text',
		duration_ms: 1234,
		total_cost_usd: 0.42,
		usage: { input_tokens: 10, output_tokens: 20 },
		...overrides,
	})
}

function userTurnLine(messageId: number) {
	return JSON.stringify({
		type: 'user',
		message: { role: 'user', content: 'hello' },
		maskin_message_id: messageId,
	})
}

describe('Interactive turn finalizer — spawn-anchor backfill (Integration)', () => {
	let workspaceId: string
	let agentId: string
	let humanId: string
	let conversationId: string
	let finalizer: InteractiveTurnFinalizer

	async function feed(sessionId: string, content: string): Promise<{ id: number }> {
		const [log] = await db
			.insert(sessionLogs)
			.values({ sessionId, stream: 'stdout', content })
			.returning()
		if (!log) throw new Error('failed to insert log')
		await finalizer.onStdout(sessionId, content, log.id)
		return log
	}

	/**
	 * Spawn a sub-agent row directly (mirrors run_agent's write shape).
	 * `source_session_id` is set, `spawned_by_message_id` is NULL.
	 */
	async function spawnSubAgent(primarySessionId: string): Promise<{
		id: string
		createdAt: Date | null
	}> {
		const sub = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: false,
			sourceSessionId: primarySessionId,
			spawnedByMessageId: null,
			conversationId: null,
			status: 'running',
		})
		if (!sub) throw new Error('failed to spawn sub-agent')
		return { id: sub.id, createdAt: sub.createdAt }
	}

	async function readSpawnAnchor(sessionId: string): Promise<number | null> {
		const [row] = await db
			.select({ spawnedByMessageId: sessions.spawnedByMessageId })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
		return row?.spawnedByMessageId ?? null
	}

	beforeEach(async () => {
		// Messages + conversations don't get truncated by global-setup; clear them
		// explicitly so ids stay unambiguous across tests.
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
			.values({ workspaceId, title: 'Anchor test chat', createdBy: humanId })
			.returning()
		if (!conversation) throw new Error('failed to seed conversation')
		conversationId = conversation.id

		finalizer = new InteractiveTurnFinalizer(db)
	})

	it('backfills spawn anchor on every sub-agent created inside the turn window', async () => {
		const primary = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!primary) throw new Error('no primary')

		// Turn opens with the user envelope.
		await feed(primary.id, `${userTurnLine(1)}\n`)

		// Primary spawns two sub-agents during the turn.
		const subA = await spawnSubAgent(primary.id)
		const subB = await spawnSubAgent(primary.id)

		// Turn closes; the finalizer writes the assistant message AND runs the
		// spawn-anchor backfill.
		await feed(primary.id, `${resultLine()}\n`)

		const [assistantMessage] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
			.orderBy(messages.id)
		if (!assistantMessage) throw new Error('no assistant message posted')

		expect(await readSpawnAnchor(subA.id)).toBe(assistantMessage.id)
		expect(await readSpawnAnchor(subB.id)).toBe(assistantMessage.id)
	})

	it('leaves top-level (non-spawned) sessions with spawned_by_message_id = NULL', async () => {
		const primary = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!primary) throw new Error('no primary')

		// A parallel top-level session with no source_session_id — must not be
		// touched by the primary's turn close.
		const unrelated = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: false,
			sourceSessionId: null,
			conversationId: null,
			status: 'running',
		})
		if (!unrelated) throw new Error('no unrelated session')

		await feed(primary.id, `${userTurnLine(1)}\n`)
		await feed(primary.id, `${resultLine()}\n`)

		expect(await readSpawnAnchor(unrelated.id)).toBeNull()
	})

	it('leaves sub-agents from earlier turns untouched (bounded on turn-start log)', async () => {
		const primary = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!primary) throw new Error('no primary')

		// Turn 1 opens, spawns a sub-agent, then closes.
		await feed(primary.id, `${userTurnLine(1)}\n`)
		const subTurn1 = await spawnSubAgent(primary.id)
		await feed(primary.id, `${resultLine({ result: 'turn one' })}\n`)

		const [firstMessage] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
			.orderBy(messages.id)
		if (!firstMessage) throw new Error('turn 1 did not post')

		// Turn 2 opens, spawns another sub-agent, then closes.
		await feed(primary.id, `${userTurnLine(2)}\n`)
		const subTurn2 = await spawnSubAgent(primary.id)
		await feed(primary.id, `${resultLine({ result: 'turn two' })}\n`)

		const rows = await db
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
			.orderBy(messages.id)
		const secondMessage = rows[1]
		if (!secondMessage) throw new Error('turn 2 did not post')

		expect(await readSpawnAnchor(subTurn1.id)).toBe(firstMessage.id)
		expect(await readSpawnAnchor(subTurn2.id)).toBe(secondMessage.id)
		expect(firstMessage.id).not.toBe(secondMessage.id)
	})

	it('handles a seeded first turn with no maskin_message_id envelope (falls back to session.created_at)', async () => {
		const primary = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!primary) throw new Error('no primary')

		const sub = await spawnSubAgent(primary.id)

		// No user-turn envelope. The finalizer must still anchor the sub-agent to
		// this turn's assistant message using the session's own createdAt as the
		// lower bound.
		await feed(primary.id, `${resultLine()}\n`)

		const [assistantMessage] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.conversationId, conversationId))

		expect(await readSpawnAnchor(sub.id)).toBe(assistantMessage?.id ?? -1)
	})

	it('re-processes a result line via the recovery-scan replay path with the same window', async () => {
		const primary = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!primary) throw new Error('no primary')

		// Sub-agent inside this turn's window.
		await feed(primary.id, `${userTurnLine(1)}\n`)
		const insideWindow = await spawnSubAgent(primary.id)
		const resultLog = await feed(primary.id, `${resultLine()}\n`)

		const [assistantMessage] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
		if (!assistantMessage) throw new Error('turn did not post')

		expect(await readSpawnAnchor(insideWindow.id)).toBe(assistantMessage.id)

		// A NEW sub-agent inserted AFTER the turn closed — outside the window.
		const outsideWindow = await spawnSubAgent(primary.id)
		expect(await readSpawnAnchor(outsideWindow.id)).toBeNull()

		// Clear the in-process cache so the DB unique index — not the cache — is
		// the guard on re-post, mirroring an apps/dev restart where the Docker
		// log stream replays a live session's ENTIRE log on first connect.
		finalizer.clearSeenCache()
		await finalizer.onStdout(primary.id, `${resultLine()}\n`, resultLog.id)

		// The in-window row keeps its anchor (IS NULL guard makes the repeat a
		// no-op); the out-of-window row is still NULL because it was created
		// after the turn's session_logs upper bound.
		expect(await readSpawnAnchor(insideWindow.id)).toBe(assistantMessage.id)
		expect(await readSpawnAnchor(outsideWindow.id)).toBeNull()
		expect(
			await db
				.select({ id: messages.id })
				.from(messages)
				.where(eq(messages.conversationId, conversationId)),
		).toHaveLength(1)
	})

	it('completes the backfill on replay when the previous pass inserted the message but did not anchor', async () => {
		const primary = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!primary) throw new Error('no primary')

		await feed(primary.id, `${userTurnLine(1)}\n`)

		// Simulate the previous pass: assistant message was inserted (with dedupe
		// key), but the backfill UPDATE never ran. The sub-agent stays unanchored.
		const dedupeKey = require('node:crypto')
			.createHash('sha256')
			.update(`${resultLine()}`)
			.digest('hex')
			.slice(0, 32)
		const [preInserted] = await db
			.insert(messages)
			.values({
				conversationId,
				actorId: agentId,
				content: 'closing turn text',
				metadata: {
					source: 'final_output',
					final_output: { dedupe_key: dedupeKey, message_id: null },
				},
				sessionId: primary.id,
			})
			.returning()
		if (!preInserted) throw new Error('pre-insert failed')

		const sub = await spawnSubAgent(primary.id)

		// Replay the same result line — insertConversationMessage returns null
		// (dedupe), but the finalizer looks up the existing message id and
		// completes the backfill against it.
		await feed(primary.id, `${resultLine()}\n`)

		expect(await readSpawnAnchor(sub.id)).toBe(preInserted.id)

		// Idempotent: still only one message row for this turn.
		const rows = await db
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
		expect(rows).toHaveLength(1)
	})
})
