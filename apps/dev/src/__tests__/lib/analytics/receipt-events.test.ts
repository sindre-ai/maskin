import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock, flowsOfSessionMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
	flowsOfSessionMock: vi.fn(),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))
vi.mock('../../../lib/session-flow', () => ({ flowsOfSession: flowsOfSessionMock }))

import {
	RECEIPT_DRAFT_BOOKED,
	countReceiptDraft,
	flowSlugOfSession,
	receiptDraftConnector,
	toolCallSucceeded,
	trackReceiptDraftBooked,
} from '../../../lib/analytics/receipt-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
	flowsOfSessionMock.mockReset()
})

describe('receiptDraftConnector', () => {
	const env = { DINERO_DRAFT_TOOLS: 'create_purchase_draft, other_draft' }

	it('names the connector for a draft-save tool on the vendor host', () => {
		expect(receiptDraftConnector('https://mcp.dinero.dk/', 'create_purchase_draft', env)).toBe(
			'dinero',
		)
		expect(receiptDraftConnector('https://MCP.dinero.dk/', 'other_draft', env)).toBe('dinero')
	})

	it('is null for any other tool, any other host, and when no tool is configured', () => {
		expect(receiptDraftConnector('https://mcp.dinero.dk/', 'list_contacts', env)).toBeNull()
		expect(receiptDraftConnector('https://tools.example.com/', 'create_purchase_draft', env)).toBe(
			null,
		)
		expect(receiptDraftConnector('https://mcp.dinero.dk/', 'create_purchase_draft', {})).toBeNull()
		expect(receiptDraftConnector('not a url', 'create_purchase_draft', env)).toBeNull()
	})
})

describe('toolCallSucceeded', () => {
	const ok = { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'saved' }] } }

	it('is true for a plain JSON result and for one in an event stream', () => {
		expect(toolCallSucceeded(JSON.stringify(ok), 7)).toBe(true)
		expect(toolCallSucceeded(`event: message\ndata: ${JSON.stringify(ok)}\n\n`, 7)).toBe(true)
	})

	it('is false for a tool error, a protocol error, another call, or text it cannot read', () => {
		expect(toolCallSucceeded(JSON.stringify({ ...ok, result: { isError: true } }), 7)).toBe(false)
		expect(
			toolCallSucceeded(JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: -1 } }), 7),
		).toBe(false)
		expect(toolCallSucceeded(JSON.stringify(ok), 8)).toBe(false)
		expect(toolCallSucceeded('{broken', 7)).toBe(false)
		expect(toolCallSucceeded('', 7)).toBe(false)
	})
})

describe('trackReceiptDraftBooked', () => {
	it('sends counts and ids only, with this exact key set', async () => {
		await trackReceiptDraftBooked({
			flowSlug: 'accounting-loop',
			connector: 'dinero',
			workspaceId: 'ws-1',
			actorId: 'agent-1',
		})
		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(RECEIPT_DRAFT_BOOKED, 'agent-1', {
			flow_slug: 'accounting-loop',
			connector: 'dinero',
			workspace_id: 'ws-1',
			actor_id: 'agent-1',
		})
		expect(RECEIPT_DRAFT_BOOKED).toBe('receipt_draft_booked')
	})
})

describe('flowSlugOfSession', () => {
	it('is null with no session or no flow, and never reads installs then', async () => {
		const db = { select: vi.fn() }
		const base = { workspaceId: 'ws-1', actorId: 'agent-1' }
		expect(await flowSlugOfSession(db as never, { ...base, sessionId: undefined })).toBeNull()
		flowsOfSessionMock.mockResolvedValue([])
		expect(await flowSlugOfSession(db as never, { ...base, sessionId: 's-1' })).toBeNull()
		expect(db.select).not.toHaveBeenCalled()
	})

	it('reads the slug of the installed flow the session runs under', async () => {
		flowsOfSessionMock.mockResolvedValue([{ id: 'flow-1', status: 'active' }])
		const chain: Record<string, unknown> = {}
		for (const m of ['from', 'innerJoin', 'where', 'orderBy']) chain[m] = () => chain
		chain.limit = async () => [{ slug: 'accounting-loop' }]
		const db = { select: () => chain }
		expect(
			await flowSlugOfSession(db as never, {
				workspaceId: 'ws-1',
				actorId: 'agent-1',
				sessionId: 's-1',
			}),
		).toBe('accounting-loop')
	})
})

describe('countReceiptDraft', () => {
	const answer = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
	const args = (upstream: Response) => ({
		db: { select: vi.fn() } as never,
		upstream,
		requestId: 1,
		connector: 'dinero',
		workspaceId: 'ws-1',
		actorId: 'agent-1',
		sessionId: undefined,
	})

	it('counts one event for a saved draft and leaves the answer readable for the agent', async () => {
		const upstream = answer({ jsonrpc: '2.0', id: 1, result: { content: [] } })
		await countReceiptDraft(args(upstream))
		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock.mock.calls[0]?.[2]).toMatchObject({
			connector: 'dinero',
			flow_slug: null,
			workspace_id: 'ws-1',
		})
		expect(await upstream.json()).toMatchObject({ id: 1 })
	})

	it('counts nothing for a failed tool, a protocol error or a non-2xx answer', async () => {
		await countReceiptDraft(args(answer({ jsonrpc: '2.0', id: 1, result: { isError: true } })))
		await countReceiptDraft(args(answer({ jsonrpc: '2.0', id: 1, error: { code: -32000 } })))
		await countReceiptDraft(args(answer({ jsonrpc: '2.0', id: 1, result: {} }, 500)))
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})
})
