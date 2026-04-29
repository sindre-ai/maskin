import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForSessionTerminal } from '../wait-for-session'
import { buildSSEFrame, makeHangingFetch, makeSSEResponse } from './sse-test-utils'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey',
}

describe('waitForSessionTerminal', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('resolves with reason=done and the final status when a terminal frame arrives', async () => {
		const chunks = [
			buildSSEFrame('working', { id: '1', event: 'stdout' }),
			buildSSEFrame('completed', { event: 'done' }),
		]
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeSSEResponse(chunks, { keepOpen: false }))

		const outcome = await waitForSessionTerminal(config, 'ws-1', 'sess-1', 5000)

		expect(outcome).toEqual({ reason: 'done', status: 'completed' })
	})

	it('carries the failed status through when the backend signals failure', async () => {
		const chunks = [buildSSEFrame('failed', { event: 'done' })]
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeSSEResponse(chunks, { keepOpen: false }))

		const outcome = await waitForSessionTerminal(config, 'ws-1', 'sess-1', 5000)

		expect(outcome).toEqual({ reason: 'done', status: 'failed' })
	})

	it('resolves with reason=timeout when the deadline elapses first', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(makeHangingFetch())

		const outcome = await waitForSessionTerminal(config, 'ws-1', 'sess-1', 30)

		expect(outcome).toEqual({ reason: 'timeout' })
	})

	it('resolves with reason=auth_error on a 401 from the stream endpoint', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }))
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		const outcome = await waitForSessionTerminal(config, 'ws-1', 'sess-1', 5000)

		expect(outcome).toEqual({ reason: 'auth_error' })
		errorSpy.mockRestore()
	})

	it('resolves with reason=terminal_status on a 404 from the stream endpoint', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }))
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		const outcome = await waitForSessionTerminal(config, 'ws-1', 'sess-1', 5000)

		expect(outcome).toEqual({ reason: 'terminal_status' })
		errorSpy.mockRestore()
	})

	it('hits the session-specific stream URL with auth headers', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				makeSSEResponse([buildSSEFrame('completed', { event: 'done' })], { keepOpen: false }),
			)

		await waitForSessionTerminal(config, 'ws-42', 'sess-xyz', 5000)

		const call = fetchSpy.mock.calls[0]
		expect(call[0]).toBe('http://localhost:3000/api/sessions/sess-xyz/logs/stream')
		const init = call[1] as RequestInit
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer ank_testkey')
		expect(headers['X-Workspace-Id']).toBe('ws-42')
	})
})
