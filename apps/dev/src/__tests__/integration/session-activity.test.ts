import { sessionLogs } from '@maskin/db/schema'
import { SESSION_ACTIVITY_SCAN_ROWS, sessionActivityResponseSchema } from '@maskin/shared'
import { insertActor, insertSession, insertSessionLog, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

const app = createIntegrationApp({ path: '/api/sessions', module: sessionsRoutes as never })

describe('GET /api/sessions/:id/activity (Integration)', () => {
	let workspaceId: string
	let agentId: string
	let sessionId: string

	const log = (content: unknown, stream = 'stdout') =>
		insertSessionLog(db, sessionId, {
			stream,
			content: typeof content === 'string' ? content : JSON.stringify(content),
		})

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent' })
		agentId = agent.id
		const session = await insertSession(db, workspaceId, agentId, getTestActorId())
		if (!session) throw new Error('no session')
		sessionId = session.id
	})

	it('returns normalized turns that satisfy the response schema', async () => {
		await log({ type: 'user', message: { content: 'hi' }, maskin_message_id: 42 })
		await log({
			type: 'assistant',
			message: {
				content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x.ts' } }],
			},
		})
		await log({
			type: 'user',
			message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
		})
		await log({ type: 'result', is_error: false, result: 'All done' })

		const res = await app.request(
			jsonGet(`/api/sessions/${sessionId}/activity`, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const body = sessionActivityResponseSchema.parse(await res.json())
		expect(body.turns).toHaveLength(1)
		expect(body.turns[0]).toMatchObject({
			message_id: 42,
			status: 'completed',
			result: { text: 'All done', is_error: false },
		})
		expect(body.turns[0]?.steps[0]).toMatchObject({
			kind: 'tool_use',
			label: 'Using Read',
			detail: '/x.ts',
			status: 'completed',
		})
		expect(body.has_older).toBe(false)
	})

	it('honours limit_turns and message_id', async () => {
		for (const id of [1, 2, 3]) {
			await log({ type: 'user', message: { content: 'q' }, maskin_message_id: id })
			await log({ type: 'result', is_error: false, result: `r${id}` })
		}
		const headers = { 'x-workspace-id': workspaceId }
		const newest = await (
			await app.request(jsonGet(`/api/sessions/${sessionId}/activity?limit_turns=2`, headers))
		).json()
		expect(newest.turns.map((t: { message_id: number }) => t.message_id)).toEqual([2, 3])

		const one = await (
			await app.request(jsonGet(`/api/sessions/${sessionId}/activity?message_id=1`, headers))
		).json()
		expect(one.turns.map((t: { message_id: number }) => t.message_id)).toEqual([1])
	})

	it('pages older turns with before_log_id and reports has_older for a full window', async () => {
		await log({ type: 'user', message: { content: 'old' }, maskin_message_id: 1 })
		const cut = await log({ type: 'user', message: { content: 'new' }, maskin_message_id: 2 })
		if (!cut) throw new Error('no log')
		const headers = { 'x-workspace-id': workspaceId }
		const res = await app.request(
			jsonGet(`/api/sessions/${sessionId}/activity?before_log_id=${cut.id}`, headers),
		)
		const body = await res.json()
		expect(body.turns.map((t: { message_id: number }) => t.message_id)).toEqual([1])
		expect(SESSION_ACTIVITY_SCAN_ROWS).toBeGreaterThan(0)
	})

	it('validates query params', async () => {
		const headers = { 'x-workspace-id': workspaceId }
		for (const q of ['limit_turns=0', 'limit_turns=999', 'limit_turns=abc', 'before_log_id=-1']) {
			const res = await app.request(jsonGet(`/api/sessions/${sessionId}/activity?${q}`, headers))
			expect(res.status).toBe(400)
		}
	})

	it('404s for a session in another workspace', async () => {
		const other = await insertWorkspace(db, getTestActorId())
		const res = await app.request(
			jsonGet(`/api/sessions/${sessionId}/activity`, { 'x-workspace-id': other.id }),
		)
		expect(res.status).toBe(404)
	})
	describe('scan window boundary', () => {
		const bulk = async (rows: unknown[]) => {
			// chunked to stay under the bind-parameter limit
			for (let i = 0; i < rows.length; i += 500) {
				await db.insert(sessionLogs).values(
					rows.slice(i, i + 500).map((content) => ({
						sessionId,
						stream: 'stdout',
						content: JSON.stringify(content),
					})),
				)
			}
		}
		const tool = (n: number) => ({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', id: `t${n}`, name: 'Read', input: {} }] },
		})
		const headers = () => ({ 'x-workspace-id': workspaceId })
		const fetchActivity = async (q = '') =>
			(await app.request(jsonGet(`/api/sessions/${sessionId}/activity${q}`, headers()))).json()

		it('keeps a turn that straddles the window and flags it partial', async () => {
			await bulk([
				{ type: 'user', message: { content: 'a' }, maskin_message_id: 1 },
				{ type: 'result', is_error: false, result: 'r1' },
				{ type: 'user', message: { content: 'b' }, maskin_message_id: 2 },
				// window starts inside turn 2
				...Array.from({ length: SESSION_ACTIVITY_SCAN_ROWS + 5 }, (_, i) => tool(i)),
				{ type: 'result', is_error: false, result: 'r2' },
			])
			const body = sessionActivityResponseSchema.parse(await fetchActivity('?limit_turns=20'))
			expect(body.turns.map((t) => t.message_id)).toEqual([2])
			expect(body.turns[0]).toMatchObject({ partial: true, status: 'completed' })
			expect(body.turns[0]?.result?.text).toBe('r2')
			expect(body.has_older).toBe(true)

			// paging from oldest_log_id reaches turn 1 and does not repeat turn 2
			const older = await fetchActivity(`?limit_turns=20&before_log_id=${body.oldest_log_id}`)
			expect(older.turns.map((t: { message_id: number }) => t.message_id)).toEqual([1])
			expect(older.turns[0].partial).toBe(false)
		})

		it('finds a turn by message_id even when it is outside the window', async () => {
			await bulk([
				{ type: 'user', message: { content: 'a' }, maskin_message_id: 7 },
				{ type: 'result', is_error: false, result: 'r7' },
				{ type: 'user', message: { content: 'b' }, maskin_message_id: 8 },
				...Array.from({ length: SESSION_ACTIVITY_SCAN_ROWS + 5 }, (_, i) => tool(i)),
				{ type: 'result', is_error: false, result: 'r8' },
			])
			const body = sessionActivityResponseSchema.parse(await fetchActivity('?message_id=7'))
			expect(body.turns).toHaveLength(1)
			expect(body.turns[0]).toMatchObject({ message_id: 7, result: { text: 'r7' }, partial: false })
		})

		it('drops rows that predate tagging when no tagged envelope exists', async () => {
			await bulk(Array.from({ length: SESSION_ACTIVITY_SCAN_ROWS + 5 }, (_, i) => tool(i)))
			const body = sessionActivityResponseSchema.parse(await fetchActivity())
			expect(body.turns).toEqual([])
		})
	})
})
