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

import { SSEFatalError, connectSSE } from '@/lib/sse'
import { fetchEventSource } from '@microsoft/fetch-event-source'

const workspaceId = 'ws-1'

beforeEach(() => {
	vi.clearAllMocks()
	sessionStorage.clear()
})

describe('connectSSE', () => {
	it('returns an AbortController', () => {
		const controller = connectSSE(workspaceId, { onEvent: vi.fn() })
		expect(controller).toBeInstanceOf(AbortController)
	})

	it('calls fetchEventSource with correct URL and headers', () => {
		connectSSE(workspaceId, { onEvent: vi.fn() })

		expect(fetchEventSource).toHaveBeenCalledWith(
			'/api/events',
			expect.objectContaining({
				headers: {
					Authorization: 'Bearer test-api-key',
					'X-Workspace-Id': workspaceId,
				},
				openWhenHidden: true,
			}),
		)
	})

	it('includes Last-Event-ID header when sessionStorage has a stored ID', () => {
		sessionStorage.setItem(`maskin-last-event-id-${workspaceId}`, 'evt-42')

		connectSSE(workspaceId, { onEvent: vi.fn() })

		expect(fetchEventSource).toHaveBeenCalledWith(
			'/api/events',
			expect.objectContaining({
				headers: expect.objectContaining({
					'Last-Event-ID': 'evt-42',
				}),
			}),
		)
	})

	it('passes the AbortController signal to fetchEventSource', () => {
		const controller = connectSSE(workspaceId, { onEvent: vi.fn() })

		expect(fetchEventSource).toHaveBeenCalledWith(
			'/api/events',
			expect.objectContaining({
				signal: controller.signal,
			}),
		)
	})

	describe('onopen callback', () => {
		function getOnopen() {
			const call = vi.mocked(fetchEventSource).mock.calls[0]
			const opts = call[1] as { onopen: (response?: unknown) => Promise<void> }
			return opts.onopen
		}

		function buildResponse(status: number, contentType = 'text/event-stream') {
			return {
				ok: status >= 200 && status < 300,
				status,
				headers: { get: (name: string) => (name === 'content-type' ? contentType : null) },
			}
		}

		it('calls onStatusChange with connected on a healthy event-stream response', async () => {
			const onStatusChange = vi.fn()
			connectSSE(workspaceId, { onEvent: vi.fn(), onStatusChange })

			await getOnopen()(buildResponse(200))

			expect(onStatusChange).toHaveBeenCalledWith('connected')
		})

		// Overriding onopen replaces fetch-event-source's own validation, so a
		// 502 HTML error page from the proxy would otherwise register as a
		// healthy connection that simply never yields an event — the exact
		// production failure this validation exists to catch. Passing a real
		// response shape here matters: calling onopen() with no argument
		// short-circuits every check and passes vacuously.
		it('rejects a non-ok response instead of reporting connected', async () => {
			const onStatusChange = vi.fn()
			connectSSE(workspaceId, { onEvent: vi.fn(), onStatusChange })

			await expect(getOnopen()(buildResponse(502, 'text/html'))).rejects.toThrow('SSE failed: 502')
			expect(onStatusChange).not.toHaveBeenCalledWith('connected')
		})

		it('rejects an ok response that is not an event stream', async () => {
			const onStatusChange = vi.fn()
			connectSSE(workspaceId, { onEvent: vi.fn(), onStatusChange })

			await expect(getOnopen()(buildResponse(200, 'text/html'))).rejects.toThrow('bad content-type')
			expect(onStatusChange).not.toHaveBeenCalledWith('connected')
		})

		it('rejects 401 and 403 as fatal', async () => {
			connectSSE(workspaceId, { onEvent: vi.fn() })
			await expect(getOnopen()(buildResponse(401))).rejects.toBeInstanceOf(SSEFatalError)

			vi.mocked(fetchEventSource).mockClear()
			connectSSE(workspaceId, { onEvent: vi.fn() })
			await expect(getOnopen()(buildResponse(403))).rejects.toBeInstanceOf(SSEFatalError)
		})
	})

	describe('onmessage callback', () => {
		function getOnmessage() {
			const call = vi.mocked(fetchEventSource).mock.calls[0]
			const opts = call[1] as {
				onmessage: (msg: { data: string; id: string; event?: string }) => void
			}
			return opts.onmessage
		}

		it('parses JSON data and calls onEvent', () => {
			const onEvent = vi.fn()
			connectSSE(workspaceId, { onEvent })

			const onmessage = getOnmessage()
			onmessage({
				data: JSON.stringify({ entity_type: 'object', entity_id: 'obj-1' }),
				id: 'evt-1',
				event: 'created',
			})

			expect(onEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'evt-1',
					action: 'created',
					entity_type: 'object',
					entity_id: 'obj-1',
				}),
			)
		})

		it('uses msg.event as action, falling back to parsed action', () => {
			const onEvent = vi.fn()
			connectSSE(workspaceId, { onEvent })

			const onmessage = getOnmessage()

			// msg.event takes precedence
			onmessage({
				data: JSON.stringify({ action: 'original' }),
				id: 'evt-1',
				event: 'overridden',
			})
			expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'overridden' }))

			// Falls back to parsed action when msg.event is empty
			onEvent.mockClear()
			onmessage({
				data: JSON.stringify({ action: 'fallback' }),
				id: 'evt-2',
				event: '',
			})
			expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'fallback' }))
		})

		it('stores last event ID in sessionStorage', () => {
			connectSSE(workspaceId, { onEvent: vi.fn() })

			const onmessage = getOnmessage()
			onmessage({
				data: JSON.stringify({ entity_type: 'object' }),
				id: 'evt-99',
			})

			expect(sessionStorage.getItem(`maskin-last-event-id-${workspaceId}`)).toBe('evt-99')
		})

		it('does not store event ID when msg.id is empty', () => {
			connectSSE(workspaceId, { onEvent: vi.fn() })

			const onmessage = getOnmessage()
			onmessage({
				data: JSON.stringify({ entity_type: 'object' }),
				id: '',
			})

			expect(sessionStorage.getItem(`maskin-last-event-id-${workspaceId}`)).toBeNull()
		})

		it('ignores messages with empty data', () => {
			const onEvent = vi.fn()
			connectSSE(workspaceId, { onEvent })

			const onmessage = getOnmessage()
			onmessage({ data: '', id: '' })

			expect(onEvent).not.toHaveBeenCalled()
		})

		it('ignores JSON parse errors without calling onEvent', () => {
			const onEvent = vi.fn()
			connectSSE(workspaceId, { onEvent })

			const onmessage = getOnmessage()
			onmessage({ data: 'not-json', id: 'evt-1' })

			expect(onEvent).not.toHaveBeenCalled()
		})

		it('does not catch errors thrown by onEvent', () => {
			const onEvent = vi.fn(() => {
				throw new Error('handler bug')
			})
			connectSSE(workspaceId, { onEvent })

			const onmessage = getOnmessage()
			expect(() => {
				onmessage({
					data: JSON.stringify({ entity_type: 'object' }),
					id: 'evt-1',
				})
			}).toThrow('handler bug')
		})
	})

	describe('onerror callback', () => {
		function getOnerror() {
			const call = vi.mocked(fetchEventSource).mock.calls[0]
			const opts = call[1] as { onerror: (err: unknown) => number }
			return opts.onerror
		}

		it('calls onStatusChange with disconnected and onError', () => {
			const onStatusChange = vi.fn()
			const onError = vi.fn()
			connectSSE(workspaceId, { onEvent: vi.fn(), onStatusChange, onError })

			const error = new Error('connection lost')
			getOnerror()(error)

			expect(onStatusChange).toHaveBeenCalledWith('disconnected')
			expect(onError).toHaveBeenCalledWith(error)
		})

		it('backs off exponentially so a downed backend is not retried every second', () => {
			connectSSE(workspaceId, { onEvent: vi.fn() })

			const onerror = getOnerror()
			const delays = [
				onerror(new Error('1')),
				onerror(new Error('2')),
				onerror(new Error('3')),
				onerror(new Error('4')),
			]

			expect(delays).toEqual([1000, 2000, 4000, 8000])
		})

		it('rethrows a fatal error so the subscription ends instead of looping on a revoked key', () => {
			const onError = vi.fn()
			connectSSE(workspaceId, { onEvent: vi.fn(), onError })

			const fatal = new SSEFatalError('unauthorized', 401)
			expect(() => getOnerror()(fatal)).toThrow(fatal)
			expect(onError).toHaveBeenCalledWith(fatal)
		})
	})
})
