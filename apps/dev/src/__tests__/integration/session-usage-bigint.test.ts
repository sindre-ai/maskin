import { sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertSessionLog, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

const INT4_MAX = 2_147_483_647

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

// Session 833683e5 in prod: cumulative cache reads sat 28M below int4 max, so
// the next usage write overflowed int4 and every later write failed.
describe('session usage counters above int4 max (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	describe('GET /api/sessions/usage', () => {
		it('returns 200 with JSON numbers when a session and the bucket sum exceed int4 max', async () => {
			const completedAt = new Date('2026-01-05T12:00:00Z')
			// Two sessions in one bucket: each fits the 5B bigint columns, and the
			// SUM (4B input, 6B cache) is above int4 max even where one row is not.
			for (let i = 0; i < 2; i++) {
				await insertSession(db, workspaceId, actorId, actorId, {
					status: 'completed',
					completedAt,
					inputTokens: 2_000_000_000,
					outputTokens: 5,
					cacheReadInputTokens: 3_000_000_000,
					cacheCreationInputTokens: 7,
				})
			}

			const app = createIntegrationApp({ path: '/api/sessions', module: sessionsRoutes })
			const res = await app.request(
				jsonGet(
					`/api/sessions/usage?actor_id=${actorId}&from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z&bucket=day`,
					{ 'x-workspace-id': workspaceId },
				),
			)

			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				buckets: Array<Record<string, unknown>>
				totals: Record<string, unknown>
			}
			expect(body.buckets).toHaveLength(1)
			expect(body.buckets[0]?.input_tokens).toBe(4_000_000_000)
			expect(body.buckets[0]?.output_tokens).toBe(10)
			expect(body.buckets[0]?.cache_tokens).toBe(6_000_000_014)
			expect(body.totals.input_tokens).toBe(4_000_000_000)
			expect(body.totals.cache_tokens).toBe(6_000_000_014)
			expect(typeof body.totals.input_tokens).toBe('number')
		})
	})

	describe('usage write', () => {
		const resultLog = (usage: Record<string, number>, durationMs: number) =>
			`${JSON.stringify({ type: 'result', total_cost_usd: 0.5, duration_ms: durationMs, usage })}\n`

		async function runningSession(overrides: Record<string, unknown> = {}) {
			return insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				config: { llm_route: 'claude_oauth' },
				modelName: 'claude-sonnet-5-5',
				...overrides,
			})
		}

		it('remote completion stores a token and duration value above int4 max', async () => {
			const session = await runningSession()
			await insertSessionLog(db, session.id, {
				stream: 'stdout',
				content: resultLog(
					{
						input_tokens: 10,
						output_tokens: 20,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 3_000_000_000,
					},
					3_000_000_000,
				),
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await manager.markRemoteSessionComplete(session.id, 0)
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('completed')
			expect(row?.cacheReadInputTokens).toBe(3_000_000_000)
			expect(row?.durationMs).toBe(3_000_000_000)
		})

		it('additive accumulation carries a counter past int4 max (the prod overflow)', async () => {
			// Session 833683e5: 2,119,114,728 cache reads, then one more segment.
			const session = await runningSession({ cacheReadInputTokens: 2_119_114_728 })
			await insertSessionLog(db, session.id, {
				stream: 'stdout',
				content: resultLog(
					{
						input_tokens: 10,
						output_tokens: 20,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 100_000_000,
					},
					1000,
				),
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				// Private: the additive writer shared by pause, timeout and local completion.
				await (
					manager as unknown as { accumulateSessionUsage(id: string): Promise<unknown> }
				).accumulateSessionUsage(session.id)
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			// 2,119,114,728 + 100,000,000 = 2,219,114,728, above int4 max.
			expect(row?.cacheReadInputTokens).toBe(2_219_114_728)
			expect(row?.cacheReadInputTokens).toBeGreaterThan(INT4_MAX)
		})
	})
})
