import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaceMembers } from '@maskin/db/schema'
import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import type { WorkspaceSettings } from '../../lib/types'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

vi.mock('../../lib/stripe', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../../lib/stripe')>()
	return {
		...mod,
		readStripeEnv: () => ({}) as ReturnType<typeof mod.readStripeEnv>,
		getStripeClient: () => stripeMock as unknown as Stripe,
	}
})

// Stripe test double: invoices are keyed by customer, so a route that asked
// for the wrong customer would come back with the wrong workspace's invoices.
const invoicesByCustomer: Record<string, Array<Record<string, unknown>>> = {}
const stripeMock = {
	invoices: {
		list: vi.fn(async ({ customer }: { customer: string }) => ({
			data: invoicesByCustomer[customer] ?? [],
		})),
	},
}

const { default: billingRoutes } = await import('../../routes/billing')

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

type InvoiceRow = {
	id: string
	number: string | null
	created: number
	amount_cents: number
	currency: string
	status: string
	hosted_invoice_url: string | null
	invoice_pdf: string | null
}

function makeApp(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/billing', billingRoutes)
	return app
}

function invoice(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		number: `${id}-0001`,
		created: 1_700_000_000,
		total: 5000,
		currency: 'dkk',
		status: 'paid',
		hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
		invoice_pdf: `https://pay.stripe.com/invoice/${id}/pdf`,
		...overrides,
	}
}

const settingsFor = (customerId: string | undefined) =>
	({
		billing: {
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: 100_000,
			period_start: 1_700_000_000,
			...(customerId ? { stripe_customer_id: customerId } : {}),
		},
	}) as WorkspaceSettings

describe('GET /api/billing/invoices (Integration)', () => {
	let actorId: string

	beforeEach(() => {
		actorId = getTestActorId()
		for (const key of Object.keys(invoicesByCustomer)) delete invoicesByCustomer[key]
		stripeMock.invoices.list.mockClear()
	})

	async function get(app: ReturnType<typeof makeApp>, workspaceId: string) {
		return app.request(jsonGet('/api/billing/invoices', { 'x-workspace-id': workspaceId }))
	}

	it("lists the owner's own invoices in their own currency and never another workspace's", async () => {
		const mine = await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: settingsFor('cus_mine'),
		})
		await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: settingsFor('cus_other'),
		})
		invoicesByCustomer.cus_mine = [
			invoice('in_dkk', { currency: 'dkk', total: 34900 }),
			invoice('in_usd', { currency: 'usd', total: 5000, number: null }),
		]
		invoicesByCustomer.cus_other = [invoice('in_theirs')]

		const res = await get(makeApp(actorId), mine.id)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { invoices: InvoiceRow[] }
		expect(body.invoices.map((i) => i.id)).toEqual(['in_dkk', 'in_usd'])
		expect(body.invoices[0]).toEqual({
			id: 'in_dkk',
			number: 'in_dkk-0001',
			created: 1_700_000_000,
			amount_cents: 34900,
			currency: 'dkk',
			status: 'paid',
			hosted_invoice_url: 'https://invoice.stripe.com/i/in_dkk',
			invoice_pdf: 'https://pay.stripe.com/invoice/in_dkk/pdf',
		})
		expect(body.invoices[1].number).toBeNull()
		expect(stripeMock.invoices.list).toHaveBeenCalledTimes(1)
		expect(stripeMock.invoices.list.mock.calls[0][0]).toMatchObject({ customer: 'cus_mine' })
	})

	it('leaves draft invoices out', async () => {
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: settingsFor('cus_drafts'),
		})
		invoicesByCustomer.cus_drafts = [
			invoice('in_draft', { status: 'draft', hosted_invoice_url: null }),
			invoice('in_open', { status: 'open' }),
		]

		const res = await get(makeApp(actorId), ws.id)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { invoices: InvoiceRow[] }
		expect(body.invoices.map((i) => i.id)).toEqual(['in_open'])
	})

	it('returns an empty list, not an error, for a workspace with no Stripe customer', async () => {
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: settingsFor(undefined),
		})

		const res = await get(makeApp(actorId), ws.id)

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ invoices: [] })
		expect(stripeMock.invoices.list).not.toHaveBeenCalled()
	})

	it('returns 403 to a member, a viewer and an agent admin, and never asks Stripe', async () => {
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: settingsFor('cus_gated'),
		})
		invoicesByCustomer.cus_gated = [invoice('in_secret')]

		const member = await insertActor(db, { name: 'Member' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: member.id, role: 'member' })
		const viewer = await insertActor(db, { name: 'Viewer' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: viewer.id, role: 'viewer' })
		const agentAdmin = await insertActor(db, { type: 'agent', name: 'Admin agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agentAdmin.id, role: 'admin' })

		for (const id of [member.id, viewer.id, agentAdmin.id]) {
			const res = await get(makeApp(id), ws.id)
			expect(res.status).toBe(403)
		}
		expect(stripeMock.invoices.list).not.toHaveBeenCalled()
	})

	it('returns 403 to an admin of a different workspace, whose own invoices stay separate', async () => {
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: settingsFor('cus_a'),
		})
		const outsider = await insertActor(db, { name: 'Outsider' })
		await insertWorkspace(db, outsider.id, {
			enterpriseGranted: false,
			settings: settingsFor('cus_b'),
		})
		invoicesByCustomer.cus_a = [invoice('in_a')]

		const res = await get(makeApp(outsider.id), ws.id)

		expect(res.status).toBe(403)
	})

	it('returns 404 for a workspace that does not exist', async () => {
		const res = await get(makeApp(actorId), '00000000-0000-4000-8000-000000000000')
		expect(res.status).toBe(404)
	})

	it('returns 500 when Stripe fails, without leaking the error', async () => {
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: settingsFor('cus_boom'),
		})
		stripeMock.invoices.list.mockRejectedValueOnce(new Error('stripe is down: sk_test_secret'))

		const res = await get(makeApp(actorId), ws.id)

		expect(res.status).toBe(500)
		expect(JSON.stringify(await res.json())).not.toContain('sk_test_secret')
	})
})
