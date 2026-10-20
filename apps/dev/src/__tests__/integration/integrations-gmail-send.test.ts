import { events, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: gmailRoutes } = await import('../../routes/integrations-gmail')

/**
 * Sending a Gmail draft writes an audit row, and the workspace's login is read
 * and decrypted from a real `integrations` row on the way. Gmail itself is
 * stubbed at `fetch`: this file checks our side (the row lookup, the token, the
 * events insert), not that Gmail behaves as assumed — that needs a live account.
 */

const fetchMock = vi.fn()

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	fetchMock.mockReset()
	vi.unstubAllGlobals()
})

function gmailJson(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function draft(messageId: string) {
	return { id: 'draft-1', message: { id: messageId, threadId: 't1', payload: { headers: [] } } }
}

async function insertGmail(workspaceId: string) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'gmail',
			status: 'active',
			externalId: 'sender@example.com',
			credentials: encrypt(
				JSON.stringify({ accessToken: 'live-token', expiresAt: Date.now() + 60 * 60 * 1000 }),
			),
			createdBy: getTestActorId(),
		})
		.returning()
	return row
}

function send(workspaceId: string, messageId: string) {
	const app = createIntegrationApp({ path: '/api/integrations/gmail', module: gmailRoutes })
	return app.request('/api/integrations/gmail/drafts/draft-1/send', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
		body: JSON.stringify({ message_id: messageId }),
	})
}

async function sendEvents(workspaceId: string, integrationId: string) {
	return db
		.select()
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityType, 'integration'),
				eq(events.entityId, integrationId),
			),
		)
}

describe('POST /api/integrations/gmail/drafts/:draftId/send', () => {
	it('sends with the stored token and writes one audit event', async () => {
		const workspace = await insertWorkspace(db, getTestActorId())
		const integration = await insertGmail(workspace.id)
		fetchMock
			.mockResolvedValueOnce(gmailJson(200, draft('m1')))
			.mockResolvedValueOnce(gmailJson(200, { id: 'sent-1', threadId: 't1' }))

		const res = await send(workspace.id, 'm1')

		expect(res.status).toBe(200)
		expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer live-token')
		const rows = await sendEvents(workspace.id, integration.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ action: 'updated', actorId: getTestActorId() })
		expect(rows[0].data).toMatchObject({
			provider: 'gmail',
			gmail_action: 'draft_sent',
			draft_id: 'draft-1',
			message_id: 'sent-1',
		})
	})

	it('writes no event and sends nothing when the draft changed', async () => {
		const workspace = await insertWorkspace(db, getTestActorId())
		const integration = await insertGmail(workspace.id)
		fetchMock.mockResolvedValueOnce(gmailJson(200, draft('m2')))

		const res = await send(workspace.id, 'm1')

		expect(res.status).toBe(409)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await sendEvents(workspace.id, integration.id)).toHaveLength(0)
	})

	it("does not use another workspace's Gmail login", async () => {
		const mine = await insertWorkspace(db, getTestActorId())
		const other = await insertWorkspace(db, getTestActorId())
		await insertGmail(other.id)

		const res = await send(mine.id, 'm1')

		expect(res.status).toBe(404)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
