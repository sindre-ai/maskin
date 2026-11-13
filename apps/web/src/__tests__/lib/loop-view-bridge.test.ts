import { type BridgeHost, handleBridgeMessage } from '@/lib/loop-view-bridge'
import {
	BRIDGE_OPEN_MESSAGE,
	BRIDGE_PROPOSE_MESSAGE,
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

	it('reports the needed width only when the content is wider than the frame', async () => {
		const onDocOverflow = vi.fn()
		const overflowHost = { ...host, onDocOverflow }
		await handleBridgeMessage(overflowHost, {
			source: frame,
			data: { type: VIEWER_DOC_SIZE_MESSAGE, w: 900, cw: 900, h: 640 },
		})
		expect(onDocOverflow).not.toHaveBeenCalled()

		await handleBridgeMessage(overflowHost, {
			source: frame,
			data: { type: VIEWER_DOC_SIZE_MESSAGE, w: 1400, cw: 900, h: 640 },
		})
		expect(onDocOverflow).toHaveBeenCalledWith(1400)
	})
})

describe('handleBridgeMessage: open', () => {
	const objectId = '6215098e-4739-418c-80a3-fc844ea0e23b'
	const open = (id: unknown) => ({ type: BRIDGE_OPEN_MESSAGE, id })
	let onOpen: ReturnType<typeof vi.fn>
	let host: ReturnType<typeof makeHost>

	beforeEach(() => {
		onOpen = vi.fn()
		host = makeHost({ onOpen })
	})

	it('takes the viewer to the object when the frame asks with a UUID', async () => {
		await handleBridgeMessage(host, { source: frame, data: open(objectId) })

		expect(onOpen).toHaveBeenCalledTimes(1)
		expect(onOpen).toHaveBeenCalledWith(objectId)
		expect(host.run).not.toHaveBeenCalled()
		expect(host.post).not.toHaveBeenCalled()
	})

	it('ignores anything that is not a UUID, such as web addresses and paths', async () => {
		for (const id of [
			'https://example.com',
			'javascript:alert(1)',
			'/some/path',
			`${objectId}/../x`,
			`x${objectId}`,
			'',
			7,
			null,
			undefined,
			{ toString: () => objectId },
		]) {
			await handleBridgeMessage(host, { source: frame, data: open(id) })
		}
		expect(onOpen).not.toHaveBeenCalled()
	})

	it('ignores an open from any window other than the view iframe', async () => {
		await handleBridgeMessage(host, { source: otherWindow, data: open(objectId) })
		await handleBridgeMessage(host, { source: null, data: open(objectId) })

		expect(onOpen).not.toHaveBeenCalled()
	})

	it('ignores an open once the frame has navigated away', async () => {
		host = makeHost({ onOpen, isBlocked: () => true })
		await handleBridgeMessage(host, { source: frame, data: open(objectId) })

		expect(onOpen).not.toHaveBeenCalled()
	})

	it('ignores an open when the host has no way to open', async () => {
		host = makeHost()
		await expect(
			handleBridgeMessage(host, { source: frame, data: open(objectId) }),
		).resolves.toBeUndefined()
	})
})

describe('handleBridgeMessage: list sources', () => {
	const opps = {
		list: 'opportunities' as const,
		statuses: ['opportunity'],
		maxRows: 200,
		updatedWithinDays: null,
	}
	const rows = [{ id: 'bet-1', title: 'One' }]

	function makeListHost(overrides: Partial<BridgeHost> = {}) {
		return makeHost({
			allowLists: true,
			listSources: () =>
				new Map([
					['opps', opps],
					['bad', null],
				]),
			listAnswer: vi.fn().mockReturnValue({ rows, fetchedAt: 5 }),
			...overrides,
		})
	}

	it('answers a declared list from what the host holds, and never runs a query', async () => {
		const host = makeListHost()

		await handleBridgeMessage(host, { source: frame, data: query('opps', 3) })

		expect(host.listAnswer).toHaveBeenCalledWith('opps', opps)
		expect(host.run).not.toHaveBeenCalled()
		expect(host.post).toHaveBeenCalledWith({
			type: BRIDGE_RESULT_MESSAGE,
			id: 3,
			data: { rows, fetchedAt: 5 },
		})
	})

	it('passes on "not refreshed" before the first click, with no rows', async () => {
		const host = makeListHost({
			listAnswer: vi.fn().mockReturnValue({ rows: null, notRefreshed: true }),
		})

		await handleBridgeMessage(host, { source: frame, data: query('opps', 4) })

		expect(host.post).toHaveBeenCalledWith({
			type: BRIDGE_RESULT_MESSAGE,
			id: 4,
			data: { rows: null, notRefreshed: true },
		})
	})

	it('waits for a host that fetches, then posts the rows', async () => {
		const host = makeListHost({
			listAnswer: vi.fn().mockResolvedValue({ rows, fetchedAt: 9 }),
		})

		await handleBridgeMessage(host, { source: frame, data: query('opps', 8) })

		expect(host.post).toHaveBeenCalledWith({
			type: BRIDGE_RESULT_MESSAGE,
			id: 8,
			data: { rows, fetchedAt: 9 },
		})
	})

	it('posts the error, and reports it, when the host cannot fetch the rows', async () => {
		const host = makeListHost({ listAnswer: vi.fn().mockRejectedValue(new Error('boom')) })

		await handleBridgeMessage(host, { source: frame, data: query('opps', 9) })

		expect(host.post).toHaveBeenCalledWith({ type: BRIDGE_RESULT_MESSAGE, id: 9, error: 'boom' })
		expect(host.onQueryError).toHaveBeenCalledWith('boom')
	})

	it('posts nothing when the frame navigated away while the rows were coming', async () => {
		let blocked = false
		const host = makeListHost({
			isBlocked: () => blocked,
			listAnswer: vi.fn().mockImplementation(async () => {
				blocked = true
				return { rows, fetchedAt: 9 }
			}),
		})

		await handleBridgeMessage(host, { source: frame, data: query('opps', 10) })

		expect(host.post).not.toHaveBeenCalled()
	})

	it('refuses every list when the host does not allow lists', async () => {
		const host = makeListHost({ allowLists: false })

		await handleBridgeMessage(host, { source: frame, data: query('opps', 5) })

		expect(host.listAnswer).not.toHaveBeenCalled()
		expect(host.run).not.toHaveBeenCalled()
		expect(host.post).toHaveBeenCalledWith({
			type: BRIDGE_RESULT_MESSAGE,
			id: 5,
			error: "This view asks for data the app doesn't offer",
		})
	})

	it('refuses a list the app does not offer', async () => {
		const host = makeListHost()

		await handleBridgeMessage(host, { source: frame, data: query('bad', 6) })

		expect(host.listAnswer).not.toHaveBeenCalled()
		expect(host.post).toHaveBeenCalledWith({
			type: BRIDGE_RESULT_MESSAGE,
			id: 6,
			error: "This view asks for data the app doesn't offer",
		})
	})

	it('still answers a count source the usual way next to lists', async () => {
		const host = makeListHost()

		await handleBridgeMessage(host, { source: frame, data: query('by_status', 7) })

		expect(host.run).toHaveBeenCalledWith(byStatus)
		expect(host.listAnswer).not.toHaveBeenCalled()
	})

	it('ignores a list ask from any window other than the view iframe', async () => {
		const host = makeListHost()

		await handleBridgeMessage(host, { source: otherWindow, data: query('opps') })

		expect(host.listAnswer).not.toHaveBeenCalled()
		expect(host.post).not.toHaveBeenCalled()
	})

	it('answers nothing once the frame is blocked', async () => {
		const host = makeListHost({ isBlocked: () => true })

		await handleBridgeMessage(host, { source: frame, data: query('opps') })

		expect(host.listAnswer).not.toHaveBeenCalled()
		expect(host.post).not.toHaveBeenCalled()
	})
})

describe('handleBridgeMessage: propose', () => {
	const objectId = '6215098e-4739-418c-80a3-fc844ea0e23b'
	const propose = (id: unknown, field: unknown, value: unknown) => ({
		type: BRIDGE_PROPOSE_MESSAGE,
		id,
		field,
		value,
	})
	let onPropose: ReturnType<typeof vi.fn>
	let host: ReturnType<typeof makeHost>

	beforeEach(() => {
		onPropose = vi.fn()
		host = makeHost({
			onPropose,
			proposableFields: () => new Set(['scheduled_date', 'post_time']),
			hasItem: (id) => id === objectId,
		})
	})

	it('passes on a proposal for a given item, a declared field and a value of the right shape', async () => {
		await handleBridgeMessage(host, {
			source: frame,
			data: propose(objectId, 'scheduled_date', '2026-11-14'),
		})
		await handleBridgeMessage(host, {
			source: frame,
			data: propose(objectId, 'post_time', '09:30'),
		})

		expect(onPropose).toHaveBeenCalledTimes(2)
		expect(onPropose).toHaveBeenNthCalledWith(1, {
			id: objectId,
			field: 'scheduled_date',
			value: '2026-11-14',
		})
		expect(host.run).not.toHaveBeenCalled()
		expect(host.post).not.toHaveBeenCalled()
	})

	it('ignores a field the view did not declare or the app does not allow', async () => {
		for (const field of ['status', 'title', 'content', 'account', 'driver', '', 5]) {
			await handleBridgeMessage(host, { source: frame, data: propose(objectId, field, 'done') })
		}
		const onlyDate = makeHost({
			onPropose,
			proposableFields: () => new Set(['scheduled_date']),
			hasItem: () => true,
		})
		await handleBridgeMessage(onlyDate, {
			source: frame,
			data: propose(objectId, 'post_time', '09:30'),
		})

		expect(onPropose).not.toHaveBeenCalled()
	})

	it('ignores a value that is not a real day or time', async () => {
		for (const [field, value] of [
			['scheduled_date', '2026-02-31'],
			['scheduled_date', '14 Nov'],
			['scheduled_date', '2026-11-14T10:00:00Z'],
			['scheduled_date', 20261114],
			['post_time', '25:00'],
			['post_time', '9:30'],
			['post_time', 'soon'],
		] as const) {
			await handleBridgeMessage(host, { source: frame, data: propose(objectId, field, value) })
		}

		expect(onPropose).not.toHaveBeenCalled()
	})

	it('ignores an id that is not a UUID or not an item the view was given', async () => {
		const other = '11111111-1111-4111-8111-111111111111'
		for (const id of ['https://example.com', '', `x${objectId}`, 7, other]) {
			await handleBridgeMessage(host, { source: frame, data: propose(id, 'post_time', '09:30') })
		}

		expect(onPropose).not.toHaveBeenCalled()
	})

	it('ignores a proposal from another window, or from a frame that navigated away', async () => {
		const data = propose(objectId, 'post_time', '09:30')
		await handleBridgeMessage(host, { source: otherWindow, data })
		await handleBridgeMessage({ ...host, isBlocked: () => true }, { source: frame, data })

		expect(onPropose).not.toHaveBeenCalled()
	})

	it('ignores every proposal when the host has no confirm step', async () => {
		const noConfirm = makeHost({
			proposableFields: () => new Set(['post_time']),
			hasItem: () => true,
		})
		await handleBridgeMessage(noConfirm, {
			source: frame,
			data: propose(objectId, 'post_time', '09:30'),
		})

		expect(noConfirm.post).not.toHaveBeenCalled()
		expect(noConfirm.run).not.toHaveBeenCalled()
	})
})
