import { type BridgeHost, handleBridgeMessage } from '@/lib/loop-view-bridge'
import {
	BRIDGE_QUERY_MESSAGE,
	BRIDGE_RESULT_MESSAGE,
	VIEWER_DOC_SIZE_MESSAGE,
} from '@/lib/mini-app'
import type { DataQuerySpec } from '@maskin/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const frame = { name: 'the view iframe window' }
const otherWindow = { name: 'some other window' }
const byStatus = { scope: 'workspace', type: 'task', group_by: 'status' } as DataQuerySpec

function makeHost(overrides: Partial<BridgeHost> = {}) {
	const host = {
		frameWindow: () => frame,
		isBlocked: () => false,
		sources: () => new Map([['by_status', byStatus]]),
		run: vi.fn().mockResolvedValue({ total: { count: 4, value: 4 } }),
		post: vi.fn(),
		onDocHeight: vi.fn(),
		onQueryError: vi.fn(),
		...overrides,
	} satisfies BridgeHost
	return host
}

const query = (name: unknown, id: unknown = 1) => ({
	type: BRIDGE_QUERY_MESSAGE,
	id,
	name,
})

describe('handleBridgeMessage', () => {
	let host: ReturnType<typeof makeHost>

	beforeEach(() => {
		host = makeHost()
	})

	it('runs a declared source as the viewer and posts the result back', async () => {
		await handleBridgeMessage(host, { source: frame, data: query('by_status', 7) })

		expect(host.run).toHaveBeenCalledWith(byStatus)
		expect(host.post).toHaveBeenCalledWith({
			type: BRIDGE_RESULT_MESSAGE,
			id: 7,
			data: { total: { count: 4, value: 4 } },
		})
	})

	it('answers an undeclared source with an error and never runs a query', async () => {
		await handleBridgeMessage(host, { source: frame, data: query('everything', 2) })

		expect(host.run).not.toHaveBeenCalled()
		expect(host.post).toHaveBeenCalledWith({
			type: BRIDGE_RESULT_MESSAGE,
			id: 2,
			error: expect.stringContaining('"everything" is not declared'),
		})
	})

	it('does not treat inherited object keys as declared sources', async () => {
		for (const name of ['constructor', '__proto__', 'toString']) {
			await handleBridgeMessage(host, { source: frame, data: query(name) })
		}
		expect(host.run).not.toHaveBeenCalled()
		expect(host.post).toHaveBeenCalledTimes(3)
	})

	it('ignores a message from any window other than the view iframe', async () => {
		await handleBridgeMessage(host, { source: otherWindow, data: query('by_status') })
		await handleBridgeMessage(host, { source: null, data: query('by_status') })

		expect(host.run).not.toHaveBeenCalled()
		expect(host.post).not.toHaveBeenCalled()
	})

	it('ignores everything when the iframe is gone', async () => {
		host = makeHost({ frameWindow: () => null })
		await handleBridgeMessage(host, { source: null, data: query('by_status') })
		expect(host.run).not.toHaveBeenCalled()
	})

	it('answers nothing once the frame has navigated away', async () => {
		host = makeHost({ isBlocked: () => true })
		await handleBridgeMessage(host, { source: frame, data: query('by_status') })
		await handleBridgeMessage(host, {
			source: frame,
			data: { type: VIEWER_DOC_SIZE_MESSAGE, h: 500 },
		})

		expect(host.run).not.toHaveBeenCalled()
		expect(host.post).not.toHaveBeenCalled()
		expect(host.onDocHeight).not.toHaveBeenCalled()
	})

	it('drops the reply when the frame navigates while the query is in flight', async () => {
		let blocked = false
		host = makeHost({
			isBlocked: () => blocked,
			run: vi.fn().mockImplementation(async () => {
				blocked = true
				return { total: { count: 1, value: 1 } }
			}),
		})
		await handleBridgeMessage(host, { source: frame, data: query('by_status') })
		expect(host.post).not.toHaveBeenCalled()
	})

	it('replies with the error and reports it when the query fails', async () => {
		host = makeHost({ run: vi.fn().mockRejectedValue(new Error('Loop not found')) })
		await handleBridgeMessage(host, { source: frame, data: query('by_status', 3) })

		expect(host.post).toHaveBeenCalledWith({
			type: BRIDGE_RESULT_MESSAGE,
			id: 3,
			error: 'Loop not found',
		})
		expect(host.onQueryError).toHaveBeenCalledWith('Loop not found')
	})

	it.each([
		['a missing id', { type: BRIDGE_QUERY_MESSAGE, name: 'by_status' }],
		['a non-numeric id', query('by_status', '1')],
		['a non-string name', query(42)],
		['an unknown type', { type: 'maskin:something-else', id: 1, name: 'by_status' }],
		['no payload', null],
		['a string payload', 'by_status'],
	])('ignores %s', async (_label, data) => {
		await handleBridgeMessage(host, { source: frame, data })
		expect(host.run).not.toHaveBeenCalled()
		expect(host.post).not.toHaveBeenCalled()
	})

	it('passes the reported document height on', async () => {
		await handleBridgeMessage(host, {
			source: frame,
			data: { type: VIEWER_DOC_SIZE_MESSAGE, w: 900, h: 640 },
		})
		expect(host.onDocHeight).toHaveBeenCalledWith(640)

		await handleBridgeMessage(host, {
			source: frame,
			data: { type: VIEWER_DOC_SIZE_MESSAGE, h: 0 },
		})
		expect(host.onDocHeight).toHaveBeenCalledTimes(1)
	})
})
