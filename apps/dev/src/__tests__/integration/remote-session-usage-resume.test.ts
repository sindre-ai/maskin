import { sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertSessionLog, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

// What an earlier segment (before a pause) already persisted on the row.
const FIRST_SEGMENT_TOTALS = {
	totalCostUsd: '0.500000',
	inputTokens: 1000,
	outputTokens: 500,
	cacheCreationInputTokens: 10,
	cacheReadInputTokens: 20,
	durationMs: 3000,
}

// The resumed segment's own `result` envelope: a fresh CLI process reports
// only that segment's usage.
const SECOND_SEGMENT_ENVELOPE = JSON.stringify({
	type: 'result',
	total_cost_usd: 0.25,
	duration_ms: 2000,
	usage: {
		input_tokens: 400,
		output_tokens: 200,
		cache_creation_input_tokens: 5,
		cache_read_input_tokens: 7,
	},
})

// A later turn of the same resumed process: its tokens and duration are for that turn alone,
// and total_cost_usd keeps running on from the first turn's 0.25.
const SECOND_TURN_ENVELOPE = JSON.stringify({
	type: 'result',
	total_cost_usd: 0.4,
	duration_ms: 500,
	usage: {
		input_tokens: 100,
		output_tokens: 50,
		cache_creation_input_tokens: 1,
		cache_read_input_tokens: 2,
	},
})

// A remote session that was paused and resumed must end with the usage of all
// its segments, not just the last one. The sessions row is what billing and
// the pricing checks read.
describe('SessionManager.markRemoteSessionComplete — usage across a resume (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	async function resumedSession() {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			config: { llm_route: 'claude_oauth' },
			modelName: 'claude-sonnet-5-5',
			...FIRST_SEGMENT_TOTALS,
		})
		await insertSessionLog(db, session.id, {
			stream: 'stdout',
			content: `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${SECOND_SEGMENT_ENVELOPE}\n`,
		})
		return session
	}

	async function readRow(sessionId: string) {
		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		return row
	}

	it('sums tokens, cost and duration of both segments when the resumed segment completes', async () => {
		const session = await resumedSession()

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.markRemoteSessionComplete(session.id, 0)
		} finally {
			await manager.stop()
		}

		const row = await readRow(session.id)
		expect(row?.status).toBe('completed')
		expect(row?.inputTokens).toBe(1400)
		expect(row?.outputTokens).toBe(700)
		expect(row?.cacheCreationInputTokens).toBe(15)
		expect(row?.cacheReadInputTokens).toBe(27)
		expect(row?.totalCostUsd).toBe('0.750000')
		expect(row?.durationMs).toBe(5000)
	})

	it('counts the final segment once when a stop write is followed by the genuine report', async () => {
		const session = await resumedSession()

		const manager = new SessionManager(db, stubStorage())
		try {
			// stopSession()'s provisional write, then the agent-server's real report.
			await manager.markRemoteSessionComplete(session.id, null, { stoppedByUser: true })
			const provisional = await readRow(session.id)
			expect(provisional?.status).toBe('user_stopped')
			expect(provisional?.inputTokens).toBe(FIRST_SEGMENT_TOTALS.inputTokens)
			expect(provisional?.totalCostUsd).toBe(FIRST_SEGMENT_TOTALS.totalCostUsd)

			await manager.markRemoteSessionComplete(session.id, 143)
		} finally {
			await manager.stop()
		}

		const row = await readRow(session.id)
		expect(row?.inputTokens).toBe(1400)
		expect(row?.outputTokens).toBe(700)
		expect(row?.totalCostUsd).toBe('0.750000')
		expect(row?.durationMs).toBe(5000)
	})

	it('sums every turn of the resumed segment and takes its last running cost', async () => {
		const session = await resumedSession()
		// A second turn in the same process: tokens and duration are per turn, the cost a running total.
		await insertSessionLog(db, session.id, {
			stream: 'stdout',
			content: `${SECOND_TURN_ENVELOPE}\n`,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.markRemoteSessionComplete(session.id, 0)
		} finally {
			await manager.stop()
		}

		const row = await readRow(session.id)
		expect(row?.inputTokens).toBe(1400 + 100)
		expect(row?.outputTokens).toBe(700 + 50)
		expect(row?.cacheCreationInputTokens).toBe(15 + 1)
		expect(row?.cacheReadInputTokens).toBe(27 + 2)
		expect(row?.durationMs).toBe(5000 + 500)
		// 0.5 saved at pause + 0.4 running total of the resumed process, not 0.25 + 0.4.
		expect(row?.totalCostUsd).toBe('0.900000')
	})

	it('keeps the stored totals when the report finds no result envelope', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			config: { llm_route: 'claude_oauth' },
			...FIRST_SEGMENT_TOTALS,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.markRemoteSessionComplete(session.id, 0)
		} finally {
			await manager.stop()
		}

		const row = await readRow(session.id)
		expect(row?.inputTokens).toBe(1000)
		expect(row?.totalCostUsd).toBe('0.500000')
		expect(row?.durationMs).toBe(3000)
	})
})
