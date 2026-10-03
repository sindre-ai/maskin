import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAPIHono } from '@hono/zod-openapi'
import { LocalFileKmsProvider } from '@maskin/auth/kms'
import {
	events,
	conversationParticipants,
	credentialAccessLog,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const captureMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

import { createApiError } from '../../lib/errors'
import { verifyCredentialAccessChain } from '../../lib/integrations/credential-audit'
import { type CredentialReadContext, getCredential } from '../../lib/integrations/lookup'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { logger } from '../../lib/logger'
import { scrubEvent } from '../../lib/sentry-scrub'
import integrationsKeychainRoutes from '../../routes/integrations-keychain'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const CANARY = `cfut_${'CANARY0123'.repeat(5)}`

let dir: string
let kms: LocalFileKmsProvider

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'chat-capture-kek-'))
	kms = new LocalFileKmsProvider(join(dir, 'kek'))
	setKmsProviderForTests(kms)
})
afterAll(() => {
	setKmsProviderForTests(undefined)
	rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => captureMock.mockClear())

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
	app.onError((err, c) =>
		c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), { status: 500 }),
	)
	app.route('/api/integrations', integrationsKeychainRoutes)
	return app
}

async function setup(opts: { withConversation?: boolean } = {}) {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	const conversation = opts.withConversation ? await insertConversation(db, ws.id, human) : null
	if (conversation) {
		await db
			.insert(conversationParticipants)
			.values({ conversationId: conversation.id, actorId: human })
	}
	const session = await insertSession(db, ws.id, agent.id, human, {
		conversationId: conversation?.id ?? null,
	})
	return { human, ws, agent, session, conversation }
}

function capture(
	app: ReturnType<typeof appFor>,
	workspaceId: string,
	body: Record<string, unknown>,
) {
	return app.request('/api/integrations/chat-capture', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
		body: JSON.stringify(body),
	})
}

const validBody = (sessionId: string, extra: Record<string, unknown> = {}) => ({
	sessionId,
	providerMode: 'byo_apikey',
	detectedProvider: 'cloudflare',
	displayName: 'Cloudflare deploy',
	rawSecret: CANARY,
	...extra,
})

describe('POST /api/integrations/chat-capture', () => {
	it('vaults the key as pending_undo with an envelope, a create audit row and no raw value anywhere', async () => {
		const s = await setup()
		const res = await capture(appFor(s.human), s.ws.id, validBody(s.session.id))
		expect(res.status).toBe(201)
		const out = (await res.json()) as Record<string, string>
		expect(out.relaunch).toBe('stopped')
		expect(out.undoUrl).toBe(`/api/integrations/${out.integrationId}/undo`)

		const [row] = await db.select().from(integrations).where(eq(integrations.id, out.integrationId))
		expect(row).toMatchObject({
			status: 'pending_undo',
			source: 'chat_capture',
			providerMode: 'byo_apikey',
			provider: 'cloudflare',
			displayName: 'Cloudflare deploy',
			originSessionId: s.session.id,
			createdBy: s.human,
		})
		expect(row?.credentials).not.toContain(CANARY)
		expect(row?.credentials).not.toBe(CANARY)
		expect(row?.dekCiphertext).toBeTruthy()
		// Default scope: one actor grant for the session driver.
		expect(row?.scopeGrants).toEqual([{ kind: 'actor', actorId: s.agent.id }])
		const windowMs = (row?.undoExpiresAt?.getTime() ?? 0) - Date.now()
		expect(windowMs).toBeGreaterThan(4 * 60_000)
		expect(windowMs).toBeLessThanOrEqual(5 * 60_000)

		const log = await db
			.select()
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.integrationId, out.integrationId))
		expect(log).toHaveLength(1)
		expect(log[0]).toMatchObject({ action: 'create', source: 'chat_capture', actorId: s.human })
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true })

		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, out.integrationId), eq(events.entityType, 'integration')))
		expect(evs).toHaveLength(1)
		// The value must not be in any row this request wrote.
		expect(
			JSON.stringify([row, log, evs], (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
		).not.toContain(CANARY)

		expect(captureMock).toHaveBeenCalledWith(
			'keychain_credential_created',
			s.human,
			expect.objectContaining({ provider_mode: 'byo_apikey', source: 'chat_capture' }),
		)
		expect(JSON.stringify(captureMock.mock.calls)).not.toContain(CANARY)
	})

	it('is readable through getCredential during the undo window, by the granted actor only', async () => {
		const s = await setup()
		const res = await capture(appFor(s.human), s.ws.id, validBody(s.session.id))
		const { integrationId } = (await res.json()) as { integrationId: string }
		const ctx = (actorId: string): CredentialReadContext => ({
			requestingActorId: actorId,
			sessionId: s.session.id,
			requestId: 'req-1',
		})
		const cred = await getCredential(db, s.ws.id, integrationId, ctx(s.agent.id), { kms })
		expect(cred.value).toBe(CANARY)
		await expect(getCredential(db, s.ws.id, integrationId, ctx(s.human), { kms })).rejects.toThrow()
	})

	it('honours explicit scope grants', async () => {
		const s = await setup()
		const res = await capture(
			appFor(s.human),
			s.ws.id,
			validBody(s.session.id, { scopeGrants: [{ kind: 'workspace' }] }),
		)
		const { integrationId } = (await res.json()) as { integrationId: string }
		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row?.scopeGrants).toEqual([{ kind: 'workspace' }])
	})

	it('treats an explicit empty grant list as unassigned, not as the default', async () => {
		const s = await setup()
		const res = await capture(
			appFor(s.human),
			s.ws.id,
			validBody(s.session.id, { scopeGrants: [] }),
		)
		expect(res.status).toBe(201)
		const { integrationId } = (await res.json()) as { integrationId: string }
		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row?.scopeGrants).toEqual([])
		await expect(
			getCredential(
				db,
				s.ws.id,
				integrationId,
				{ requestingActorId: s.agent.id, sessionId: s.session.id, requestId: 'r' },
				{ kms },
			),
		).rejects.toThrow()
	})

	it('accepts an explicit actor grant for a workspace member', async () => {
		const s = await setup()
		const res = await capture(
			appFor(s.human),
			s.ws.id,
			validBody(s.session.id, { scopeGrants: [{ kind: 'actor', actorId: s.agent.id }] }),
		)
		expect(res.status).toBe(201)
	})

	it('rejects agent callers and writes nothing', async () => {
		const s = await setup()
		const res = await capture(appFor(s.agent.id, 'agent'), s.ws.id, validBody(s.session.id))
		expect(res.status).toBe(403)
		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, s.ws.id))
		expect(rows).toHaveLength(0)
	})

	it.each(['notion', 'jwt', 'openai', 'long-blob'])(
		'rejects detectedProvider %s outside the allow-list',
		async (detectedProvider) => {
			const s = await setup()
			const res = await capture(
				appFor(s.human),
				s.ws.id,
				validBody(s.session.id, { detectedProvider }),
			)
			expect(res.status).toBe(400)
			const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, s.ws.id))
			expect(rows).toHaveLength(0)
		},
	)

	it('accepts every allow-listed provider', async () => {
		const s = await setup()
		for (const detectedProvider of ['cloudflare', 'github', 'stripe', 'slack', 'openai-style']) {
			const res = await capture(
				appFor(s.human),
				s.ws.id,
				validBody(s.session.id, { detectedProvider }),
			)
			expect(res.status).toBe(201)
		}
	})

	it('rejects a scope grant naming an actor outside the workspace', async () => {
		const s = await setup()
		const outsider = await insertActor(db)
		const res = await capture(
			appFor(s.human),
			s.ws.id,
			validBody(s.session.id, { scopeGrants: [{ kind: 'actor', actorId: outsider.id }] }),
		)
		expect(res.status).toBe(400)
	})

	it('rejects a session from another workspace', async () => {
		const s = await setup()
		const other = await setup()
		const res = await capture(appFor(s.human), s.ws.id, validBody(other.session.id))
		expect(res.status).toBe(404)
	})

	it('rejects a caller who is not in the conversation the key was pasted into', async () => {
		const s = await setup({ withConversation: true })
		const stranger = await insertActor(db)
		const res = await capture(appFor(stranger.id), s.ws.id, validBody(s.session.id))
		expect(res.status).toBe(403)
	})

	it('names only the bad field when validation fails, never the value', async () => {
		const s = await setup()
		const res = await capture(
			appFor(s.human),
			s.ws.id,
			validBody(s.session.id, { displayName: '', unexpected: CANARY }),
		)
		expect(res.status).toBe(400)
		const text = await res.text()
		expect(text).toContain('displayName')
		expect(text).not.toContain(CANARY)
	})

	it('a forced 500 leaks the canary into no response, log line or Sentry event', async () => {
		const s = await setup()
		const logged: unknown[] = []
		const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
			vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
				logged.push(args)
			}),
		)
		setKmsProviderForTests({
			encrypt: async () => {
				throw new Error('KMS unavailable')
			},
			decrypt: async () => Buffer.alloc(0),
		})
		try {
			const res = await capture(appFor(s.human), s.ws.id, validBody(s.session.id))
			expect(res.status).toBe(500)
			expect(await res.text()).not.toContain(CANARY)
			expect(JSON.stringify(logged)).not.toContain(CANARY)
			// Whatever reaches Sentry for the same request body shape.
			const scrubbed = scrubEvent({
				extra: { request: { rawSecret: CANARY, credentials: 'ct', dek_ciphertext: 'wrapped' } },
			} as never)
			expect(JSON.stringify(scrubbed)).not.toContain(CANARY)
			expect(JSON.stringify(scrubbed)).not.toContain('wrapped')
			const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, s.ws.id))
			expect(rows).toHaveLength(0)
		} finally {
			for (const spy of spies) spy.mockRestore()
			setKmsProviderForTests(kms)
		}
	})
})

describe('GET /api/integrations/:id/audit-log', () => {
	it('returns the create row plus source and originSessionId', async () => {
		const s = await setup()
		const res = await capture(appFor(s.human), s.ws.id, validBody(s.session.id))
		const { integrationId } = (await res.json()) as { integrationId: string }

		const audit = await appFor(s.human).request(`/api/integrations/${integrationId}/audit-log`, {
			headers: { 'x-workspace-id': s.ws.id },
		})
		expect(audit.status).toBe(200)
		const body = (await audit.json()) as {
			source: string
			originSessionId: string
			entries: Array<{ action: string; source: string }>
		}
		expect(body.source).toBe('chat_capture')
		expect(body.originSessionId).toBe(s.session.id)
		expect(body.entries).toHaveLength(1)
		expect(body.entries[0]).toMatchObject({ action: 'create', source: 'chat_capture' })
	})

	it('404s for an integration in another workspace', async () => {
		const s = await setup()
		const other = await setup()
		const res = await capture(appFor(other.human), other.ws.id, validBody(other.session.id))
		const { integrationId } = (await res.json()) as { integrationId: string }
		const audit = await appFor(s.human).request(`/api/integrations/${integrationId}/audit-log`, {
			headers: { 'x-workspace-id': s.ws.id },
		})
		expect(audit.status).toBe(404)
	})
})

describe('POST /api/integrations/:id/undo', () => {
	async function captured() {
		const s = await setup()
		const res = await capture(appFor(s.human), s.ws.id, validBody(s.session.id))
		const { integrationId } = (await res.json()) as { integrationId: string }
		return { s, integrationId }
	}

	const undo = (app: ReturnType<typeof appFor>, workspaceId: string, id: string) =>
		app.request(`/api/integrations/${id}/undo`, {
			method: 'POST',
			headers: { 'x-workspace-id': workspaceId },
		})

	const auditRows = (integrationId: string) =>
		db
			.select({ action: credentialAccessLog.action })
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.integrationId, integrationId))
			.orderBy(credentialAccessLog.id)

	it('zeroises the secret inside the window, keeps the row, logs undone and fires the event', async () => {
		const { s, integrationId } = await captured()
		const res = await undo(appFor(s.human), s.ws.id, integrationId)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ id: integrationId, status: 'undone' })

		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row).toMatchObject({
			status: 'undone',
			credentials: null,
			dekCiphertext: null,
			undoExpiresAt: null,
		})
		expect((await auditRows(integrationId)).map((r) => r.action)).toEqual(['create', 'undone'])
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 2 })
		expect(captureMock).toHaveBeenCalledWith(
			'keychain_credential_undone',
			s.human,
			expect.objectContaining({
				integration_id: integrationId,
				seconds_since_create: expect.any(Number),
			}),
		)

		// Nothing can read it any more.
		await expect(
			getCredential(
				db,
				s.ws.id,
				integrationId,
				{ requestingActorId: s.agent.id, sessionId: s.session.id, requestId: 'r' },
				{ kms },
			),
		).rejects.toThrow(/undone/)
	})

	it('a second undo is a 409 and logs nothing more', async () => {
		const { s, integrationId } = await captured()
		expect((await undo(appFor(s.human), s.ws.id, integrationId)).status).toBe(200)
		expect((await undo(appFor(s.human), s.ws.id, integrationId)).status).toBe(409)
		expect((await auditRows(integrationId)).map((r) => r.action)).toEqual(['create', 'undone'])
	})

	it('409s after the window and leaves the credential intact', async () => {
		const { s, integrationId } = await captured()
		await db
			.update(integrations)
			.set({ undoExpiresAt: new Date(Date.now() - 1000) })
			.where(eq(integrations.id, integrationId))
		const res = await undo(appFor(s.human), s.ws.id, integrationId)
		expect(res.status).toBe(409)
		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row?.status).toBe('pending_undo')
		expect(row?.credentials).toBeTruthy()
		expect((await auditRows(integrationId)).map((r) => r.action)).toEqual(['create'])
	})

	it('409s on a row that is not pending undo', async () => {
		const { s, integrationId } = await captured()
		await db
			.update(integrations)
			.set({ status: 'active' })
			.where(eq(integrations.id, integrationId))
		expect((await undo(appFor(s.human), s.ws.id, integrationId)).status).toBe(409)
		expect((await auditRows(integrationId)).map((r) => r.action)).toEqual(['create'])
	})

	it('403s a caller in another workspace and one who did not capture it', async () => {
		const { s, integrationId } = await captured()
		const other = await setup()
		expect((await undo(appFor(s.human), other.ws.id, integrationId)).status).toBe(403)

		const teammate = await insertActor(db)
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: s.ws.id, actorId: teammate.id, role: 'member' })
		expect((await undo(appFor(teammate.id), s.ws.id, integrationId)).status).toBe(403)

		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row?.status).toBe('pending_undo')
	})

	it('404s an unknown integration', async () => {
		const s = await setup()
		expect((await undo(appFor(s.human), s.ws.id, crypto.randomUUID())).status).toBe(404)
	})

	it('concurrent undos have exactly one winner and one audit row', async () => {
		const { s, integrationId } = await captured()
		const results = await Promise.all(
			Array.from({ length: 6 }, () => undo(appFor(s.human), s.ws.id, integrationId)),
		)
		const statuses = results.map((r) => r.status).sort()
		expect(statuses).toEqual([200, 409, 409, 409, 409, 409])
		expect((await auditRows(integrationId)).map((r) => r.action)).toEqual(['create', 'undone'])
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true })
	})
})
