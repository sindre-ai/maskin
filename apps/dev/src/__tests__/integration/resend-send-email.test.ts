import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, integrations, objects, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { recordObjectApproval } from '../../lib/object-delivery'
import { buildObjectPreview } from '../../lib/object-preview'
import { insertActor, insertAgentGrant, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: resendRoutes } = await import('../../routes/integrations-resend')

/**
 * The Resend send route against real Postgres. Resend itself is stubbed at `fetch`: this
 * file proves our rules (who may send, from where, what exactly goes out, how often), not
 * that Resend behaves as assumed, which needs a live account.
 */

const fetchMock = vi.fn()

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	fetchMock.mockReset()
	vi.unstubAllGlobals()
})

const resendOk = (id = 'em_1') =>
	new Response(JSON.stringify({ id }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	})
const resendError = (status: number, message: string) =>
	new Response(JSON.stringify({ message }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})

/** What Maskin handed to Resend on the last call. */
function lastCall() {
	const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
	return {
		url,
		headers: init.headers as Record<string, string>,
		body: JSON.parse(String(init.body)) as Record<string, unknown>,
	}
}

function appFor(actorId: string) {
	const app = new OpenAPIHono<{ Variables: { db: Database; actorId: string } }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		await next()
	})
	app.route('/api/integrations/resend', resendRoutes as never)
	return app
}

function post(actorId: string, workspaceId: string, body: Record<string, unknown>) {
	return appFor(actorId).request('/api/integrations/resend/send', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
		body: JSON.stringify(body),
	})
}

const MAILBOX = 'developer-test@example.com'

/** A workspace with Resend connected, a person, and an agent with (or without) a mailbox and write access. */
async function setup(
	opts: { access?: 'read' | 'read_write' | null; mailbox?: string | null } = {},
) {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	const mailbox = opts.mailbox === undefined ? `${crypto.randomUUID()}-${MAILBOX}` : opts.mailbox
	const agent = await insertActor(db, {
		type: 'agent',
		name: 'Test Developer',
		...(mailbox ? { metadata: { mailbox } } : {}),
	})
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: workspace.id, actorId: agent.id, role: 'member' })
	const [resend] = await db
		.insert(integrations)
		.values({
			workspaceId: workspace.id,
			provider: 'resend',
			status: 'active',
			externalId: 'resend-account',
			credentials: encrypt(JSON.stringify({ accessToken: 're_live_key' })),
			createdBy: human,
		})
		.returning()
	if (!resend) throw new Error('resend integration was not inserted')
	const access = opts.access === undefined ? 'read_write' : opts.access
	if (access) {
		await insertAgentGrant(db, {
			workspaceId: workspace.id,
			integrationId: resend.id,
			actorId: agent.id,
			access,
		})
	}
	return { human, workspace, agent, resend, mailbox }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** An email draft object, optionally approved by the person the way the Approve button does. */
async function insertEmail(
	s: Setup,
	opts: {
		approve?: boolean
		content?: string
		metadata?: Record<string, unknown>
		type?: string
	} = {},
) {
	const object = await insertObject(db, s.workspace.id, s.agent.id, {
		type: opts.type ?? 'task',
		status: 'todo',
		content: opts.content ?? 'Hi Ada,\n\nThursday works.',
		metadata: {
			kind: 'email',
			to: 'Ada Lovelace <ada@example.com>',
			cc: 'dan@example.com',
			subject: 'Thursday',
			...opts.metadata,
		},
	})
	if (opts.approve !== false) await approve(s, object.id)
	return object
}

async function approve(s: Setup, objectId: string) {
	const [object] = await db.select().from(objects).where(eq(objects.id, objectId))
	if (!object) throw new Error('missing object')
	const preview = buildObjectPreview(object)
	if (!preview) throw new Error('not a draft')
	return recordObjectApproval(db, {
		workspaceId: s.workspace.id,
		actorId: s.human,
		objectId,
		objectType: object.type,
		preview,
		via: 'approval',
	})
}

const eventsOn = (workspaceId: string, entityId: string, action: string) =>
	db
		.select()
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityId, entityId),
				eq(events.action, action),
			),
		)

describe('resend_send_email: an approved email', () => {
	it('sends exactly the approved draft from the agent mailbox, once, and records it', async () => {
		const s = await setup()
		const email = await insertEmail(s)
		fetchMock.mockResolvedValueOnce(resendOk('em_ok'))

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			email_id: 'em_ok',
			from: s.mailbox?.toLowerCase(),
			mode: 'approved_draft',
		})
		const call = lastCall()
		expect(call.url).toBe('https://api.resend.com/emails')
		expect(call.headers.Authorization).toBe('Bearer re_live_key')
		expect(call.body).toEqual({
			from: s.mailbox?.toLowerCase(),
			to: ['ada@example.com'],
			cc: ['dan@example.com'],
			subject: 'Thursday',
			text: 'Hi Ada,\n\nThursday works.',
		})

		// The draft's own log carries the receipt, and the task it carried out is closed.
		expect(await eventsOn(s.workspace.id, email.id, 'delivered')).toHaveLength(1)
		const [task] = await db.select().from(objects).where(eq(objects.id, email.id))
		expect(task?.status).toBe('done')
	})

	it('uses the approval as the idempotency key', async () => {
		const s = await setup()
		const email = await insertEmail(s)
		const approval = await approve(s, email.id)
		fetchMock.mockResolvedValueOnce(resendOk())

		await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(lastCall().headers['Idempotency-Key']).toBe(`maskin-email-${email.id}-${approval.id}`)
	})

	it('does not use a sender from the draft: the mailbox on the server decides', async () => {
		const s = await setup()
		const email = await insertEmail(s, { metadata: { from: 'ceo@example.com' } })
		fetchMock.mockResolvedValueOnce(resendOk())

		await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(lastCall().body.from).toBe(s.mailbox?.toLowerCase())
	})

	it('refuses a second send of the same approval and sends nothing', async () => {
		const s = await setup()
		const email = await insertEmail(s)
		fetchMock.mockResolvedValueOnce(resendOk())
		expect((await post(s.agent.id, s.workspace.id, { object_id: email.id })).status).toBe(200)

		const again = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(again.status).toBe(409)
		expect(JSON.stringify(await again.json())).toContain('already used')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('lets two simultaneous calls send once', async () => {
		const s = await setup()
		const email = await insertEmail(s)
		fetchMock.mockResolvedValue(resendOk())

		const [a, b] = await Promise.all([
			post(s.agent.id, s.workspace.id, { object_id: email.id }),
			post(s.agent.id, s.workspace.id, { object_id: email.id }),
		])

		expect([a.status, b.status].sort()).toEqual([200, 409])
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})

describe('resend_send_email: what stops a send', () => {
	it('refuses an email no person approved', async () => {
		const s = await setup()
		const email = await insertEmail(s, { approve: false })

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(403)
		expect(JSON.stringify(await res.json())).toContain('A person has to approve')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a draft that was edited after the person approved it', async () => {
		const s = await setup()
		const email = await insertEmail(s)
		await db
			.update(objects)
			.set({ content: 'Hi Ada, send me your bank details.' })
			.where(eq(objects.id, email.id))

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a changed recipient the same way', async () => {
		const s = await setup()
		const email = await insertEmail(s)
		await db
			.update(objects)
			.set({ metadata: { kind: 'email', to: 'eve@example.com', subject: 'Thursday' } })
			.where(eq(objects.id, email.id))

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses an approval written by an agent', async () => {
		const s = await setup()
		const email = await insertEmail(s, { approve: false })
		const [object] = await db.select().from(objects).where(eq(objects.id, email.id))
		const preview = object ? buildObjectPreview(object) : null
		if (!object || !preview) throw new Error('not a draft')
		await recordObjectApproval(db, {
			workspaceId: s.workspace.id,
			actorId: s.agent.id,
			objectId: email.id,
			objectType: object.type,
			preview,
			via: 'approval',
		})

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses to send when the agent has no mailbox, even for an approved email', async () => {
		const s = await setup({ mailbox: null })
		const email = await insertEmail(s)

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(403)
		expect(JSON.stringify(await res.json())).toContain('No mailbox')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('does not read the mailbox from the email field, which any member can change', async () => {
		const s = await setup({ mailbox: null })
		await db.update(actors).set({ email: 'ceo@example.com' }).where(eq(actors.id, s.agent.id))
		const email = await insertEmail(s)

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('"Read" cannot send at all, not even an approved email', async () => {
		const s = await setup({ access: 'read' })
		const email = await insertEmail(s)

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses an agent with no grant at all', async () => {
		const s = await setup({ access: null })
		const email = await insertEmail(s)

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('has no way to send a new email: to, subject, body or from are refused', async () => {
		const s = await setup()
		const email = await insertEmail(s)

		for (const extra of [
			{ to: 'eve@example.com' },
			{ subject: 'x' },
			{ body: 'x' },
			{ from: 'ceo@example.com' },
		]) {
			const res = await post(s.agent.id, s.workspace.id, { object_id: email.id, ...extra })
			expect(res.status).toBe(400)
		}
		expect((await post(s.agent.id, s.workspace.id, {})).status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses an object that is not an email draft', async () => {
		const s = await setup()
		const note = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: 'Just a note',
		})

		const res = await post(s.agent.id, s.workspace.id, { object_id: note.id })

		expect(res.status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses an email object from another workspace', async () => {
		const s = await setup()
		const other = await setup()
		const email = await insertEmail(other)

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(404)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses an address with a line break, which could smuggle a header', async () => {
		const s = await setup()
		const email = await insertEmail(s, {
			metadata: { to: 'ada@example.com\nbcc: eve@example.com' },
		})

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('resend_send_email: when Resend does not confirm', () => {
	it('lets the same approval be tried again after Resend refused it, under the same key', async () => {
		const s = await setup()
		const email = await insertEmail(s)
		fetchMock.mockResolvedValueOnce(resendError(422, 'Invalid `to` field'))
		const first = await post(s.agent.id, s.workspace.id, { object_id: email.id })
		expect(first.status).toBe(422)
		const firstKey = lastCall().headers['Idempotency-Key']

		fetchMock.mockResolvedValueOnce(resendOk('em_second'))
		const second = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(second.status).toBe(200)
		expect(lastCall().headers['Idempotency-Key']).toBe(firstKey)
	})

	it('reports an unclear failure as safe to retry, and the retry sends once', async () => {
		const s = await setup()
		const email = await insertEmail(s)
		fetchMock.mockResolvedValueOnce(resendError(500, 'Internal error'))
		const first = await post(s.agent.id, s.workspace.id, { object_id: email.id })
		expect(first.status).toBe(502)
		expect(JSON.stringify(await first.json())).toContain('safe')
		expect(await eventsOn(s.workspace.id, email.id, 'delivered')).toHaveLength(0)

		fetchMock.mockResolvedValueOnce(resendOk('em_after_retry'))
		const second = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(second.status).toBe(200)
		expect(await eventsOn(s.workspace.id, email.id, 'delivered')).toHaveLength(1)
	})

	it('treats a network failure as unclear, not as sent', async () => {
		const s = await setup()
		const email = await insertEmail(s)
		fetchMock.mockRejectedValueOnce(new Error('socket hang up'))

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(502)
		expect(await eventsOn(s.workspace.id, email.id, 'delivered')).toHaveLength(0)
	})

	it('says so when Resend rejects the key or the sender domain', async () => {
		const s = await setup()
		const email = await insertEmail(s)
		fetchMock.mockResolvedValueOnce(resendError(403, 'The example.com domain is not verified'))

		const res = await post(s.agent.id, s.workspace.id, { object_id: email.id })

		expect(res.status).toBe(409)
		expect(JSON.stringify(await res.json())).toContain('not verified')
	})
})
