import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import sessionRoutes from '../../routes/sessions'
import { buildSession, buildSessionLog } from '../factories'
import { createMockSessionManager, createTestContext } from '../setup'

type Env = {
	Variables: {
		db: ReturnType<typeof createTestContext>['db']
		sessionManager: ReturnType<typeof createMockSessionManager>
	}
}

function createApp() {
	const { db, mockResults } = createTestContext()
	const sessionManager = createMockSessionManager()

	const app = new Hono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db as never)
		c.set('sessionManager', sessionManager as never)
		return next()
	})
	app.route('/sessions', sessionRoutes)

	return { app, db, mockResults, sessionManager }
}

function parseSSEEvents(text: string): Array<{ event?: string; id?: string; data?: string }> {
	const events: Array<{ event?: string; id?: string; data?: string }> = []
	let current: { event?: string; id?: string; data?: string } = {}

	for (const line of text.split('\n')) {
		if (line.startsWith('event:')) {
			current.event = line.slice(6).trim()
		} else if (line.startsWith('id:')) {
			current.id = line.slice(3).trim()
		} else if (line.startsWith('data:')) {
			current.data = line.slice(5).trim()
		} else if (line === '') {
			if (current.event || current.data) {
				events.push(current)
				current = {}
			}
		}
	}
	if (current.event || current.data) {
		events.push(current)
	}
	return events
}

describe('Agent Server E2E: Log Streaming', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	describe('GET /sessions/:id/logs/stream — terminal session replay', () => {
		it('replays all logs for a completed session then sends done', async () => {
			const { app, mockResults } = createApp()
			const sessionId = 'completed-session-1'
			const session = buildSession({ id: sessionId, status: 'completed' })
			const logs = [
				buildSessionLog({ id: 1, sessionId, stream: 'stdout', content: 'Starting agent...' }),
				buildSessionLog({ id: 2, sessionId, stream: 'stdout', content: 'Processing task...' }),
				buildSessionLog({
					id: 3,
					sessionId,
					stream: 'system',
					content: 'Session completed with exit code 0',
				}),
			]

			// First select: session lookup, second select: all logs
			mockResults.selectQueue = [[session], logs]

			const res = await app.request(`/sessions/${sessionId}/logs/stream`)

			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toContain('text/event-stream')

			const text = await res.text()
			const events = parseSSEEvents(text)

			expect(events.length).toBeGreaterThanOrEqual(4)

			// Verify log events are replayed
			const stdoutEvents = events.filter((e) => e.event === 'stdout')
			expect(stdoutEvents.length).toBe(2)
			expect(stdoutEvents[0].data).toBe('Starting agent...')
			expect(stdoutEvents[1].data).toBe('Processing task...')

			// Verify system log
			const systemEvents = events.filter((e) => e.event === 'system')
			expect(systemEvents.length).toBe(1)
			expect(systemEvents[0].data).toContain('Session completed')

			// Verify done event
			const doneEvents = events.filter((e) => e.event === 'done')
			expect(doneEvents.length).toBe(1)
			expect(doneEvents[0].data).toBe('completed')
		})

		it('replays all logs for a failed session', async () => {
			const { app, mockResults } = createApp()
			const sessionId = 'failed-session-1'
			const session = buildSession({ id: sessionId, status: 'failed' })
			const logs = [
				buildSessionLog({ id: 1, sessionId, stream: 'stdout', content: 'Starting...' }),
				buildSessionLog({
					id: 2,
					sessionId,
					stream: 'stderr',
					content: 'Error: something went wrong',
				}),
				buildSessionLog({
					id: 3,
					sessionId,
					stream: 'system',
					content: 'Session failed with exit code 1',
				}),
			]

			mockResults.selectQueue = [[session], logs]

			const res = await app.request(`/sessions/${sessionId}/logs/stream`)
			expect(res.status).toBe(200)

			const text = await res.text()
			const events = parseSSEEvents(text)

			const stderrEvents = events.filter((e) => e.event === 'stderr')
			expect(stderrEvents.length).toBe(1)
			expect(stderrEvents[0].data).toContain('Error')

			const doneEvents = events.filter((e) => e.event === 'done')
			expect(doneEvents.length).toBe(1)
			expect(doneEvents[0].data).toBe('failed')
		})

		it('replays logs for a timed-out session', async () => {
			const { app, mockResults } = createApp()
			const sessionId = 'timeout-session-1'
			const session = buildSession({ id: sessionId, status: 'timeout' })
			const logs = [
				buildSessionLog({ id: 1, sessionId, stream: 'system', content: 'Session timed out' }),
			]

			mockResults.selectQueue = [[session], logs]

			const res = await app.request(`/sessions/${sessionId}/logs/stream`)
			const text = await res.text()
			const events = parseSSEEvents(text)

			const doneEvents = events.filter((e) => e.event === 'done')
			expect(doneEvents.length).toBe(1)
			expect(doneEvents[0].data).toBe('timeout')
		})
	})

	describe('GET /sessions/:id/logs/stream — session not found', () => {
		it('returns 404 for nonexistent session', async () => {
			const { app, mockResults } = createApp()
			mockResults.select = []

			const res = await app.request('/sessions/nonexistent/logs/stream')
			expect(res.status).toBe(404)
		})
	})

	describe('GET /sessions/:id/logs/stream — SSE event format', () => {
		it('includes event IDs for log replay', async () => {
			const { app, mockResults } = createApp()
			const sessionId = 'id-test-session'
			const session = buildSession({ id: sessionId, status: 'completed' })
			const logs = [
				buildSessionLog({ id: 42, sessionId, stream: 'stdout', content: 'Hello' }),
				buildSessionLog({ id: 43, sessionId, stream: 'stdout', content: 'World' }),
			]

			mockResults.selectQueue = [[session], logs]

			const res = await app.request(`/sessions/${sessionId}/logs/stream`)
			const text = await res.text()
			const events = parseSSEEvents(text)

			const stdoutEvents = events.filter((e) => e.event === 'stdout')
			expect(stdoutEvents[0].id).toBe('42')
			expect(stdoutEvents[1].id).toBe('43')
		})
	})
})
