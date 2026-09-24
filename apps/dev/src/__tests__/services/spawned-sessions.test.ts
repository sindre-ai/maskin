import {
	isConversationParticipant,
	loadSessionStateChangeFrame,
	loadSpawnedSessionsByMessage,
} from '../../services/spawned-sessions'
import { buildSession } from '../factories'
import { createTestContext } from '../setup'

describe('isConversationParticipant', () => {
	it('returns true when the actor has an active participant row', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ conversationId: 'conv-1' }]

		const result = await isConversationParticipant(db, 'conv-1', 'actor-1')

		expect(result).toBe(true)
	})

	it('returns false when the actor has no participant row', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = []

		const result = await isConversationParticipant(db, 'conv-1', 'actor-1')

		expect(result).toBe(false)
	})
})

describe('loadSpawnedSessionsByMessage', () => {
	it('returns an empty bucket for every message when the caller is not a participant', async () => {
		const { db, mockResults } = createTestContext()
		// First select is the participant lookup; it comes back empty (not a participant).
		mockResults.selectQueue = [[]]

		const result = await loadSpawnedSessionsByMessage(db, {
			conversationId: 'conv-1',
			workspaceId: 'ws-1',
			messageIds: [10, 11],
			actorId: 'outsider',
		})

		expect(result.get(10)).toEqual([])
		expect(result.get(11)).toEqual([])
	})

	it('does not leak a spawned session to a non-participant even when the row exists', async () => {
		const { db, mockResults } = createTestContext()
		// Participant lookup empty; a session row is configured but must never be read
		// for the outsider because the service returns before the sessions query.
		mockResults.selectQueue = [[], [buildSession({ spawnedByMessageId: 10 })]]

		const result = await loadSpawnedSessionsByMessage(db, {
			conversationId: 'conv-1',
			workspaceId: 'ws-1',
			messageIds: [10],
			actorId: 'outsider',
		})

		expect(result.get(10)).toEqual([])
	})

	it('returns an empty map without querying when there are no message ids', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = []

		const result = await loadSpawnedSessionsByMessage(db, {
			conversationId: 'conv-1',
			workspaceId: 'ws-1',
			messageIds: [],
			actorId: 'actor-1',
		})

		expect(result.size).toBe(0)
	})

	it('buckets spawned sessions under their message id for an entitled participant', async () => {
		const { db, mockResults } = createTestContext()
		const session = buildSession({
			id: 'session-1',
			status: 'running',
			actorId: 'agent-1',
			actionPrompt: 'Do the thing',
			spawnedByMessageId: 10,
			dependsOnSessionIds: ['dep-1'],
		})
		// 1st select: participant lookup (entitled). 2nd select: the sessions page.
		// The row mirrors the select aliases the service reads it back under.
		mockResults.selectQueue = [
			[{ conversationId: 'conv-1' }],
			[
				{
					...session,
					actorName: 'Agent One',
					depends_on_session_ids: ['dep-1'],
				},
			],
		]

		const result = await loadSpawnedSessionsByMessage(db, {
			conversationId: 'conv-1',
			workspaceId: 'ws-1',
			messageIds: [10],
			actorId: 'actor-1',
		})

		const bucket = result.get(10)
		expect(bucket).toHaveLength(1)
		expect(bucket?.[0].id).toBe('session-1')
		expect(bucket?.[0].actorName).toBe('Agent One')
		expect(bucket?.[0].depends_on_session_ids).toEqual(['dep-1'])
	})
})

describe('loadSessionStateChangeFrame', () => {
	const baseRow = {
		id: 'session-1',
		workspaceId: 'ws-1',
		status: 'completed',
		durationMs: 1200,
		result: { ok: true },
		currentActivity: null,
		dependsOnSessionIds: ['dep-1'],
		spawnedByMessageId: 10,
		conversationId: 'conv-1',
	}

	it('returns null when the session row does not exist', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = []

		const frame = await loadSessionStateChangeFrame(db, {
			sessionId: 'missing',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(frame).toBeNull()
	})

	it('returns null when the session belongs to another workspace', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ ...baseRow, workspaceId: 'other-ws' }]

		const frame = await loadSessionStateChangeFrame(db, {
			sessionId: 'session-1',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(frame).toBeNull()
	})

	it('returns null for a tool-call session that was not spawned by a message', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ ...baseRow, spawnedByMessageId: null }]

		const frame = await loadSessionStateChangeFrame(db, {
			sessionId: 'session-1',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(frame).toBeNull()
	})

	it('returns null when the session has no conversation', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ ...baseRow, conversationId: null }]

		const frame = await loadSessionStateChangeFrame(db, {
			sessionId: 'session-1',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(frame).toBeNull()
	})

	it('returns null when the caller is not a conversation participant', async () => {
		const { db, mockResults } = createTestContext()
		// 1st select: the session row. 2nd select: participant lookup returns empty.
		mockResults.selectQueue = [[baseRow], []]

		const frame = await loadSessionStateChangeFrame(db, {
			sessionId: 'session-1',
			workspaceId: 'ws-1',
			actorId: 'outsider',
		})

		expect(frame).toBeNull()
	})

	it('returns the snake_case state-changed payload for an entitled participant', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[baseRow], [{ conversationId: 'conv-1' }]]

		const frame = await loadSessionStateChangeFrame(db, {
			sessionId: 'session-1',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(frame).toEqual({
			session_id: 'session-1',
			status: 'completed',
			duration_ms: 1200,
			depends_on_session_ids: ['dep-1'],
			result: { ok: true },
			current_activity: null,
		})
	})
})
