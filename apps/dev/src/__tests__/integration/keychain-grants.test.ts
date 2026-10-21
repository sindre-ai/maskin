import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenAPIHono } from '@hono/zod-openapi'
import { MasterKeyProvider } from '@maskin/auth/kms'
import {
	events,
	agentGrants,
	conversationParticipants,
	credentialAccessLog,
	integrations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { createApiError } from '../../lib/errors'
import { createByoApiKey } from '../../lib/integrations/byo-apikey'
import { captureChatSecret } from '../../lib/integrations/chat-capture'
import { verifyCredentialAccessChain } from '../../lib/integrations/credential-audit'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import integrationsGrantsRoutes from '../../routes/integrations-grants'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const CANARY = `fake-scope-${'0123456789'.repeat(3)}`

let dir: string
let kms: MasterKeyProvider
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'keychain-grants-kek-'))
	kms = new MasterKeyProvider(randomBytes(32))
	setKmsProviderForTests(kms)
})
afterAll(() => {
	setKmsProviderForTests(undefined)
	rmSync(dir, { recursive: true, force: true })
})

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
	app.onError((_err, c) =>
		c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), { status: 500 }),
	)
	app.route('/api/integrations', integrationsGrantsRoutes)
	return app
}

function putGrants(
	app: ReturnType<typeof appFor>,
	workspaceId: string,
	integrationId: string,
	body: unknown,
) {
	return app.request(`/api/integrations/${integrationId}/grants`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
		body: JSON.stringify(body),
	})
}

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human, {
		enterpriseGranted: true,
		settings: { llm_keys: { anthropic: 'sk-ant-test' } },
	})
	const agentA = await insertActor(db, { type: 'agent', systemPrompt: 'Agent A' })
	const agentB = await insertActor(db, { type: 'agent', systemPrompt: 'Agent B' })
	// A plain member who did not paste the key, and an admin who did not paste it either.
	const member = await insertActor(db, { type: 'human' })
	const admin = await insertActor(db, { type: 'human' })
	await db.insert(workspaceMembers).values([
		{ workspaceId: ws.id, actorId: agentA.id, role: 'member' },
		{ workspaceId: ws.id, actorId: agentB.id, role: 'member' },
		{ workspaceId: ws.id, actorId: member.id, role: 'member' },
		{ workspaceId: ws.id, actorId: admin.id, role: 'admin' },
	])
	// A chat capture needs a conversation the human is in; without one only the driver may vault.
	const conversation = await insertConversation(db, ws.id, human)
	await db
		.insert(conversationParticipants)
		.values({ conversationId: conversation.id, actorId: human })
	const sessionFor = async (actorId: string, overrides: Record<string, unknown> = {}) => {
		const s = await insertSession(db, ws.id, actorId, human, {
			status: 'pending',
			containerId: null,
			conversationId: conversation.id,
			...overrides,
		})
		const [row] = await db.select().from(sessions).where(eq(sessions.id, s.id))
		return row as typeof sessions.$inferSelect
	}
	const { integrationId } = await createByoApiKey(db, kms, {
		workspaceId: ws.id,
		actorId: human,
		displayName: 'Coolify',
		rawSecret: CANARY,
	})
	return { human, ws, agentA, agentB, member, admin, integrationId, sessionFor }
}

type Setup = Awaited<ReturnType<typeof setup>>

const on = (...ids: string[]) => ({
	grants: ids.map((actorId) => ({ actorId, access: 'read_write' as const })),
})

const grantedIds = async (id: string) =>
	(await db.select().from(agentGrants).where(eq(agentGrants.integrationId, id)))
		.map((g) => g.actorId)
		.sort()

async function launchEnv(session: typeof sessions.$inferSelect) {
	const manager = new SessionManager(db, stubStorage())
	try {
		return (await manager.buildLaunchSpec(session)).env
	} finally {
		await manager.stop()
	}
}

const keychainKeys = (env: Record<string, string>) =>
	Object.keys(env).filter((k) => k.startsWith('KEYCHAIN_'))

const scopeRows = (s: Setup) =>
	db
		.select()
		.from(credentialAccessLog)
		.where(
			and(
				eq(credentialAccessLog.integrationId, s.integrationId),
				eq(credentialAccessLog.action, 'scope_changed'),
			),
		)

describe('PUT /api/integrations/:id/grants on a saved key (Integration)', () => {
	it('starts with no agent, replaces the grants, writes one scope_changed audit row and one event, and keeps the chain intact', async () => {
		const s = await setup()
		expect(await grantedIds(s.integrationId)).toEqual([])
		const res = await putGrants(appFor(s.human), s.ws.id, s.integrationId, on(s.agentA.id))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual(on(s.agentA.id))
		expect(await grantedIds(s.integrationId)).toEqual([s.agentA.id])

		const rows = await scopeRows(s)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			action: 'scope_changed',
			source: 'admin_ui',
			actorId: s.human,
			sessionId: null,
			detail: null,
		})
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true })

		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, s.integrationId), eq(events.entityType, 'integration')))
		const change = evs.find(
			(e) => (e.data as { change?: string } | null)?.change === 'agent_grants',
		)
		expect(change).toMatchObject({ action: 'updated', actorId: s.human })
		expect(change?.data).toMatchObject({
			grants_before: [],
			grants_after: [{ actorId: s.agentA.id, access: 'read_write' }],
		})

		const [row] = await db.select().from(integrations).where(eq(integrations.id, s.integrationId))
		const everything = JSON.stringify([body, rows, evs], (_k, v) =>
			typeof v === 'bigint' ? v.toString() : v,
		)
		expect(everything).not.toContain(CANARY)
		expect(everything).not.toContain(row?.credentials ?? 'no-credentials')
		expect(everything).not.toContain(row?.dekCiphertext ?? 'no-dek')
	})

	it('writes one audit row per save, each with its own request id, and the chain still verifies', async () => {
		const s = await setup()
		const app = appFor(s.human)
		for (const ids of [[s.agentA.id], [], [s.agentA.id, s.agentB.id]]) {
			expect((await putGrants(app, s.ws.id, s.integrationId, on(...ids))).status).toBe(200)
		}
		const rows = await scopeRows(s)
		expect(rows).toHaveLength(3)
		expect(new Set(rows.map((r) => r.requestId)).size).toBe(3)
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 4 })
	})

	it('stores each agent once', async () => {
		const s = await setup()
		const res = await putGrants(
			appFor(s.human),
			s.ws.id,
			s.integrationId,
			on(s.agentA.id, s.agentA.id),
		)
		expect(res.status).toBe(200)
		expect(await grantedIds(s.integrationId)).toEqual([s.agentA.id])
	})

	it('hands the key to the ticked agent for the next session, and takes it away when un-ticked', async () => {
		const s = await setup()
		const app = appFor(s.human)
		const sessionA = await s.sessionFor(s.agentA.id)
		const sessionB = await s.sessionFor(s.agentB.id)

		await putGrants(app, s.ws.id, s.integrationId, on(s.agentA.id))
		expect((await launchEnv(sessionA)).KEYCHAIN_BYO_APIKEY_COOLIFY).toBe(CANARY)
		const envB = await launchEnv(sessionB)
		expect(keychainKeys(envB)).toEqual([])
		expect(JSON.stringify(envB)).not.toContain(CANARY)

		await putGrants(app, s.ws.id, s.integrationId, on())
		expect(keychainKeys(await launchEnv(await s.sessionFor(s.agentA.id)))).toEqual([])
	})

	it('leaves a session that is already running alone when its agent is un-ticked', async () => {
		const s = await setup()
		const app = appFor(s.human)
		await putGrants(app, s.ws.id, s.integrationId, on(s.agentA.id))
		const running = await s.sessionFor(s.agentA.id, { status: 'running' })

		await putGrants(app, s.ws.id, s.integrationId, on())

		const [after] = await db.select().from(sessions).where(eq(sessions.id, running.id))
		expect(after).toMatchObject({ status: 'running', completedAt: null })
		expect(after?.updatedAt).toEqual(running.updatedAt)
	})

	it('lets a workspace admin who did not paste the key change it', async () => {
		const s = await setup()
		const res = await putGrants(appFor(s.admin.id), s.ws.id, s.integrationId, on(s.agentB.id))
		expect(res.status).toBe(200)
		expect((await scopeRows(s))[0]?.actorId).toBe(s.admin.id)
	})

	it('answers 403 to an agent caller, even one the key is granted to, and writes nothing', async () => {
		const s = await setup()
		await putGrants(appFor(s.human), s.ws.id, s.integrationId, on(s.agentA.id))
		const res = await putGrants(
			appFor(s.agentA.id, 'agent'),
			s.ws.id,
			s.integrationId,
			on(s.agentA.id, s.agentB.id),
		)
		expect(res.status).toBe(403)
		expect(await grantedIds(s.integrationId)).toEqual([s.agentA.id])
		expect(await scopeRows(s)).toHaveLength(1)
	})

	it('answers 403 to a member who is neither the creator nor an admin or owner, and writes nothing', async () => {
		const s = await setup()
		const res = await putGrants(appFor(s.member.id), s.ws.id, s.integrationId, on(s.agentA.id))
		expect(res.status).toBe(403)
		expect(await grantedIds(s.integrationId)).toEqual([])
		expect(await scopeRows(s)).toEqual([])
	})

	it('answers 400 to a grant naming an actor outside the workspace, or a person, and changes nothing', async () => {
		const s = await setup()
		const stranger = await insertActor(db, { type: 'agent' })
		for (const bad of [stranger.id, s.member.id]) {
			const res = await putGrants(appFor(s.human), s.ws.id, s.integrationId, on(s.agentA.id, bad))
			expect(res.status).toBe(400)
		}
		expect(await grantedIds(s.integrationId)).toEqual([])
		expect(await scopeRows(s)).toEqual([])
	})

	it('answers 400 to read-only access on a saved key: it is on (read_write) or off (none)', async () => {
		const s = await setup()
		const res = await putGrants(appFor(s.human), s.ws.id, s.integrationId, {
			grants: [{ actorId: s.agentA.id, access: 'read' }],
		})
		expect(res.status).toBe(400)
		expect(await grantedIds(s.integrationId)).toEqual([])
	})

	it('accepts none on a saved key: an agent switched off when everyone else has it', async () => {
		const s = await setup()
		const res = await putGrants(appFor(s.human), s.ws.id, s.integrationId, {
			grants: [{ actorId: s.agentA.id, access: 'none' }],
		})
		expect(res.status).toBe(200)
	})

	it.each([
		['an unknown field', { grants: [], extra: true }],
		['an actor id that is not a uuid', { grants: [{ actorId: 'agent-a', access: 'read_write' }] }],
		['an unknown access level', { grants: [{ actorId: crypto.randomUUID(), access: 'admin' }] }],
		['a missing list', {}],
	])('answers 400 to %s', async (_label, body) => {
		const s = await setup()
		const res = await putGrants(appFor(s.human), s.ws.id, s.integrationId, body)
		expect(res.status).toBe(400)
	})

	it('answers 400 to more than 100 grants', async () => {
		const s = await setup()
		const ids = Array.from({ length: 101 }, () => crypto.randomUUID())
		const res = await putGrants(appFor(s.human), s.ws.id, s.integrationId, on(...ids))
		expect(res.status).toBe(400)
	})

	it('answers 409 for a key still inside its undo window', async () => {
		const s = await setup()
		const session = await s.sessionFor(s.agentA.id)
		const { integrationId } = await captureChatSecret(db, kms, {
			workspaceId: s.ws.id,
			actorId: s.human,
			sessionId: session.id,
			detectedProvider: 'cloudflare',
			displayName: 'Cloudflare deploy',
			rawSecret: CANARY,
		})
		const res = await putGrants(appFor(s.human), s.ws.id, integrationId, on())
		expect(res.status).toBe(409)
		// Captured in chat: the session's own agent holds it until a person changes that.
		expect(await grantedIds(integrationId)).toEqual([session.actorId])
	})

	it('answers 409 for an undone key', async () => {
		const s = await setup()
		await db
			.update(integrations)
			.set({ status: 'undone', credentials: null, dekCiphertext: null })
			.where(eq(integrations.id, s.integrationId))
		const res = await putGrants(appFor(s.human), s.ws.id, s.integrationId, on(s.agentA.id))
		expect(res.status).toBe(409)
		expect(await grantedIds(s.integrationId)).toEqual([])
	})

	it('answers 404 for a key in another workspace and for an id that does not exist', async () => {
		const s = await setup()
		const other = await setup()
		const wrongWorkspace = await putGrants(appFor(s.human), other.ws.id, s.integrationId, on())
		expect(wrongWorkspace.status).toBe(404)
		const missing = await putGrants(appFor(s.human), s.ws.id, crypto.randomUUID(), on())
		expect(missing.status).toBe(404)
	})

	it('lets the audit role write scope_changed while the CHECK still refuses other actions', async () => {
		const s = await setup()
		await putGrants(appFor(s.human), s.ws.id, s.integrationId, on())
		expect(await scopeRows(s)).toHaveLength(1)
		// Drizzle wraps the driver error, so the constraint name sits on the cause.
		let refused: { message?: string; cause?: { message?: string } } | null = null
		try {
			await db.insert(credentialAccessLog).values({
				workspaceId: s.ws.id,
				integrationId: s.integrationId,
				actorId: s.human,
				action: 'scope_edited' as 'scope_changed',
				source: 'admin_ui',
				requestId: 'check-refuses-unknown-action',
			})
		} catch (err) {
			refused = err as typeof refused
		}
		expect(refused).not.toBeNull()
		expect(`${refused?.message} ${refused?.cause?.message}`).toMatch(
			/credential_access_log_action_enum|violates check constraint/i,
		)
	})
})

describe('migration 0091_credential_access_log_scope_changed', () => {
	it('has a full filename no other migration uses, and the CHECK it leaves names scope_changed', async () => {
		const here = dirname(fileURLToPath(import.meta.url))
		const drizzleDir = join(here, '../../../../../packages/db/drizzle')
		const files = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql'))
		expect(new Set(files).size).toBe(files.length)
		expect(files).toContain('0091_credential_access_log_scope_changed.sql')

		const [check] = await sql`
			SELECT pg_get_constraintdef(oid) AS def, convalidated
			FROM pg_constraint
			WHERE conname = 'credential_access_log_action_enum'
		`
		expect(check?.def).toContain('scope_changed')
		expect(check?.convalidated).toBe(true)
	})
})
