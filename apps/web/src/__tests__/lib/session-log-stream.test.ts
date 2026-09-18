import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@microsoft/fetch-event-source', () => ({
	fetchEventSource: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
	getApiKey: vi.fn(() => 'test-api-key'),
}))

vi.mock('@/lib/constants', () => ({
	API_BASE: '/api',
}))

import { activeSessionLogConnections, subscribeToSessionLogs } from '@/lib/session-log-stream'
import { fetchEventSource } from '@microsoft/fetch-event-source'

const workspaceId = 'ws-1'
const sessionA = '11111111-1111-1111-1111-111111111111'
const sessionB = '22222222-2222-2222-2222-222222222222'

type Options = {
	signal: AbortSignal
	headers: Record<string, string>
	onmessage: (msg: { id: string; event: string; data: string }) => void
}

/** Options of the Nth fetchEventSource call, in call order. */
function callOptions(index = 0): Options {
	const call = vi.mocked(fetchEventSource).mock.calls[index]
	if (!call) throw new Error(`no fetchEventSource call at index ${index}`)
	return call[1] as unknown as Options
}

beforeEach(() => {
	vi.clearAllMocks()
	sessionStorage.clear()
})

describe('subscribeToSessionLogs', () => {
	it('opens one connection shared by every subscriber of the same session', () => {
		const a = vi.fn()
		const b = vi.fn()

		const offA = subscribeToSessionLogs(workspaceId, sessionA, a)
		const offB = subscribeToSessionLogs(workspaceId, sessionA, b)

		// Two components watching one session must not each hold a socket —
		// the browser caps concurrent connections per origin at 6 on HTTP/1.1.
		expect(fetchEventSource).toHaveBeenCalledTimes(1)

		callOptions().onmessage({ id: '7', event: 'stdout', data: 'hello' })

		expect(a).toHaveBeenCalledWith(expect.objectContaining({ id: 7, content: 'hello' }))
		expect(b).toHaveBeenCalledWith(expect.objectContaining({ id: 7, content: 'hello' }))

		offA()
		offB()
		expect(activeSessionLogConnections()).toBe(0)
	})

	it('keeps the connection open until the last subscriber leaves, then aborts it', () => {
		const offA = subscribeToSessionLogs(workspaceId, sessionA, vi.fn())
		const offB = subscribeToSessionLogs(workspaceId, sessionA, vi.fn())
		const signal = callOptions().signal

		offA()
		expect(signal.aborted).toBe(false)
		expect(activeSessionLogConnections()).toBe(1)

		offB()
		expect(signal.aborted).toBe(true)
		expect(activeSessionLogConnections()).toBe(0)
	})

	it('opens a separate connection per session id', () => {
		const offA = subscribeToSessionLogs(workspaceId, sessionA, vi.fn())
		const offB = subscribeToSessionLogs(workspaceId, sessionB, vi.fn())

		expect(fetchEventSource).toHaveBeenCalledTimes(2)

		offA()
		offB()
		expect(activeSessionLogConnections()).toBe(0)
	})

	it('resumes from its own cursor space, not the workspace-event one', () => {
		sessionStorage.setItem(`maskin-last-session-log-id-${sessionA}`, '412')
		// A workspace-event cursor for the same workspace must be invisible here:
		// the two streams count different sequences and folding them together
		// would resume one from the other's position.
		sessionStorage.setItem(`maskin-last-event-id-${workspaceId}`, '9999')

		const off = subscribeToSessionLogs(workspaceId, sessionA, vi.fn())

		expect(callOptions().headers).toMatchObject({
			Authorization: 'Bearer test-api-key',
			'X-Workspace-Id': workspaceId,
			'Last-Event-ID': '412',
		})

		off()
	})

	it('advances its own cursor from the frame id', () => {
		const off = subscribeToSessionLogs(workspaceId, sessionA, vi.fn())

		callOptions().onmessage({ id: '55', event: 'stdout', data: 'line' })

		expect(sessionStorage.getItem(`maskin-last-session-log-id-${sessionA}`)).toBe('55')
		expect(sessionStorage.getItem(`maskin-last-event-id-${workspaceId}`)).toBeNull()

		off()
	})

	it('decodes a log frame into the store row shape', () => {
		const onLog = vi.fn()
		const off = subscribeToSessionLogs(workspaceId, sessionA, onLog)

		callOptions().onmessage({ id: '12', event: 'stderr', data: 'boom' })

		expect(onLog).toHaveBeenCalledWith({
			id: 12,
			sessionId: sessionA,
			stream: 'stderr',
			content: 'boom',
			createdAt: null,
		})

		off()
	})

	it('drops the done frame and frames with a non-numeric id', () => {
		const onLog = vi.fn()
		const off = subscribeToSessionLogs(workspaceId, sessionA, onLog)

		callOptions().onmessage({ id: '13', event: 'done', data: 'completed' })
		callOptions().onmessage({ id: 'not-a-number', event: 'stdout', data: 'x' })

		expect(onLog).not.toHaveBeenCalled()
		// The done frame must not advance the cursor either, so a reconnect
		// after a terminal session replays from the last real line.
		expect(sessionStorage.getItem(`maskin-last-session-log-id-${sessionA}`)).toBeNull()

		off()
	})

	it('starts a fresh connection after done, and the old unsubscribe is inert', () => {
		const onLog = vi.fn()
		const off = subscribeToSessionLogs(workspaceId, sessionA, onLog)

		callOptions().onmessage({ id: '13', event: 'done', data: 'completed' })
		expect(activeSessionLogConnections()).toBe(0)

		const off2 = subscribeToSessionLogs(workspaceId, sessionA, onLog)
		expect(fetchEventSource).toHaveBeenCalledTimes(2)

		// The first subscription's teardown must not abort the new connection.
		off()
		expect(activeSessionLogConnections()).toBe(1)

		off2()
		expect(activeSessionLogConnections()).toBe(0)
	})
})
