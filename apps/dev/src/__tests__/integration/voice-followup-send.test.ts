import { events, integrations, objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { sendFollowup } from '../../lib/outreach/voice/send-followup'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Per-workspace send resolution against real Postgres and real encryption. Only
// the HTTP call under the Resend SDK (global fetch) is stubbed, so the assertion
// is on what actually leaves the process: the Authorization header carries the
// workspace's decrypted key and the body carries the workspace's own sender.
// Placed here rather than apps/e2e: apps/e2e is Playwright-over-the-UI and this
// seam has no HTTP or UI surface to drive.
const fetchMock = vi.fn()

async function connectResend(
	workspaceId: string,
	opts: { apiKey: string; sendFrom: string; status?: 'active' | 'pending' },
) {
	await db.insert(integrations).values({
		workspaceId,
		provider: 'resend',
		status: opts.status ?? 'active',
		credentials: encrypt(JSON.stringify({ accessToken: opts.apiKey })),
		config: { resend: { send_from: opts.sendFrom } },
		createdBy: getTestActorId(),
	})
}

// A function: the test actor only exists once global-setup has run.
const emailParams = () => ({
	to: 'prospect@example.com',
	prospectName: 'Pia',
	callSummary: 'We covered rollout.',
	callId: 'call-1',
	actorId: getTestActorId(),
})

async function insertContact(workspaceId: string, metadata: Record<string, unknown> = {}) {
	const row = await insertObject(db, workspaceId, getTestActorId(), { type: 'contact', metadata })
	return { id: row.id, metadata }
}

async function contactMetadata(id: string) {
	const [row] = await db.select().from(objects).where(eq(objects.id, id))
	return row.metadata as Record<string, unknown>
}

function sentRequest(i: number) {
	const [url, init] = fetchMock.mock.calls[i]
	return {
		url: String(url),
		auth: new Headers(init.headers).get('authorization'),
		body: JSON.parse(init.body as string),
	}
}

describe('sendFollowup per-workspace Resend identity', () => {
	beforeEach(() => {
		fetchMock.mockReset()
		fetchMock.mockImplementation(
			async () => new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }),
		)
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('sends each workspace with its own decrypted key and sender', async () => {
		const a = await insertWorkspace(db, getTestActorId())
		const b = await insertWorkspace(db, getTestActorId())
		await connectResend(a.id, { apiKey: 're_key_a', sendFrom: 'noreply@agent.a.example' })
		await connectResend(b.id, { apiKey: 're_key_b', sendFrom: 'noreply@agent.b.example' })

		await sendFollowup(db, {
			...emailParams(),
			workspaceId: a.id,
			contact: await insertContact(a.id),
		})
		await sendFollowup(db, {
			...emailParams(),
			workspaceId: b.id,
			contact: await insertContact(b.id),
		})

		expect(fetchMock).toHaveBeenCalledTimes(2)
		const first = sentRequest(0)
		expect(first.url).toContain('api.resend.com/emails')
		expect(first.auth).toBe('Bearer re_key_a')
		expect(first.body.from).toBe('noreply@agent.a.example')
		const second = sentRequest(1)
		expect(second.auth).toBe('Bearer re_key_b')
		expect(second.body.from).toBe('noreply@agent.b.example')
	})

	it('skips without sending or throwing when the workspace has no resend integration', async () => {
		const ws = await insertWorkspace(db, getTestActorId())

		const contact = await insertContact(ws.id)

		await expect(
			sendFollowup(db, { ...emailParams(), workspaceId: ws.id, contact }),
		).resolves.toBeUndefined()

		expect(fetchMock).not.toHaveBeenCalled()
		expect(await contactMetadata(contact.id)).toEqual({})
	})

	it('skips when the resend integration is not active', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await connectResend(ws.id, {
			apiKey: 're_key_pending',
			sendFrom: 'noreply@agent.p.example',
			status: 'pending',
		})

		const contact = await insertContact(ws.id)

		await expect(
			sendFollowup(db, { ...emailParams(), workspaceId: ws.id, contact }),
		).resolves.toBeUndefined()

		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('does not send when the contact is flagged disclosure_missing', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await connectResend(ws.id, { apiKey: 're_key_c', sendFrom: 'noreply@agent.c.example' })

		const contact = await insertContact(ws.id, { compliance_flag: 'disclosure_missing' })

		await sendFollowup(db, { ...emailParams(), workspaceId: ws.id, contact })

		expect(fetchMock).not.toHaveBeenCalled()
		expect(await contactMetadata(contact.id)).toEqual({ compliance_flag: 'disclosure_missing' })
	})

	it('merges consent_* into the contact after a send and keeps sibling keys', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await connectResend(ws.id, { apiKey: 're_key_d', sendFrom: 'noreply@agent.d.example' })
		const contact = await insertContact(ws.id, { voice_first_touch_at: '2026-10-03T10:00:00.000Z' })

		await sendFollowup(db, { ...emailParams(), workspaceId: ws.id, contact })

		const metadata = await contactMetadata(contact.id)
		expect(metadata).toMatchObject({
			voice_first_touch_at: '2026-10-03T10:00:00.000Z',
			consent_basis: 'gdpr_6_1_f_legitimate_interest_b2b_voice',
			consent_call_id: 'call-1',
			consent_disclosed_identity: 'Maskin ApS, Sebk / Magnus, on behalf of Maskin',
		})
		expect(typeof metadata.consent_captured_at).toBe('string')
		expect(metadata).not.toHaveProperty('voice_last_touch_at')
		expect(metadata).not.toHaveProperty('retention_expires_at')
		const audit = await db.select().from(events).where(eq(events.entityId, contact.id))
		expect(audit).toHaveLength(1)
		expect(audit[0].action).toBe('updated')
	})
})
