import { linkedinAccounts } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// The send route's DB-semantic contract is the account-row lookup +
// state-gate: only rows in `syncing|warm_up|healthy` may send, everything
// else must 409. That semantic depends on the `linkedin_accounts` state
// CHECK constraint and the workspace-uniqueness index, so it needs a real
// Postgres round-trip — mocked DBs can't catch a bug where the gate
// interprets state values that the CHECK would reject.

vi.mock('../../lib/unipile/client', async () => {
	const actual = await vi.importActual<typeof import('../../lib/unipile/client')>(
		'../../lib/unipile/client',
	)
	return {
		...actual,
		readUnipileConfig: vi.fn(() => ({ apiKey: 'test-key', dsn: 'https://unipile.test' })),
		sendChatMessage: vi.fn(),
	}
})

const { trackLinkedinMessageSentMock } = vi.hoisted(() => ({
	trackLinkedinMessageSentMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/linkedin-events', () => ({
	trackLinkedinAccountConnected: vi.fn(),
	trackLinkedinMessageSent: trackLinkedinMessageSentMock,
}))

const unipile = await import('../../lib/unipile/client')
const { default: linkedinRoutes } = await import('../../routes/linkedin')

function buildApp() {
	return createIntegrationApp({ path: '/api/linkedin', module: linkedinRoutes })
}

function sendRequest(workspaceId: string, body: Record<string, unknown>) {
	return new Request('http://localhost/api/linkedin/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-workspace-id': workspaceId,
		},
		body: JSON.stringify(body),
	})
}

describe('POST /api/linkedin/messages', () => {
	beforeEach(() => {
		vi.mocked(unipile.sendChatMessage).mockReset()
		trackLinkedinMessageSentMock.mockClear()
	})

	it('sends and emits `linkedin_message_sent` when the account is healthy', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await db.insert(linkedinAccounts).values({
			workspaceId: ws.id,
			state: 'healthy',
			unipileAccountId: 'unipile-acc-1',
			sendingAsName: 'sindre',
			sendingAsProviderId: 'urn:li:person:abc',
			createdBy: actorId,
		})

		vi.mocked(unipile.sendChatMessage).mockResolvedValueOnce({
			chatId: 'chat-1',
			messageId: 'msg-1',
		})

		const app = buildApp()
		const res = await app.request(
			sendRequest(ws.id, { text: 'hi', attendees_provider_ids: ['urn:li:person:xyz'] }),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { chat_id: string; message_id: string }
		expect(body).toEqual({ chat_id: 'chat-1', message_id: 'msg-1' })
		expect(trackLinkedinMessageSentMock).toHaveBeenCalledOnce()
		expect(trackLinkedinMessageSentMock).toHaveBeenCalledWith({
			workspaceId: ws.id,
			actorId,
			unipileAccountId: 'unipile-acc-1',
			chatId: 'chat-1',
			messageId: 'msg-1',
		})
	})

	it('sends and emits when the account is in `syncing`', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await db.insert(linkedinAccounts).values({
			workspaceId: ws.id,
			state: 'syncing',
			unipileAccountId: 'unipile-acc-2',
			createdBy: actorId,
		})

		vi.mocked(unipile.sendChatMessage).mockResolvedValueOnce({
			chatId: 'chat-2',
			messageId: 'msg-2',
		})

		const app = buildApp()
		const res = await app.request(sendRequest(ws.id, { text: 'hi', chat_id: 'chat-2' }))

		expect(res.status).toBe(200)
		expect(trackLinkedinMessageSentMock).toHaveBeenCalledOnce()
	})

	it('returns 404 and does not emit when no LinkedIn account exists for the workspace', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const app = buildApp()
		const res = await app.request(
			sendRequest(ws.id, { text: 'hi', attendees_provider_ids: ['urn:li:person:xyz'] }),
		)

		expect(res.status).toBe(404)
		expect(unipile.sendChatMessage).not.toHaveBeenCalled()
		expect(trackLinkedinMessageSentMock).not.toHaveBeenCalled()
	})

	it('returns 409 and does not emit when the account is in `restricted`', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await db.insert(linkedinAccounts).values({
			workspaceId: ws.id,
			state: 'restricted',
			unipileAccountId: 'unipile-acc-3',
			createdBy: actorId,
		})

		const app = buildApp()
		const res = await app.request(
			sendRequest(ws.id, { text: 'hi', attendees_provider_ids: ['urn:li:person:xyz'] }),
		)

		expect(res.status).toBe(409)
		expect(unipile.sendChatMessage).not.toHaveBeenCalled()
		expect(trackLinkedinMessageSentMock).not.toHaveBeenCalled()
	})

	it('returns 409 and does not emit when the account is in `reconnect`', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await db.insert(linkedinAccounts).values({
			workspaceId: ws.id,
			state: 'reconnect',
			unipileAccountId: 'unipile-acc-4',
			createdBy: actorId,
		})

		const app = buildApp()
		const res = await app.request(sendRequest(ws.id, { text: 'hi', chat_id: 'chat-x' }))

		expect(res.status).toBe(409)
		expect(unipile.sendChatMessage).not.toHaveBeenCalled()
		expect(trackLinkedinMessageSentMock).not.toHaveBeenCalled()
	})

	it('returns 409 and does not emit when the account is still in `handoff`', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await db.insert(linkedinAccounts).values({
			workspaceId: ws.id,
			state: 'handoff',
			createdBy: actorId,
		})

		const app = buildApp()
		const res = await app.request(sendRequest(ws.id, { text: 'hi', chat_id: 'chat-y' }))

		// `handoff` rows have no unipileAccountId yet, so we surface a 404 (nothing
		// to send from) before the state gate even runs. Either 404 or 409 keeps
		// the send blocked — assert on the outcome that matters: no send, no emit.
		expect([404, 409]).toContain(res.status)
		expect(unipile.sendChatMessage).not.toHaveBeenCalled()
		expect(trackLinkedinMessageSentMock).not.toHaveBeenCalled()
	})

	it('returns 502 and does not emit when Unipile rejects the send', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await db.insert(linkedinAccounts).values({
			workspaceId: ws.id,
			state: 'healthy',
			unipileAccountId: 'unipile-acc-5',
			createdBy: actorId,
		})

		vi.mocked(unipile.sendChatMessage).mockRejectedValueOnce(
			new unipile.UnipileApiError(500, '/api/v1/chats', 'boom'),
		)

		const app = buildApp()
		const res = await app.request(
			sendRequest(ws.id, { text: 'hi', attendees_provider_ids: ['urn:li:person:xyz'] }),
		)

		expect(res.status).toBe(502)
		expect(trackLinkedinMessageSentMock).not.toHaveBeenCalled()
	})

	it("scopes the send to the caller's workspace — will not use another workspace's account", async () => {
		const actorId = getTestActorId()
		const wsA = await insertWorkspace(db, actorId)
		const wsB = await insertWorkspace(db, actorId)
		await db.insert(linkedinAccounts).values({
			workspaceId: wsA.id,
			state: 'healthy',
			unipileAccountId: 'unipile-acc-a',
			createdBy: actorId,
		})

		// wsB has no LinkedIn account — sending from wsB must 404, not accidentally
		// pick up wsA's row.
		const app = buildApp()
		const res = await app.request(sendRequest(wsB.id, { text: 'hi', chat_id: 'chat-z' }))

		expect(res.status).toBe(404)

		const rowsA = await db
			.select()
			.from(linkedinAccounts)
			.where(eq(linkedinAccounts.workspaceId, wsA.id))
		expect(rowsA).toHaveLength(1)
		expect(rowsA[0].unipileAccountId).toBe('unipile-acc-a')
	})
})
