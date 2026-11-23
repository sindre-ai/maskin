import { OpenAPIHono } from '@hono/zod-openapi'
import { events, integrations, ownerApprovals, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { createApiError } from '../../lib/errors'
import { isDineroPeriodLocked } from '../../lib/integrations/providers/dinero/review'
import {
	OWNER_APPROVAL_DINERO_BOOKS,
	findOwnerApprovals,
	recordOwnerApproval,
} from '../../lib/owner-approval'
import dineroReviewRoutes from '../../routes/dinero-review'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY ??= 'a'.repeat(64)
})
afterEach(() => vi.unstubAllGlobals())

function appFor(actorId: string, actorType: 'human' | 'agent' = 'human') {
	const app = new OpenAPIHono<{
		Variables: { db: typeof db; actorId: string; actorType: string }
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		await next()
	})
	app.onError((_e, c) => c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), 500))
	app.route('/api/dinero-review', dineroReviewRoutes)
	return app
}

const financeArgs = {
	organizationId: 7,
	date: '2026-11-10',
	book: true,
	lines: [
		{
			amount: 4000,
			description: 'Group entry',
			accountNumber: 1000,
			balancingAccountNumber: 55000,
		},
	],
}

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	const [dinero] = await db
		.insert(integrations)
		.values({
			workspaceId: ws.id,
			provider: 'dinero',
			status: 'active',
			credentials: encrypt(JSON.stringify({ accessToken: 'tok' })),
			createdBy: human,
		})
		.returning()
	if (!dinero) throw new Error('no integration')
	const [booked] = await db
		.insert(events)
		.values({
			workspaceId: ws.id,
			actorId: agent.id,
			action: 'dinero_action',
			entityType: 'integration',
			entityId: dinero.id,
			data: {
				tool: 'CreateFinanceVoucher',
				arguments: financeArgs,
				outcome: 'success',
				result: 'Voucher 1 booked',
			},
		})
		.returning({ id: events.id })
	if (!booked) throw new Error('no event')
	return { human, ws, agent, dinero, eventId: booked.id }
}

const today = () => new Date().toISOString().slice(0, 10)

const call = (
	app: ReturnType<typeof appFor>,
	ws: string,
	method: string,
	path: string,
	body?: unknown,
) =>
	app.request(`/api/dinero-review${path}`, {
		method,
		headers: { 'x-workspace-id': ws, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})

type Log = {
	items: Array<{
		event_id: number
		booked: boolean
		can_reverse: boolean
		reversed_by_event_id: number | null
	}>
	figures_hash: string
	approval: { approved_by: string } | null
}

describe('The Dinero review screen (Integration)', () => {
	it('shows the log of the period to a person who is an admin or owner', async () => {
		const s = await setup()
		const res = await call(appFor(s.human), s.ws.id, 'GET', `?from=${today()}&to=${today()}`)
		expect(res.status).toBe(200)
		const log = (await res.json()) as Log
		expect(log.items).toHaveLength(1)
		expect(log.items[0]).toMatchObject({ event_id: s.eventId, booked: true, can_reverse: true })
		expect(log.approval).toBeNull()
	})

	it('is refused for an agent', async () => {
		const s = await setup()
		const res = await call(appFor(s.agent.id, 'agent'), s.ws.id, 'GET')
		expect(res.status).toBe(403)
		expect(
			(
				await call(appFor(s.agent.id, 'agent'), s.ws.id, 'POST', '/approve', {
					from: today(),
					to: today(),
					figures_hash: 'x'.repeat(16),
				})
			).status,
		).toBe(403)
	})

	it('reverses a booked item with a counter-posting and a log line, and only once', async () => {
		const s = await setup()
		const sent: Array<Record<string, unknown>> = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				const body = JSON.parse(init.body as string)
				if (body.method === 'tools/call') sent.push(body.params.arguments)
				const answer = (id: number) =>
					`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Voucher 2 booked' }] } })}\n\n`
				return new Response(
					body.method === 'initialize' ? answer(1) : body.method === 'tools/call' ? answer(2) : '',
					{ status: 200 },
				)
			}),
		)
		const app = appFor(s.human)
		const res = await call(app, s.ws.id, 'POST', '/reverse', { event_id: s.eventId })
		expect(res.status).toBe(200)
		expect(((await res.json()) as { outcome: string }).outcome).toBe('success')
		expect(sent).toHaveLength(1)
		expect((sent[0]?.lines as Array<{ amount: number }>)[0]?.amount).toBe(-4000)

		const log = (await (
			await call(app, s.ws.id, 'GET', `?from=${today()}&to=${today()}`)
		).json()) as Log
		expect(log.items).toHaveLength(2)
		expect(log.items.find((i) => i.event_id === s.eventId)?.reversed_by_event_id).not.toBeNull()

		const again = await call(app, s.ws.id, 'POST', '/reverse', { event_id: s.eventId })
		expect(again.status).toBe(409)
		expect(sent).toHaveLength(1)
	})

	it('keeps the item un-reversed when Dinero refuses, and says so', async () => {
		const s = await setup()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				const body = JSON.parse(init.body as string)
				const id = body.method === 'tools/call' ? 2 : 1
				const isError = body.method === 'tools/call'
				return new Response(
					`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { isError, content: [{ type: 'text', text: 'Refused by Dinero' }] } })}\n\n`,
					{ status: 200 },
				)
			}),
		)
		const res = await call(appFor(s.human), s.ws.id, 'POST', '/reverse', { event_id: s.eventId })
		expect((await res.json()) as { outcome: string; message: string }).toMatchObject({
			outcome: 'error',
			message: 'Refused by Dinero',
		})
		const log = (await (
			await call(appFor(s.human), s.ws.id, 'GET', `?from=${today()}&to=${today()}`)
		).json()) as Log
		expect(log.items.find((i) => i.event_id === s.eventId)?.reversed_by_event_id).toBeNull()
	})

	it('writes one approval with a hash, locks the period, and refuses a stale hash', async () => {
		const s = await setup()
		const app = appFor(s.human)
		const path = `?from=${today()}&to=${today()}`
		const log = (await (await call(app, s.ws.id, 'GET', path)).json()) as Log

		const stale = await call(app, s.ws.id, 'POST', '/approve', {
			from: today(),
			to: today(),
			figures_hash: 'a'.repeat(64),
		})
		expect(stale.status).toBe(409)
		expect(await findOwnerApprovals(db, s.ws.id, OWNER_APPROVAL_DINERO_BOOKS)).toHaveLength(0)

		const ok = await call(app, s.ws.id, 'POST', '/approve', {
			from: today(),
			to: today(),
			figures_hash: log.figures_hash,
		})
		expect(ok.status).toBe(200)
		expect(((await ok.json()) as Log).approval?.approved_by).toBe(s.human)

		const rows = await db
			.select()
			.from(ownerApprovals)
			.where(
				and(
					eq(ownerApprovals.workspaceId, s.ws.id),
					eq(ownerApprovals.kind, OWNER_APPROVAL_DINERO_BOOKS),
				),
			)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ figuresHash: log.figures_hash, approvedBy: s.human })
		expect(
			await isDineroPeriodLocked(db, { workspaceId: s.ws.id, integrationId: s.dinero.id }),
		).toBe(true)

		// Closed: no reversal, no second approval.
		expect((await call(app, s.ws.id, 'POST', '/reverse', { event_id: s.eventId })).status).toBe(409)
		expect(
			(
				await call(app, s.ws.id, 'POST', '/approve', {
					from: today(),
					to: today(),
					figures_hash: log.figures_hash,
				})
			).status,
		).toBe(409)
	})

	it('does not lock for a period that has not come or has gone', async () => {
		const s = await setup()
		const app = appFor(s.human)
		const log = (await (
			await call(app, s.ws.id, 'GET', '?from=2026-01-01&to=2026-01-31')
		).json()) as Log
		await call(app, s.ws.id, 'POST', '/approve', {
			from: '2026-01-01',
			to: '2026-01-31',
			figures_hash: log.figures_hash,
		})
		expect(
			await isDineroPeriodLocked(db, { workspaceId: s.ws.id, integrationId: s.dinero.id }),
		).toBe(false)
	})

	it('sees a reversal made on a later day than the booking, and refuses a second click', async () => {
		const s = await setup()
		const yesterday = new Date(Date.now() - 86_400_000)
		await db.update(events).set({ createdAt: yesterday }).where(eq(events.id, s.eventId))
		const day = yesterday.toISOString().slice(0, 10)
		const sent: unknown[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				const body = JSON.parse(init.body as string)
				if (body.method === 'tools/call') sent.push(body.params.arguments)
				const answer = (id: number) =>
					`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Voucher 2 booked' }] } })}\n\n`
				return new Response(
					body.method === 'initialize' ? answer(1) : body.method === 'tools/call' ? answer(2) : '',
					{ status: 200 },
				)
			}),
		)
		const app = appFor(s.human)
		expect((await call(app, s.ws.id, 'POST', '/reverse', { event_id: s.eventId })).status).toBe(200)

		// The reversal is logged today. The view of yesterday still shows the item as reversed.
		const log = (await (await call(app, s.ws.id, 'GET', `?from=${day}&to=${day}`)).json()) as Log
		expect(log.items).toHaveLength(1)
		expect(log.items[0]).toMatchObject({ event_id: s.eventId, can_reverse: false })
		expect(log.items[0]?.reversed_by_event_id).not.toBeNull()

		// A second click is refused and nothing more goes to Dinero.
		expect((await call(app, s.ws.id, 'POST', '/reverse', { event_id: s.eventId })).status).toBe(409)
		expect(sent).toHaveLength(1)

		// The approved figures for that day carry the reversal, so the approval is not a stale one.
		const ok = await call(app, s.ws.id, 'POST', '/approve', {
			from: day,
			to: day,
			figures_hash: log.figures_hash,
		})
		expect(ok.status).toBe(200)
	})

	it('does not count a reversal Dinero refused, even on a later day', async () => {
		const s = await setup()
		const yesterday = new Date(Date.now() - 86_400_000)
		await db.update(events).set({ createdAt: yesterday }).where(eq(events.id, s.eventId))
		await db.insert(events).values({
			workspaceId: s.ws.id,
			actorId: s.human,
			action: 'dinero_action',
			entityType: 'integration',
			entityId: s.dinero.id,
			data: {
				tool: 'CreateFinanceVoucher',
				arguments: financeArgs,
				outcome: 'error',
				reverses_event_id: s.eventId,
			},
		})
		const day = yesterday.toISOString().slice(0, 10)
		const log = (await (
			await call(appFor(s.human), s.ws.id, 'GET', `?from=${day}&to=${day}`)
		).json()) as Log
		expect(log.items[0]).toMatchObject({ event_id: s.eventId, can_reverse: true })
		expect(log.items[0]?.reversed_by_event_id).toBeNull()
	})

	it('keeps one open approval per workspace, kind and subject', async () => {
		const s = await setup()
		const row = {
			workspaceId: s.ws.id,
			kind: OWNER_APPROVAL_DINERO_BOOKS,
			subject: `dinero:${s.dinero.id}:2026-11-01:2026-11-30`,
			figuresHash: 'a'.repeat(64),
			approvedBy: s.human,
		}
		await recordOwnerApproval(db, row)
		await expect(recordOwnerApproval(db, row)).rejects.toThrow()
		// Once used, the same subject can be approved again.
		await db
			.update(ownerApprovals)
			.set({ usedAt: new Date() })
			.where(eq(ownerApprovals.workspaceId, s.ws.id))
		await expect(recordOwnerApproval(db, row)).resolves.toMatchObject({ subject: row.subject })
	})
})
