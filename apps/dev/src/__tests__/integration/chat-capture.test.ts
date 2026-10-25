import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAPIHono } from '@hono/zod-openapi'
import { MasterKeyProvider } from '@maskin/auth/kms'
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
import {
	type CredentialReadContext,
	getCredential,
	getIntegrationCredential,
} from '../../lib/integrations/lookup'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { logger } from '../../lib/logger'
import { scrubEvent } from '../../lib/sentry-scrub'
import integrationsKeychainRoutes from '../../routes/integrations-keychain'
import type { SessionManager } from '../../services/session-manager'
import {
	grantedActorIds,
	insertActor,
	insertConversation,
	insertSession,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'
import { fakeSessionControl } from './session-control-fake'

// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const CANARY = `cfut_${'CANARY0123'.repeat(5)}`

let dir: string
let kms: MasterKeyProvider

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'chat-capture-kek-'))
	kms = new MasterKeyProvider(randomBytes(32))
	setKmsProviderForTests(kms)
})
afterAll(() => {
	setKmsProviderForTests(undefined)
	rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => captureMock.mockClear())

function appFor(
	actorId: string,
	actorType: 'human' | 'agent' = 'human',
	sessionManager = fakeSessionControl(),
) {
	const app = new OpenAPIHono<{
		Variables: {
			db: typeof db
			actorId: string
			actorType: string
			sessionManager: SessionManager
		}
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('sessionManager', sessionManager as unknown as SessionManager)
		await next()
	})
	app.onError((err, c) =>
		c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), { status: 500 }),
	)
	app.route('/api/integrations', integrationsKeychainRoutes)
	return app
}

async function setup(opts: { withConversation?: boolean } = { withConversation: true }) {
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
		// Default: the session driver holds it.
		expect(await grantedActorIds(db, row?.id ?? '')).toEqual([s.agent.id])
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

	it.each([
		['a trailing newline', `${CANARY}\n`, /whitespace/],
		['a double quote', `${CANARY}"x`, /double quote/],
		['a backslash', `${CANARY}\\x`, /backslash/],
		['1025 characters', 'k'.repeat(1025), /1 to 1024/],
	])('rejects a secret with %s, names the rule and vaults nothing', async (_l, rawSecret, rule) => {
		const s = await setup()
		const res = await capture(appFor(s.human), s.ws.id, validBody(s.session.id, { rawSecret }))
		expect(res.status).toBe(400)
		const text = await res.text()
		expect(text).toMatch(rule)
		expect(text).not.toContain(CANARY)
		expect(
			await db.select().from(integrations).where(eq(integrations.workspaceId, s.ws.id)),
		).toEqual([])
		expect(captureMock).not.toHaveBeenCalled()
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

	it('honours explicit agent ids', async () => {
		const s = await setup()
		const res = await capture(
			appFor(s.human),
			s.ws.id,
			validBody(s.session.id, { agentIds: [s.agent.id] }),
		)
		const { integrationId } = (await res.json()) as { integrationId: string }
		expect(await grantedActorIds(db, integrationId)).toEqual([s.agent.id])
	})

	it('treats an explicit empty grant list as unassigned, not as the default', async () => {
		const s = await setup()
		const res = await capture(appFor(s.human), s.ws.id, validBody(s.session.id, { agentIds: [] }))
		expect(res.status).toBe(201)
		const { integrationId } = (await res.json()) as { integrationId: string }
		expect(await grantedActorIds(db, integrationId)).toEqual([])
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
			validBody(s.session.id, { agentIds: [s.agent.id] }),
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
				// One workspace, so each key needs its own name.
				validBody(s.session.id, { detectedProvider, displayName: `Key for ${detectedProvider}` }),
			)
			expect(res.status).toBe(201)
		}
	})

	it('rejects an agent id outside the workspace', async () => {
		const s = await setup()
		const outsider = await insertActor(db)
		const res = await capture(
			appFor(s.human),
			s.ws.id,
			validBody(s.session.id, { agentIds: [outsider.id] }),
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

	it('rejects a non-driver on a session with no conversation and does not stop it', async () => {
		const s = await setup({ withConversation: false })
		const res = await capture(appFor(s.human), s.ws.id, validBody(s.session.id))
		expect(res.status).toBe(403)
		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, s.ws.id))
		expect(rows).toHaveLength(0)
	})

	it('allows the driver of a session with no conversation', async () => {
		const s = await setup({ withConversation: false })
		const driver = await insertSession(db, s.ws.id, s.human, s.human, { conversationId: null })
		const res = await capture(appFor(s.human), s.ws.id, validBody(driver.id))
		expect(res.status).toBe(201)
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
		expect(await res.json()).toEqual({ id: integrationId, status: 'undone', sessionEnded: true })

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

describe('several keys for one provider', () => {
	it('captures twice for one provider, both 201', async () => {
		const s = await setup()
		const app = appFor(s.human)
		const first = await capture(app, s.ws.id, validBody(s.session.id, { displayName: 'First' }))
		const second = await capture(app, s.ws.id, validBody(s.session.id, { displayName: 'Second' }))
		expect(first.status).toBe(201)
		expect(second.status).toBe(201)
		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, s.ws.id))
		expect(rows.map((r) => r.displayName).sort()).toEqual(['First', 'Second'])
	})

	it('captures, undoes, then captures again, 201 both times', async () => {
		const s = await setup()
		const app = appFor(s.human)
		const first = await capture(app, s.ws.id, validBody(s.session.id))
		expect(first.status).toBe(201)
		const { integrationId } = (await first.json()) as { integrationId: string }
		const undone = await app.request(`/api/integrations/${integrationId}/undo`, {
			method: 'POST',
			headers: { 'x-workspace-id': s.ws.id },
		})
		expect(undone.status).toBe(200)
		const again = await capture(app, s.ws.id, validBody(s.session.id))
		expect(again.status).toBe(201)
	})

	it('a provider-name lookup still finds the registered connection, not an active captured key', async () => {
		const s = await setup()
		// The captured key goes in first and is active, as it will be once the sweeper
		// has flipped it: it is the row a bare provider lookup would otherwise return.
		const res = await capture(
			appFor(s.human),
			s.ws.id,
			validBody(s.session.id, { detectedProvider: 'github' }),
		)
		expect(res.status).toBe(201)
		const { integrationId } = (await res.json()) as { integrationId: string }
		await db
			.update(integrations)
			.set({ status: 'active' })
			.where(eq(integrations.id, integrationId))
		const [registered] = await db
			.insert(integrations)
			.values({
				workspaceId: s.ws.id,
				provider: 'github',
				status: 'active',
				credentials: 'legacy-ciphertext',
				createdBy: s.human,
			})
			.returning()
		const found = await getIntegrationCredential(db, s.ws.id, 'github', null)
		expect(found?.id).toBe(registered?.id)
		expect(found?.id).not.toBe(integrationId)
	})
})

// The ! prefix: the user typed the prefix and named the key, so nothing was detected.
describe('manual capture (the ! prefix)', () => {
	const manualBody = (sessionId: string, extra: Record<string, unknown> = {}) =>
		validBody(sessionId, { detectedProvider: 'manual', displayName: 'Coolify', ...extra })

	it('accepts detectedProvider manual, keeps providerMode byo_apikey and the chat_capture audit row', async () => {
		const s = await setup()
		const res = await capture(appFor(s.human), s.ws.id, manualBody(s.session.id))
		expect(res.status).toBe(201)
		const { integrationId } = (await res.json()) as { integrationId: string }

		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row).toMatchObject({
			status: 'pending_undo',
			source: 'chat_capture',
			providerMode: 'byo_apikey',
			// The same provider id a key pasted in the Keychain gets when nothing was detected.
			provider: 'custom',
			displayName: 'Coolify',
		})
		const log = await db
			.select()
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.integrationId, integrationId))
		expect(log).toHaveLength(1)
		expect(log[0]).toMatchObject({ action: 'create', source: 'chat_capture' })
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true })
		expect(JSON.stringify(captureMock.mock.calls)).not.toContain(CANARY)
	})

	it('derives trigger prefix for manual and detected otherwise, and the client cannot set it', async () => {
		const s = await setup()
		const app = appFor(s.human)
		expect((await capture(app, s.ws.id, manualBody(s.session.id))).status).toBe(201)
		expect(captureMock).toHaveBeenLastCalledWith(
			'keychain_credential_created',
			s.human,
			expect.objectContaining({ source: 'chat_capture', trigger: 'prefix' }),
		)
		expect((await capture(app, s.ws.id, validBody(s.session.id))).status).toBe(201)
		expect(captureMock).toHaveBeenLastCalledWith(
			'keychain_credential_created',
			s.human,
			expect.objectContaining({ provider: 'cloudflare', trigger: 'detected' }),
		)
		// The body schema is strict: a client-sent trigger is refused, not honoured.
		const forged = await capture(
			app,
			s.ws.id,
			manualBody(s.session.id, { trigger: 'detected', displayName: 'Other' }),
		)
		expect(forged.status).toBe(400)
	})

	it('still requires a display name', async () => {
		const s = await setup()
		const res = await capture(
			appFor(s.human),
			s.ws.id,
			manualBody(s.session.id, { displayName: '   ' }),
		)
		expect(res.status).toBe(400)
		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, s.ws.id))
		expect(rows).toHaveLength(0)
	})
})

describe('credential names', () => {
	const named = (sessionId: string, displayName: string) =>
		validBody(sessionId, { detectedProvider: 'manual', displayName })

	async function writtenFor(workspaceId: string) {
		const rows = await db
			.select()
			.from(integrations)
			.where(eq(integrations.workspaceId, workspaceId))
		const log = await db
			.select()
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.workspaceId, workspaceId))
		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'integration')))
		return { rows: rows.length, log: log.length, events: evs.length }
	}

	it('returns 409 NAME_TAKEN before any encryption, write, audit row or created event', async () => {
		const s = await setup()
		const app = appFor(s.human)
		expect((await capture(app, s.ws.id, named(s.session.id, 'my key'))).status).toBe(201)
		const before = await writtenFor(s.ws.id)
		captureMock.mockClear()
		const encrypt = vi.spyOn(kms, 'encrypt')

		// Compared by slug, so case and separators do not make a new name.
		const res = await capture(app, s.ws.id, named(s.session.id, 'My-Key'))
		expect(res.status).toBe(409)
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NAME_TAKEN')
		expect(encrypt).not.toHaveBeenCalled()
		encrypt.mockRestore()
		expect(await writtenFor(s.ws.id)).toEqual(before)
		expect(captureMock).not.toHaveBeenCalled()
	})

	it('a pending_undo row holds the name and an undone row frees it', async () => {
		const s = await setup()
		const app = appFor(s.human)
		const first = await capture(app, s.ws.id, named(s.session.id, 'Coolify'))
		const { integrationId } = (await first.json()) as { integrationId: string }
		expect((await capture(app, s.ws.id, named(s.session.id, 'coolify'))).status).toBe(409)
		const undone = await app.request(`/api/integrations/${integrationId}/undo`, {
			method: 'POST',
			headers: { 'x-workspace-id': s.ws.id },
		})
		expect(undone.status).toBe(200)
		expect((await capture(app, s.ws.id, named(s.session.id, 'coolify'))).status).toBe(201)
	})

	it('an active row holds the name too', async () => {
		const s = await setup()
		const app = appFor(s.human)
		const first = await capture(app, s.ws.id, named(s.session.id, 'Coolify'))
		const { integrationId } = (await first.json()) as { integrationId: string }
		await db
			.update(integrations)
			.set({ status: 'active' })
			.where(eq(integrations.id, integrationId))
		expect((await capture(app, s.ws.id, named(s.session.id, 'COOLIFY'))).status).toBe(409)
	})

	it('is per workspace', async () => {
		const a = await setup()
		const b = await setup()
		expect((await capture(appFor(a.human), a.ws.id, named(a.session.id, 'Coolify'))).status).toBe(
			201,
		)
		expect((await capture(appFor(b.human), b.ws.id, named(b.session.id, 'Coolify'))).status).toBe(
			201,
		)
	})

	it('holds across both entry points: the paste form and chat', async () => {
		const s = await setup()
		const app = appFor(s.human)
		const paste = (name: string) =>
			app.request('/api/integrations/byo-apikey', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-workspace-id': s.ws.id },
				body: JSON.stringify({ displayName: name, rawSecret: CANARY }),
			})
		expect((await paste('Notion team')).status).toBe(201)
		expect((await capture(app, s.ws.id, named(s.session.id, 'notion_team'))).status).toBe(409)
		expect((await capture(app, s.ws.id, named(s.session.id, 'Linear'))).status).toBe(201)
		const taken = await paste('LINEAR')
		expect(taken.status).toBe(409)
		expect(((await taken.json()) as { error: { code: string } }).error.code).toBe('NAME_TAKEN')
	})

	it('gives one 201 and one 409 for two concurrent vaults of the same slug', async () => {
		const s = await setup()
		const app = appFor(s.human)
		const statuses = (
			await Promise.all([
				capture(app, s.ws.id, named(s.session.id, 'Race key')),
				capture(app, s.ws.id, named(s.session.id, 'race-key')),
			])
		)
			.map((r) => r.status)
			.sort()
		expect(statuses).toEqual([201, 409])
		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, s.ws.id))
		expect(rows).toHaveLength(1)
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true })
	})

	it.each([
		[`cfut_${'A1'.repeat(20)}`],
		[`ghp_${'a'.repeat(36)}`],
		[`sk_live_${'c'.repeat(24)}`],
		[`xoxb-${'1'.repeat(24)}`],
		[`sk-${'e'.repeat(44)}`],
	])(
		'rejects a secret-shaped name with 400 NAME_LOOKS_LIKE_SECRET and does not echo it',
		async (name) => {
			const s = await setup()
			const res = await capture(appFor(s.human), s.ws.id, named(s.session.id, name))
			expect(res.status).toBe(400)
			const text = await res.text()
			expect(JSON.parse(text).error.code).toBe('NAME_LOOKS_LIKE_SECRET')
			expect(text).not.toContain(name)
			expect(await writtenFor(s.ws.id)).toEqual({ rows: 0, log: 0, events: 0 })
		},
	)

	it.each([
		['square brackets', 'bad [name]'],
		['a control character', 'bad\u0007name'],
		['over 64 characters', 'x'.repeat(65)],
		['nothing usable for an env var', '🔑🔑'],
	])('rejects a name with %s and writes nothing', async (_label, name) => {
		const s = await setup()
		const res = await capture(appFor(s.human), s.ws.id, named(s.session.id, name))
		expect(res.status).toBe(400)
		expect(await writtenFor(s.ws.id)).toEqual({ rows: 0, log: 0, events: 0 })
	})

	it('applies the same name rule to the paste form', async () => {
		const s = await setup()
		const res = await appFor(s.human).request('/api/integrations/byo-apikey', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-workspace-id': s.ws.id },
			body: JSON.stringify({ displayName: 'bad [name]', rawSecret: CANARY }),
		})
		expect(res.status).toBe(400)
		expect(await writtenFor(s.ws.id)).toEqual({ rows: 0, log: 0, events: 0 })
	})
})
