import { createHmac } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, files, receiptIntakeKeys, receiptIntakes, relationships } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintEmailToken, mintIntakeKey } from '../../lib/receipt-intake/policy'
import { receiptUploadApp, receiptWebhookApp } from '../../routes/receipt-intake'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db } from './global-setup'

/**
 * The receipt routes against real Postgres. Resend is stubbed at fetch and storage is an in-memory
 * map, so this proves our rules (who is read, what is stored, what wakes an agent), not that Resend
 * behaves as assumed, which needs a real test mail once the receiving domain exists.
 */

const SECRET_RAW = Buffer.from('receipt-intake-test-secret')
const WEBHOOK_SECRET = `whsec_${SECRET_RAW.toString('base64')}`
const DOMAIN = 'receipts.example.test'
const PDF = Buffer.from('%PDF-1.4\nfake receipt')

const fetchMock = vi.fn()

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock)
	vi.stubEnv('RECEIPT_INTAKE_DOMAIN', DOMAIN)
	vi.stubEnv('RECEIPT_INTAKE_WEBHOOK_SECRET', WEBHOOK_SECRET)
	vi.stubEnv('RECEIPT_INTAKE_RESEND_API_KEY', 're_test')
})

afterEach(() => {
	fetchMock.mockReset()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

function appFor(blobs: Map<string, Buffer>) {
	const storage = {
		put: async (key: string, bytes: Buffer) => {
			blobs.set(key, bytes)
		},
	} as unknown as StorageProvider
	const app = new OpenAPIHono<{ Variables: { db: Database; storageProvider: StorageProvider } }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('storageProvider', storage)
		await next()
	})
	app.route('/api/receipt-intake', receiptUploadApp as never)
	app.route('/api/webhooks', receiptWebhookApp as never)
	return app
}

async function setup(overrides: Record<string, unknown> = {}) {
	const owner = await insertActor(db, { email: `owner-${crypto.randomUUID()}@firm.test` })
	const workspace = await insertWorkspace(db, owner.id)
	const loop = await insertObject(db, workspace.id, owner.id, { type: 'loop', status: 'active' })
	const token = mintEmailToken()
	const [intake] = await db
		.insert(receiptIntakes)
		.values({
			workspaceId: workspace.id,
			loopObjectId: loop.id,
			createdBy: owner.id,
			emailToken: token,
			emailEnabled: true,
			...overrides,
		})
		.returning()
	if (!intake) throw new Error('intake insert returned no row')
	return { owner, workspace, loop, intake, token }
}

async function receiptEvents(workspaceId: string) {
	return db
		.select()
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityType, 'receipt'),
				eq(events.action, 'received'),
			),
		)
}

describe('command route', () => {
	const upload = (
		app: ReturnType<typeof appFor>,
		key: string | null,
		bytes: Buffer,
		name = 'r.pdf',
	) => {
		const form = new FormData()
		form.set('file', new File([bytes], name))
		return app.request('/api/receipt-intake/upload', {
			method: 'POST',
			headers: key ? { Authorization: `Bearer ${key}` } : {},
			body: form,
		})
	}

	it('saves a receipt as a file in the flow, with one event, and shows the key as used', async () => {
		const blobs = new Map<string, Buffer>()
		const { workspace, loop, intake } = await setup()
		const minted = mintIntakeKey()
		await db
			.insert(receiptIntakeKeys)
			.values({ intakeId: intake.id, keyHash: minted.hash, last4: minted.last4 })

		const res = await upload(appFor(blobs), minted.key, PDF)
		expect(res.status).toBe(201)

		const [file] = await db.select().from(files).where(eq(files.workspaceId, workspace.id))
		expect(file?.kind).toBe('receipt')
		expect(file?.mimeType).toBe('application/pdf')
		expect(file?.tags).toEqual(
			expect.arrayContaining([
				'receipt',
				'source:command',
				expect.stringMatching(/^month:\d{4}-\d{2}$/),
			]),
		)
		expect(blobs.get(file?.storageKey ?? '')?.equals(PDF)).toBe(true)

		const [edge] = await db
			.select()
			.from(relationships)
			.where(and(eq(relationships.sourceId, loop.id), eq(relationships.targetId, file?.id ?? '')))
		expect(edge?.type).toBe('attached')

		const evs = await receiptEvents(workspace.id)
		expect(evs).toHaveLength(1)
		expect(JSON.stringify(evs[0]?.data)).not.toContain('r.pdf')

		const [key] = await db
			.select()
			.from(receiptIntakeKeys)
			.where(eq(receiptIntakeKeys.intakeId, intake.id))
		expect(key?.lastUsedAt).not.toBeNull()
	})

	it('refuses a missing, unknown or revoked key and stores nothing', async () => {
		const blobs = new Map<string, Buffer>()
		const { workspace, intake } = await setup()
		const revoked = mintIntakeKey()
		await db.insert(receiptIntakeKeys).values({
			intakeId: intake.id,
			keyHash: revoked.hash,
			last4: revoked.last4,
			revokedAt: new Date(),
		})
		const app = appFor(blobs)
		expect((await upload(app, null, PDF)).status).toBe(401)
		expect((await upload(app, mintIntakeKey().key, PDF)).status).toBe(401)
		expect((await upload(app, revoked.key, PDF)).status).toBe(401)
		expect(await db.select().from(files).where(eq(files.workspaceId, workspace.id))).toHaveLength(0)
		expect(blobs.size).toBe(0)
		expect(await receiptEvents(workspace.id)).toHaveLength(0)
	})

	it('refuses a file that is not a receipt and records no event', async () => {
		const { workspace, intake } = await setup()
		const minted = mintIntakeKey()
		await db
			.insert(receiptIntakeKeys)
			.values({ intakeId: intake.id, keyHash: minted.hash, last4: minted.last4 })
		const res = await upload(appFor(new Map()), minted.key, Buffer.from('<html></html>'), 'r.pdf')
		expect(res.status).toBe(400)
		expect(await receiptEvents(workspace.id)).toHaveLength(0)
	})

	it('stops at the daily cap', async () => {
		const { workspace, intake } = await setup({
			dayUtc: new Date().toISOString().slice(0, 10),
			dayCount: 50,
		})
		const minted = mintIntakeKey()
		await db
			.insert(receiptIntakeKeys)
			.values({ intakeId: intake.id, keyHash: minted.hash, last4: minted.last4 })
		const res = await upload(appFor(new Map()), minted.key, PDF)
		expect(res.status).toBe(429)
		expect(await receiptEvents(workspace.id)).toHaveLength(0)
	})
})

describe('email webhook', () => {
	function signed(body: unknown) {
		const raw = JSON.stringify(body)
		const id = `msg_${crypto.randomUUID()}`
		const ts = String(Math.floor(Date.now() / 1000))
		const sig = createHmac('sha256', SECRET_RAW).update(`${id}.${ts}.${raw}`).digest('base64')
		return {
			raw,
			headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
		}
	}
	const post = (
		app: ReturnType<typeof appFor>,
		body: unknown,
		headers?: Record<string, string>,
	) => {
		const s = signed(body)
		return app.request('/api/webhooks/receipt-intake/email', {
			method: 'POST',
			headers: headers ?? s.headers,
			body: s.raw,
		})
	}
	const json = (body: unknown) =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		})

	function stubResend(opts: { from: string; dmarc: string }) {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.endsWith('/attachments/att-1')) {
				return json({ download_url: 'https://cdn.resend.app/receiving/att-1' })
			}
			if (url.startsWith('https://cdn.resend.app/')) return new Response(PDF, { status: 200 })
			return json({
				from: opts.from,
				authentication: { spf: 'pass', dkim: 'pass', dmarc: opts.dmarc },
				attachments: [{ id: 'att-1', filename: 'receipt.pdf', size: PDF.length }],
			})
		})
	}
	const payload = (token: string, from: string, emailId = `email-${crypto.randomUUID()}`) => ({
		type: 'email.received',
		data: { email_id: emailId, from, to: [`${token}@${DOMAIN}`] },
	})

	it('refuses a delivery that is not signed', async () => {
		const { token } = await setup()
		const res = await post(appFor(new Map()), payload(token, 'x@y.test'), { 'svix-id': 'a' })
		expect(res.status).toBe(401)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('saves a receipt from the owner and wakes an agent once, even when delivered twice', async () => {
		const { owner, workspace, token } = await setup()
		stubResend({ from: owner.email as string, dmarc: 'pass' })
		const app = appFor(new Map())
		const body = payload(token, owner.email as string, 'email-fixed')
		expect((await post(app, body)).status).toBe(200)
		expect((await post(app, body)).status).toBe(200)
		expect(await receiptEvents(workspace.id)).toHaveLength(1)
		const [file] = await db.select().from(files).where(eq(files.workspaceId, workspace.id))
		expect(file?.description).toContain(owner.email as string)
		expect(file?.tags).toContain('source:email')
	})

	it('holds mail from a stranger, reads nothing and starts no agent', async () => {
		const { workspace, token, intake } = await setup()
		const res = await post(appFor(new Map()), payload(token, 'eve@evil.test'))
		expect(res.status).toBe(200)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await receiptEvents(workspace.id)).toHaveLength(0)
		const [row] = await db.select().from(receiptIntakes).where(eq(receiptIntakes.id, intake.id))
		expect(row?.heldCount).toBe(1)
	})

	it('holds mail that claims the owner as sender but fails the sender check', async () => {
		const { owner, workspace, token } = await setup()
		stubResend({ from: owner.email as string, dmarc: 'fail' })
		expect((await post(appFor(new Map()), payload(token, owner.email as string))).status).toBe(200)
		expect(await receiptEvents(workspace.id)).toHaveLength(0)
		expect(await db.select().from(files).where(eq(files.workspaceId, workspace.id))).toHaveLength(0)
	})

	it('drops mail to a switched-off address and to a replaced one, without reading it', async () => {
		const off = await setup({ emailEnabled: false })
		const app = appFor(new Map())
		expect((await post(app, payload(off.token, off.owner.email as string))).status).toBe(200)
		const old = await setup()
		await db
			.update(receiptIntakes)
			.set({ emailToken: mintEmailToken() })
			.where(eq(receiptIntakes.id, old.intake.id))
		expect((await post(app, payload(old.token, old.owner.email as string))).status).toBe(200)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await receiptEvents(off.workspace.id)).toHaveLength(0)
		expect(await receiptEvents(old.workspace.id)).toHaveLength(0)
	})
})
