import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileKmsProvider } from '@maskin/auth/kms'
import {
	type ScopeGrant,
	accessRequests,
	events,
	integrations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { KeychainGrantExpirySweeperJob } from '../../jobs/keychain-grant-expiry-sweeper'
import { listRequestableAccess } from '../../lib/integrations/access-requests'
import { createByoApiKey } from '../../lib/integrations/byo-apikey'
import {
	insertCredentialAccessLog,
	verifyCredentialAccessChain,
} from '../../lib/integrations/credential-audit'
import { formatCredentialLogDetail } from '../../lib/integrations/credential-log-detail'
import { ScopeDeniedError } from '../../lib/integrations/errors'
import { getCredential } from '../../lib/integrations/lookup'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

// Expiry of an access-request grant. It is enforced at read time (getCredential and the
// launch-time env build), and a sweeper writes one grant_expired row per expired grant.
// A token already in a running session stays usable until that session ends: nothing here
// pulls a credential out of a live container.

// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const fake = (label: string) => `fake-${label}-${'0123456789'.repeat(3)}`

const HOUR = 3_600_000
const inAnHour = () => new Date(Date.now() + HOUR).toISOString()
const anHourAgo = () => new Date(Date.now() - HOUR).toISOString()

let dir: string
let kms: LocalFileKmsProvider
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'grant-expiry-kek-'))
	kms = new LocalFileKmsProvider(join(dir, 'kek'))
	setKmsProviderForTests(kms)
})
afterAll(() => {
	setKmsProviderForTests(undefined)
	rmSync(dir, { recursive: true, force: true })
})

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
	const agent = await insertActor(db, { type: 'agent', systemPrompt: 'Agent' })
	const approver = await insertActor(db, { type: 'agent', systemPrompt: 'Approver' })
	await db.insert(workspaceMembers).values([
		{ workspaceId: ws.id, actorId: agent.id, role: 'member' },
		{ workspaceId: ws.id, actorId: approver.id, role: 'member' },
	])
	const sessionRow = await insertSession(db, ws.id, agent.id, human, {
		status: 'pending',
		containerId: null,
	})
	const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionRow.id))
	return { human, ws, agent, approver, session: session as typeof sessions.$inferSelect }
}
type World = Awaited<ReturnType<typeof setup>>

/** A key vaulted the way the Keychain paste form does, then given exact grants. */
async function vaultKey(
	w: World,
	name: string,
	value: string,
	grants: ScopeGrant[],
	tier: 1 | 2 | 3 | null = null,
) {
	const { integrationId } = await createByoApiKey(db, kms, {
		workspaceId: w.ws.id,
		actorId: w.human,
		displayName: name,
		rawSecret: value,
	})
	await db.update(integrations).set({ scopeGrants: grants, tier }).where(eq(integrations.id, integrationId))
	return integrationId
}

const setGrants = (integrationId: string, grants: ScopeGrant[]) =>
	db.update(integrations).set({ scopeGrants: grants }).where(eq(integrations.id, integrationId))

const readCtx = (w: World) => ({
	requestingActorId: w.agent.id,
	sessionId: w.session.id,
	requestId: `req-${randomUUID()}`,
})

async function launchEnv(session: typeof sessions.$inferSelect) {
	const manager = new SessionManager(db, stubStorage())
	try {
		return (await manager.buildLaunchSpec(session)).env
	} finally {
		await manager.stop()
	}
}

const logRows = (workspaceId: string) =>
	sql<{ id: string; action: string; detail: string | null; request_id: string; actor_id: string }[]>`
		SELECT id::text, action, detail, request_id, actor_id::text
		FROM credential_access_log WHERE workspace_id = ${workspaceId} ORDER BY id
	`

const deniedEvents = (workspaceId: string) =>
	db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.action, 'credential_scope_denied')))

describe('getCredential: expiry', () => {
	it('honors a grant that has not expired', async () => {
		const w = await setup()
		const id = await vaultKey(w, 'Live key', fake('live'), [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: inAnHour(), grantId: randomUUID() },
		])
		const cred = await getCredential(db, w.ws.id, id, readCtx(w), { kms })
		expect(cred.value).toBe(fake('live'))
	})

	it('refuses a grant whose expiresAt has passed: scope denied, no audit row, one denied event', async () => {
		const w = await setup()
		const id = await vaultKey(w, 'Expired key', fake('expired'), [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo(), grantId: randomUUID() },
		])
		await expect(getCredential(db, w.ws.id, id, readCtx(w), { kms })).rejects.toBeInstanceOf(
			ScopeDeniedError,
		)
		expect((await logRows(w.ws.id)).filter((r) => r.action === 'read')).toHaveLength(0)
		expect(await deniedEvents(w.ws.id)).toHaveLength(1)
	})

	it('refuses a grant that expires at this very instant', async () => {
		const w = await setup()
		const id = await vaultKey(w, 'Boundary key', fake('boundary'), [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: new Date().toISOString() },
		])
		await expect(getCredential(db, w.ws.id, id, readCtx(w), { kms })).rejects.toBeInstanceOf(
			ScopeDeniedError,
		)
	})

	it('fails closed on an expiresAt that does not parse', async () => {
		const w = await setup()
		const id = await vaultKey(w, 'Damaged key', fake('damaged'), [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: 'next tuesday' },
		])
		await expect(getCredential(db, w.ws.id, id, readCtx(w), { kms })).rejects.toBeInstanceOf(
			ScopeDeniedError,
		)
	})

	it('still reads through a second, live grant for the same actor when the first has expired', async () => {
		const w = await setup()
		const id = await vaultKey(w, 'Renewed key', fake('renewed'), [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo(), grantId: randomUUID() },
			{ kind: 'actor', actorId: w.agent.id, expiresAt: inAnHour(), grantId: randomUUID() },
		])
		const cred = await getCredential(db, w.ws.id, id, readCtx(w), { kms })
		expect(cred.value).toBe(fake('renewed'))
	})

	it('never expires a grant that carries no expiresAt, or a workspace grant', async () => {
		const w = await setup()
		const standing = await vaultKey(w, 'Standing key', fake('standing'), [
			{ kind: 'actor', actorId: w.agent.id },
		])
		const open = await vaultKey(w, 'Open key', fake('open'), [{ kind: 'workspace' }])
		expect((await getCredential(db, w.ws.id, standing, readCtx(w), { kms })).value).toBe(
			fake('standing'),
		)
		expect((await getCredential(db, w.ws.id, open, readCtx(w), { kms })).value).toBe(fake('open'))
	})
})

describe('launch-time env build: expiry', () => {
	it('holds the credential variable while the grant is live and drops it once the grant expires', async () => {
		const w = await setup()
		const value = fake('smoke')
		const grant = { kind: 'actor', actorId: w.agent.id, grantId: randomUUID() } as const
		const id = await vaultKey(w, 'Smoke', value, [{ ...grant, expiresAt: inAnHour() }])

		const before = await launchEnv(w.session)
		expect(before.KEYCHAIN_BYO_APIKEY_SMOKE).toBe(value)

		// The same grant, let to run out.
		await setGrants(id, [{ ...grant, expiresAt: anHourAgo() }])

		const after = await launchEnv(w.session)
		expect(Object.keys(after).filter((k) => k.startsWith('KEYCHAIN_'))).toEqual([])
		expect(JSON.stringify(after)).not.toContain(value)
		// Dropped by the launch query itself, so no denied read is raised on every launch.
		expect(await deniedEvents(w.ws.id)).toHaveLength(0)
	})

	it('keeps a key that a workspace grant still opens, even beside an expired actor grant', async () => {
		const w = await setup()
		const value = fake('both')
		await vaultKey(w, 'Both', value, [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo(), grantId: randomUUID() },
			{ kind: 'workspace' },
		])
		expect((await launchEnv(w.session)).KEYCHAIN_BYO_APIKEY_BOTH).toBe(value)
	})
})

describe('listRequestableAccess: expiry', () => {
	it('offers a credential again once the actor grant has expired, and hides it while live', async () => {
		const w = await setup()
		const id = await vaultKey(
			w,
			'Requestable',
			fake('req'),
			[{ kind: 'actor', actorId: w.agent.id, expiresAt: inAnHour(), grantId: randomUUID() }],
			1,
		)
		expect((await listRequestableAccess(db, w.ws.id, w.agent.id)).map((c) => c.id)).not.toContain(id)

		await setGrants(id, [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo(), grantId: randomUUID() },
		])
		expect((await listRequestableAccess(db, w.ws.id, w.agent.id)).map((c) => c.id)).toContain(id)
	})
})

describe('use rows made under a grant', () => {
	it('carry the grant id in the detail text, and a read under no grant id keeps detail NULL', async () => {
		const w = await setup()
		const grantId = randomUUID()
		const granted = await vaultKey(w, 'Granted', fake('granted'), [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: inAnHour(), grantId },
		])
		const standing = await vaultKey(w, 'Standing', fake('standing2'), [
			{ kind: 'actor', actorId: w.agent.id },
		])

		await getCredential(db, w.ws.id, granted, readCtx(w), { kms })
		await getCredential(db, w.ws.id, standing, readCtx(w), { kms })

		const reads = (await logRows(w.ws.id)).filter((r) => r.action === 'read')
		expect(reads.map((r) => r.detail)).toEqual([formatCredentialLogDetail({ grant: grantId }), null])
		expect(reads[0]?.detail).toBe(`approver=;grant=${grantId};tier=;ext=`)
	})

	it('are written once per launch, not once per call', async () => {
		const w = await setup()
		const grantId = randomUUID()
		await vaultKey(w, 'Per session', fake('persession'), [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: inAnHour(), grantId },
		])

		await launchEnv(w.session)

		const reads = (await logRows(w.ws.id)).filter((r) => r.action === 'read')
		expect(reads).toHaveLength(1)
		expect(reads[0]?.detail).toBe(`approver=;grant=${grantId};tier=;ext=`)
		expect(reads[0]?.request_id.startsWith(`launch:${w.session.id}:`)).toBe(true)
	})
})

describe('grant expiry sweeper', () => {
	const sweeper = () => new KeychainGrantExpirySweeperJob(db)
	const expiredRows = async (w: World) =>
		(await logRows(w.ws.id)).filter((r) => r.action === 'grant_expired')

	async function requestFor(w: World, integrationId: string, grantId: string) {
		await db.insert(accessRequests).values({
			workspaceId: w.ws.id,
			requesterActorId: w.agent.id,
			integrationId,
			tier: 1,
			requestedDuration: '1h',
			reason: 'needs the key',
			status: 'approved',
			approverActorId: w.approver.id,
			decidedAt: new Date(),
			grantId,
		})
	}

	it('writes one grant_expired row with the canonical detail, from the request that made the grant', async () => {
		const w = await setup()
		const grantId = randomUUID()
		const id = await vaultKey(
			w,
			'Sweep one',
			fake('sweep1'),
			[{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo(), grantId }],
			1,
		)
		await requestFor(w, id, grantId)

		await sweeper().tick()

		const rows = await expiredRows(w)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			actor_id: w.agent.id,
			request_id: `grant_expired:${grantId}`,
			detail: formatCredentialLogDetail({ approver: w.approver.id, grant: grantId, tier: 1 }),
		})
		expect(rows[0]?.detail).toBe(`approver=${w.approver.id};grant=${grantId};tier=1;ext=`)
	})

	it('is idempotent: a second and third run write nothing for a grant already on the chain', async () => {
		const w = await setup()
		const grantId = randomUUID()
		await vaultKey(w, 'Sweep twice', fake('sweep2'), [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo(), grantId },
		])

		await sweeper().tick()
		await sweeper().tick()
		await sweeper().tick()

		expect(await expiredRows(w)).toHaveLength(1)
	})

	it('writes one row only when two runs overlap', async () => {
		const w = await setup()
		await vaultKey(w, 'Sweep race', fake('sweep3'), [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo(), grantId: randomUUID() },
		])

		await Promise.all([new KeychainGrantExpirySweeperJob(db).tick(), new KeychainGrantExpirySweeperJob(db).tick()])

		expect(await expiredRows(w)).toHaveLength(1)
	})

	it('writes one row per expired grant, and none for a live grant or an entry without a grant id', async () => {
		const w = await setup()
		const a = randomUUID()
		const b = randomUUID()
		const id = await vaultKey(w, 'Sweep many', fake('sweep4'), [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo(), grantId: a },
			{ kind: 'actor', actorId: w.approver.id, expiresAt: anHourAgo(), grantId: b },
			{ kind: 'actor', actorId: w.agent.id, expiresAt: inAnHour(), grantId: randomUUID() },
			{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo() },
			{ kind: 'actor', actorId: w.agent.id },
			{ kind: 'workspace' },
		])

		await sweeper().tick()

		const rows = await expiredRows(w)
		expect(rows.map((r) => r.request_id).sort()).toEqual([`grant_expired:${a}`, `grant_expired:${b}`].sort())
		// A grant with no access request behind it records only what it knows.
		expect(rows.find((r) => r.request_id === `grant_expired:${a}`)?.detail).toBe(
			`approver=;grant=${a};tier=;ext=`,
		)
		// The entries stay where they are: expiry is enforced at read time, the log is the record.
		const [after] = await db.select().from(integrations).where(eq(integrations.id, id))
		expect(after?.scopeGrants).toHaveLength(6)
	})

	it('logs a grant that is renewed and then expires again once per grant id', async () => {
		const w = await setup()
		const first = randomUUID()
		const second = randomUUID()
		const id = await vaultKey(w, 'Sweep renewed', fake('sweep5'), [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo(), grantId: first },
		])
		await sweeper().tick()
		await setGrants(id, [
			{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo(), grantId: first },
			{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo(), grantId: second },
		])
		await sweeper().tick()

		expect((await expiredRows(w)).map((r) => r.request_id)).toEqual([
			`grant_expired:${first}`,
			`grant_expired:${second}`,
		])
	})
})

describe('audit chain across a grant sequence', () => {
	it('verifies from genesis over NULL-detail rows then request, approve, use and expiry rows, and fails at the row whose detail is edited', async () => {
		const w = await setup()
		const grantId = randomUUID()
		const id = await vaultKey(
			w,
			'Chain key',
			fake('chain'),
			[{ kind: 'actor', actorId: w.agent.id }],
			1,
		)

		// Rows with no detail: a plain read under a standing grant.
		await getCredential(db, w.ws.id, id, readCtx(w), { kms })
		// The grant sequence. The request and approve rows are written the way the
		// request and approve routes write them.
		for (const [action, detail] of [
			['grant_requested', formatCredentialLogDetail({ tier: 1 })],
			['grant_approved', formatCredentialLogDetail({ approver: w.approver.id, grant: grantId, tier: 1 })],
		] as const) {
			await db.transaction((tx) =>
				insertCredentialAccessLog(tx, {
					workspaceId: w.ws.id,
					integrationId: id,
					actorId: w.agent.id,
					action,
					source: 'admin_ui',
					requestId: `test:${action}`,
					detail,
				}),
			)
		}
		// Use under the grant (the launch-time read row), then its expiry.
		await setGrants(id, [{ kind: 'actor', actorId: w.agent.id, expiresAt: inAnHour(), grantId }])
		await getCredential(db, w.ws.id, id, readCtx(w), { kms })
		await setGrants(id, [{ kind: 'actor', actorId: w.agent.id, expiresAt: anHourAgo(), grantId }])
		await new KeychainGrantExpirySweeperJob(db).tick()

		const rows = await logRows(w.ws.id)
		expect(rows.map((r) => r.action)).toEqual([
			'create',
			'read',
			'grant_requested',
			'grant_approved',
			'read',
			'grant_expired',
		])
		expect(rows.map((r) => r.detail === null)).toEqual([true, true, false, false, false, false])
		expect(await verifyCredentialAccessChain(db, w.ws.id)).toMatchObject({ ok: true, rows: 6 })

		// Edit detail on each row in turn, as the table owner (the app role could not).
		for (const row of rows) {
			await sql`UPDATE credential_access_log SET detail = 'approver=;grant=;tier=3;ext=' WHERE id = ${row.id}::bigint`
			expect(await verifyCredentialAccessChain(db, w.ws.id)).toMatchObject({
				ok: false,
				brokenAtId: row.id,
			})
			await sql`UPDATE credential_access_log SET detail = ${row.detail} WHERE id = ${row.id}::bigint`
			expect(await verifyCredentialAccessChain(db, w.ws.id)).toMatchObject({ ok: true, rows: 6 })
		}
	})
})
