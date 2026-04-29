import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionLogSubscriptionRegistry } from '../session-log-subscriptions'
import { buildSSEFrame, makeHangingFetch, makeMockServer, makeSSEResponse } from './sse-test-utils'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey',
	defaultWorkspaceId: 'ws-default',
}

describe('SessionLogSubscriptionRegistry lifecycle', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('add returns subscription with uuid, sessionId, workspaceId', async () => {
		const mock = makeMockServer()
		vi.spyOn(globalThis, 'fetch').mockImplementation(makeHangingFetch())
		const registry = createSessionLogSubscriptionRegistry(config, mock as never)
		const sub = registry.add('ws-1', 'sess-1')
		expect(sub.id).toMatch(/^[0-9a-f-]{36}$/)
		expect(sub.sessionId).toBe('sess-1')
		expect(sub.workspaceId).toBe('ws-1')
		expect(sub.logsDelivered).toBe(0)
		await registry.shutdownAll()
	})

	it('shares a single stream across multiple subscriptions on the same session', async () => {
		const mock = makeMockServer()
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(makeHangingFetch())
		const registry = createSessionLogSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', 'sess-1')
		registry.add('ws-1', 'sess-1')
		await Promise.resolve()
		await Promise.resolve()
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(registry.list()).toHaveLength(2)
		await registry.shutdownAll()
	})

	it('opens separate streams for different sessions', async () => {
		const mock = makeMockServer()
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(makeHangingFetch())
		const registry = createSessionLogSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', 'sess-a')
		registry.add('ws-1', 'sess-b')
		await Promise.resolve()
		await Promise.resolve()
		expect(fetchSpy).toHaveBeenCalledTimes(2)
		await registry.shutdownAll()
	})

	it('hits the correct session-specific stream URL with auth headers', async () => {
		const mock = makeMockServer()
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(makeHangingFetch())
		const registry = createSessionLogSubscriptionRegistry(config, mock as never)
		registry.add('ws-42', 'sess-xyz')
		await Promise.resolve()
		await Promise.resolve()
		const call = fetchSpy.mock.calls[0]
		expect(call[0]).toBe('http://localhost:3000/api/sessions/sess-xyz/logs/stream')
		const init = call[1] as RequestInit
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer ank_testkey')
		expect(headers['X-Workspace-Id']).toBe('ws-42')
		await registry.shutdownAll()
	})

	it('remove returns true once, then false', async () => {
		const mock = makeMockServer()
		vi.spyOn(globalThis, 'fetch').mockImplementation(makeHangingFetch())
		const registry = createSessionLogSubscriptionRegistry(config, mock as never)
		const sub = registry.add('ws-1', 'sess-1')
		expect(registry.remove(sub.id)).toBe(true)
		expect(registry.remove(sub.id)).toBe(false)
		await registry.shutdownAll()
	})
})

describe('session-log delivery', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('delivers stdout lines as info-level notifications with logger maskin/session-logs', async () => {
		const mock = makeMockServer()
		const chunks = [
			buildSSEFrame('hello world', { id: '1', event: 'stdout' }),
			buildSSEFrame('second line', { id: '2', event: 'stdout' }),
		]
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeSSEResponse(chunks))

		const registry = createSessionLogSubscriptionRegistry(config, mock as never)
		const sub = registry.add('ws-1', 'sess-1')

		await new Promise((r) => setTimeout(r, 20))

		expect(mock._send).toHaveBeenCalledTimes(2)
		const first = mock._send.mock.calls[0][0]
		expect(first.level).toBe('info')
		expect(first.logger).toBe('maskin/session-logs')
		expect(first.data.subscription_id).toBe(sub.id)
		expect(first.data.session_id).toBe('sess-1')
		expect(first.data.kind).toBe('log')
		expect(first.data.stream).toBe('stdout')
		expect(first.data.content).toBe('hello world')

		const [stored] = registry.list()
		expect(stored.logsDelivered).toBe(2)
		expect(stored.logsDropped).toBe(0)

		await registry.shutdownAll()
	})

	it('uses error level for stderr lines', async () => {
		const mock = makeMockServer()
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			makeSSEResponse([buildSSEFrame('boom', { id: '1', event: 'stderr' })]),
		)
		const registry = createSessionLogSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', 'sess-1')

		await new Promise((r) => setTimeout(r, 20))

		expect(mock._send).toHaveBeenCalledTimes(1)
		expect(mock._send.mock.calls[0][0].level).toBe('error')
		expect(mock._send.mock.calls[0][0].data.stream).toBe('stderr')

		await registry.shutdownAll()
	})

	it('emits a final done notification and auto-removes the subscription', async () => {
		const mock = makeMockServer()
		const chunks = [
			buildSSEFrame('working\n', { id: '1', event: 'stdout' }),
			buildSSEFrame('completed', { event: 'done' }),
		]
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeSSEResponse(chunks, { keepOpen: false }))

		const registry = createSessionLogSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', 'sess-1')

		await new Promise((r) => setTimeout(r, 30))

		expect(mock._send).toHaveBeenCalledTimes(2)
		const last = mock._send.mock.calls[1][0]
		expect(last.data.kind).toBe('done')
		expect(last.data.status).toBe('completed')

		// Subscription auto-removed after terminal frame
		expect(registry.list()).toHaveLength(0)

		await registry.shutdownAll()
	})

	it('increments logsDropped when sendLoggingMessage throws', async () => {
		const mock = makeMockServer()
		mock._send.mockRejectedValue(new Error('disconnected'))
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			makeSSEResponse([buildSSEFrame('x', { id: '1', event: 'stdout' })]),
		)
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		const registry = createSessionLogSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', 'sess-1')

		await new Promise((r) => setTimeout(r, 20))

		const [stored] = registry.list()
		expect(stored.logsDelivered).toBe(0)
		expect(stored.logsDropped).toBe(1)

		errorSpy.mockRestore()
		await registry.shutdownAll()
	})
})

describe('terminal statuses and auth', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it('tears down subscriptions on 401', async () => {
		const mock = makeMockServer()
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }))
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		const registry = createSessionLogSubscriptionRegistry(config, mock as never)
		registry.add('ws-1', 'sess-1')

		await new Promise((r) => setTimeout(r, 30))

		expect(registry.list()).toHaveLength(0)
		const errorCall = mock._send.mock.calls.find((c) => c[0].level === 'error')
		expect(errorCall).toBeDefined()
		expect(errorCall?.[0].logger).toBe('maskin/session-logs')

		errorSpy.mockRestore()
		await registry.shutdownAll()
	})
})
