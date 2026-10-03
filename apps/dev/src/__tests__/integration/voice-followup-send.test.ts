import { integrations } from '@maskin/db/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { sendFollowup } from '../../lib/outreach/voice/send-followup'
import { insertWorkspace } from '../factories'
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

const email = {
	to: 'prospect@example.com',
	prospectName: 'Pia',
	callSummary: 'We covered rollout.',
	contact: { metadata: {} },
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

		await sendFollowup(db, { ...email, workspaceId: a.id })
		await sendFollowup(db, { ...email, workspaceId: b.id })

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

		await expect(sendFollowup(db, { ...email, workspaceId: ws.id })).resolves.toBeUndefined()

		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('skips when the resend integration is not active', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await connectResend(ws.id, {
			apiKey: 're_key_pending',
			sendFrom: 'noreply@agent.p.example',
			status: 'pending',
		})

		await expect(sendFollowup(db, { ...email, workspaceId: ws.id })).resolves.toBeUndefined()

		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('does not send when the contact is flagged disclosure_missing', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await connectResend(ws.id, { apiKey: 're_key_c', sendFrom: 'noreply@agent.c.example' })

		await sendFollowup(db, {
			...email,
			workspaceId: ws.id,
			contact: { metadata: { compliance_flag: 'disclosure_missing' } },
		})

		expect(fetchMock).not.toHaveBeenCalled()
	})
})
