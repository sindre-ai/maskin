import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@microsoft/fetch-event-source', () => ({
	fetchEventSource: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
	getApiKey: vi.fn(() => 'test-api-key'),
}))

import { fetchEventSource } from '@microsoft/fetch-event-source'
import { connectSSE } from '@/lib/sse'

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
		sessionStorage.setItem(`ai-native-last-event-id-${workspaceId}`, 'evt-42')

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
		it('calls onStatusChange with connected', async () => {
			const onStatusChange = vi.fn()
			connectSSE(workspaceId, { onEvent: vi.fn(), onStatusChange })

			const call = vi.mocked(fetchEventSource).mock.calls[0]
			const opts = call[1] as { onopen: () => Promise<void> }
			await opts.onopen()

			expect(onStatusChange).toHaveBeenCalledWith('connected')
		})
	})

	describe('onmessage callback', () => {
		function getOnmessage() {
			const call = vi.mocked(fetchEventSource).mock.calls[0]
			const opts = call[1] as { onmessage: (msg: { data: string; id: string; event?: string }) => void }
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

			expect(sessionStorage.getItem(`ai-native-last-event-id-${workspaceId}`)).toBe('evt-99')
		})

		it('does not store event ID when msg.id is empty', () => {
			connectSSE(workspaceId, { onEvent: vi.fn() })

			const onmessage = getOnmessage()
			onmessage({
				data: JSON.stringify({ entity_type: 'object' }),
				id: '',
			})

			expect(sessionStorage.getItem(`ai-native-last-event-id-${workspaceId}`)).toBeNull()
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
		it('calls onStatusChange with disconnected and onError', () => {
			const onStatusChange = vi.fn()
			const onError = vi.fn()
			connectSSE(workspaceId, { onEvent: vi.fn(), onStatusChange, onError })

			const call = vi.mocked(fetchEventSource).mock.calls[0]
			const opts = call[1] as { onerror: (err: unknown) => void }
			const error = new Error('connection lost')
			opts.onerror(error)

			expect(onStatusChange).toHaveBeenCalledWith('disconnected')
			expect(onError).toHaveBeenCalledWith(error)
		})
	})
})
