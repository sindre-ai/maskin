import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenAPIHono } from '@hono/zod-openapi'
import { LocalFileKmsProvider } from '@maskin/auth/kms'
import {
	events,
	type ScopeGrant,
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
import integrationsKeychainRoutes from '../../routes/integrations-keychain'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const CANARY = `fake-scope-${'0123456789'.repeat(3)}`

let dir: string
let kms: LocalFileKmsProvider
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'keychain-scope-kek-'))
	kms = new LocalFileKmsProvider(join(dir, 'kek'))
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
	app.route('/api/integrations', integrationsKeychainRoutes)
	return app
}

function putScope(
	app: ReturnType<typeof appFor>,
	workspaceId: string,
	integrationId: string,
	body: unknown,
) {
	return app.request(`/api/integrations/${integrationId}/scope`, {
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
	const sessionFor = async (actorId: string, overrides: Record<string, unknown> = {}) => {
		const s = await insertSession(db, ws.id, actorId, human, {
			status: 'pending',
			containerId: null,
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

const actorGrant = (actorId: string): ScopeGrant => ({ kind: 'actor', actorId })

async function launchEnv(session: typeof sessions.$inferSelect) {
	const manager = new SessionManager(db, stubStorage())
	try {
		return (await manager.buildLaunchSpec(session)).env
	} finally {
		await manager.stop()
	}
}

const grantsOf = async (id: string) =>
	(await db.select().from(integrations).where(eq(integrations.id, id)))[0]?.scopeGrants

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

describe('PUT /api/integrations/:id/scope (Integration)', () => {
	it('replaces the grants, writes one scope_changed audit row and one event, and keeps the chain intact', async () => {
		const s = await setup()
		const res = await putScope(appFor(s.human), s.ws.id, s.integrationId, {
			scopeGrants: [actorGrant(s.agentA.id)],
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual({ id: s.integrationId, scopeGrants: [actorGrant(s.agentA.id)] })
		expect(await grantsOf(s.integrationId)).toEqual([actorGrant(s.agentA.id)])

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
			(e) => (e.data as { change?: string } | null)?.change === 'scope_grants',
		)
		expect(change).toMatchObject({ action: 'updated', actorId: s.human })
		expect(change?.data).toMatchObject({
			scope_grants_before: [actorGrant(s.human)],
			scope_grants_after: [actorGrant(s.agentA.id)],
		})

		const [row] = await db.select().from(integrations).where(eq(integrations.id, s.integrationId))
		const everything = JSON.stringify([body, rows, evs], (_k, v) =>
			typeof v === 'bigint' ? v.toString() : v,
		)
		expect(everything).not.toContain(CANARY)
		expect(everything).not.toContain(row?.credentials ?? 'no-credentials')
		expect(everything).not.toContain(row?.dekCiphertext ?? 'no-dek')
		expect(Object.keys(body as object).sort()).toEqual(['id', 'scopeGrants'])
	})

	it('writes one audit row per save, each with its own request id, and the chain still verifies', async () => {
		const s = await setup()
		const app = appFor(s.human)
		for (const grants of [[actorGrant(s.agentA.id)], [], [{ kind: 'workspace' }]]) {
			const res = await putScope(app, s.ws.id, s.integrationId, { scopeGrants: grants })
			expect(res.status).toBe(200)
		}
		const rows = await scopeRows(s)
		expect(rows).toHaveLength(3)
		expect(new Set(rows.map((r) => r.requestId)).size).toBe(3)
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 4 })
	})

	it('accepts an empty list as unassigned, and a workspace grant as every agent', async () => {
		const s = await setup()
		const sessionA = await s.sessionFor(s.agentA.id)
		const app = appFor(s.human)

		expect((await putScope(app, s.ws.id, s.integrationId, { scopeGrants: [] })).status).toBe(200)
		expect(await grantsOf(s.integrationId)).toEqual([])
		expect(Object.keys(await launchEnv(sessionA)).filter((k) => k.startsWith('KEYCHAIN_'))).toEqual(
			[],
		)

		const all = [{ kind: 'workspace' }]
		expect((await putScope(app, s.ws.id, s.integrationId, { scopeGrants: all })).status).toBe(200)
		expect(await grantsOf(s.integrationId)).toEqual(all)
		expect((await launchEnv(sessionA)).KEYCHAIN_BYO_APIKEY_COOLIFY).toBe(CANARY)
	})

	it('stores each grant once', async () => {
		const s = await setup()
		const res = await putScope(appFor(s.human), s.ws.id, s.integrationId, {
			scopeGrants: [
				actorGrant(s.agentA.id),
				actorGrant(s.agentA.id),
				{ kind: 'workspace' },
				{ kind: 'workspace' },
			],
		})
		expect(res.status).toBe(200)
		expect(await grantsOf(s.integrationId)).toEqual([
			actorGrant(s.agentA.id),
			{ kind: 'workspace' },
		])
	})

	it('hands the key to the ticked agent for the next session, and takes it away when un-ticked', async () => {
		const s = await setup()
		const app = appFor(s.human)
		const sessionA = await s.sessionFor(s.agentA.id)
		const sessionB = await s.sessionFor(s.agentB.id)

		await putScope(app, s.ws.id, s.integrationId, { scopeGrants: [actorGrant(s.agentA.id)] })
		expect((await launchEnv(sessionA)).KEYCHAIN_BYO_APIKEY_COOLIFY).toBe(CANARY)
		const envB = await launchEnv(sessionB)
		expect(Object.keys(envB).filter((k) => k.startsWith('KEYCHAIN_'))).toEqual([])
		expect(JSON.stringify(envB)).not.toContain(CANARY)

		await putScope(app, s.ws.id, s.integrationId, { scopeGrants: [] })
		const after = await launchEnv(await s.sessionFor(s.agentA.id))
		expect(Object.keys(after).filter((k) => k.startsWith('KEYCHAIN_'))).toEqual([])
	})

	it('leaves a session that is already running alone when its agent is un-ticked', async () => {
		const s = await setup()
		const app = appFor(s.human)
		await putScope(app, s.ws.id, s.integrationId, { scopeGrants: [actorGrant(s.agentA.id)] })
		const running = await s.sessionFor(s.agentA.id, { status: 'running' })

		await putScope(app, s.ws.id, s.integrationId, { scopeGrants: [] })

		const [after] = await db.select().from(sessions).where(eq(sessions.id, running.id))
		expect(after).toMatchObject({ status: 'running', completedAt: null })
		expect(after?.updatedAt).toEqual(running.updatedAt)
	})

	it('lets a workspace admin who did not paste the key change it', async () => {
		const s = await setup()
		const res = await putScope(appFor(s.admin.id), s.ws.id, s.integrationId, {
			scopeGrants: [actorGrant(s.agentB.id)],
		})
		expect(res.status).toBe(200)
		const rows = await scopeRows(s)
		expect(rows[0]?.actorId).toBe(s.admin.id)
	})

	it('answers 403 to an agent caller, even one the key is granted to, and writes nothing', async () => {
		const s = await setup()
		await putScope(appFor(s.human), s.ws.id, s.integrationId, {
			scopeGrants: [actorGrant(s.agentA.id)],
		})
		const res = await putScope(appFor(s.agentA.id, 'agent'), s.ws.id, s.integrationId, {
			scopeGrants: [{ kind: 'workspace' }],
		})
		expect(res.status).toBe(403)
		expect(await grantsOf(s.integrationId)).toEqual([actorGrant(s.agentA.id)])
		expect(await scopeRows(s)).toHaveLength(1)
	})

	it('answers 403 to a member who is neither the creator nor an admin or owner, and writes nothing', async () => {
		const s = await setup()
		const res = await putScope(appFor(s.member.id), s.ws.id, s.integrationId, {
			scopeGrants: [actorGrant(s.member.id)],
		})
		expect(res.status).toBe(403)
		expect(await grantsOf(s.integrationId)).toEqual([actorGrant(s.human)])
		expect(await scopeRows(s)).toEqual([])
	})

	it('answers 400 to a grant naming an actor outside the workspace, and changes nothing', async () => {
		const s = await setup()
		const stranger = await insertActor(db, { type: 'agent' })
		const res = await putScope(appFor(s.human), s.ws.id, s.integrationId, {
			scopeGrants: [actorGrant(s.agentA.id), actorGrant(stranger.id)],
		})
		expect(res.status).toBe(400)
		expect(await grantsOf(s.integrationId)).toEqual([actorGrant(s.human)])
		expect(await scopeRows(s)).toEqual([])
	})

	it.each([
		['an unknown field', { scopeGrants: [], extra: true }],
		['a loop grant', { scopeGrants: [{ kind: 'loop', loopId: crypto.randomUUID() }] }],
		['an actor id that is not a uuid', { scopeGrants: [{ kind: 'actor', actorId: 'agent-a' }] }],
		['a missing list', {}],
	])('answers 400 to %s', async (_label, body) => {
		const s = await setup()
		const res = await putScope(appFor(s.human), s.ws.id, s.integrationId, body)
		expect(res.status).toBe(400)
		expect(await grantsOf(s.integrationId)).toEqual([actorGrant(s.human)])
	})

	it('answers 400 to more than 25 grants', async () => {
		const s = await setup()
		const grants = Array.from({ length: 26 }, () => actorGrant(crypto.randomUUID()))
		const res = await putScope(appFor(s.human), s.ws.id, s.integrationId, { scopeGrants: grants })
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
		const res = await putScope(appFor(s.human), s.ws.id, integrationId, { scopeGrants: [] })
		expect(res.status).toBe(409)
		expect((await grantsOf(integrationId))?.length).toBe(1)
	})

	it('answers 409 for an undone key', async () => {
		const s = await setup()
		await db
			.update(integrations)
			.set({ status: 'undone', credentials: null, dekCiphertext: null })
			.where(eq(integrations.id, s.integrationId))
		const res = await putScope(appFor(s.human), s.ws.id, s.integrationId, { scopeGrants: [] })
		expect(res.status).toBe(409)
		expect(await grantsOf(s.integrationId)).toEqual([actorGrant(s.human)])
	})

	it('answers 409 for an OAuth connection and leaves its workspace grant alone', async () => {
		const s = await setup()
		const [oauth] = await db
			.insert(integrations)
			.values({
				workspaceId: s.ws.id,
				provider: 'google-meet',
				status: 'active',
				credentials: 'legacy-ciphertext',
				scopeGrants: [{ kind: 'workspace' }],
				createdBy: s.human,
			})
			.returning()
		const res = await putScope(appFor(s.human), s.ws.id, oauth?.id ?? '', { scopeGrants: [] })
		expect(res.status).toBe(409)
		expect(await grantsOf(oauth?.id ?? '')).toEqual([{ kind: 'workspace' }])
	})

	it('answers 404 for a key in another workspace and for an id that does not exist', async () => {
		const s = await setup()
		const other = await setup()
		const wrongWorkspace = await putScope(appFor(s.human), other.ws.id, s.integrationId, {
			scopeGrants: [],
		})
		expect(wrongWorkspace.status).toBe(404)
		expect(await grantsOf(s.integrationId)).toEqual([actorGrant(s.human)])

		const missing = await putScope(appFor(s.human), s.ws.id, crypto.randomUUID(), {
			scopeGrants: [],
		})
		expect(missing.status).toBe(404)
	})

	it('lets the audit role write scope_changed while the CHECK still refuses other actions', async () => {
		const s = await setup()
		await putScope(appFor(s.human), s.ws.id, s.integrationId, { scopeGrants: [] })
		expect(await scopeRows(s)).toHaveLength(1)
		// drizzle wraps the Postgres error: the constraint name is on the cause, not the message.
		const refused = await db
			.insert(credentialAccessLog)
			.values({
				workspaceId: s.ws.id,
				integrationId: s.integrationId,
				actorId: s.human,
				action: 'scope_edited' as 'scope_changed',
				source: 'admin_ui',
				requestId: 'check-refuses-unknown-action',
			})
			.then(
				() => null,
				(err: Error & { cause?: Error }) => err,
			)
		expect(refused?.cause?.message ?? refused?.message).toMatch(
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
		expect(files.filter((f) => f.startsWith('0091_'))).toHaveLength(1)

		const [check] = await sql`
			SELECT pg_get_constraintdef(oid) AS def, convalidated
			FROM pg_constraint
			WHERE conname = 'credential_access_log_action_enum'
		`
		expect(check?.def).toContain('scope_changed')
		expect(check?.convalidated).toBe(true)
	})
})
