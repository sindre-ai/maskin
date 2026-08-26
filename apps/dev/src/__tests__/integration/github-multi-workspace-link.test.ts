import { createHmac, randomBytes } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrations } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decrypt, encrypt } from '../../lib/crypto'
import { propagateRecoveredInstallationId } from '../../lib/integrations/providers/github/installation-recovery'
import type { StoredCredentials } from '../../lib/integrations/types'
import { insertActor, insertWorkspace } from '../factories'
import { createMockStorageProvider } from '../setup'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// One GitHub App installation, several Maskin workspaces.
//
// GitHub installs its App once per org: a second workspace hitting "Connect"
// gets bounced to the existing installation's configure page and never triggers
// our callback, so it could never get a row. `POST /api/integrations/github/link`
// binds the existing installation instead. That only works if the DB semantics
// hold — the unique index on (workspace_id, provider, external_id) is per
// workspace, so N rows may share one external_id — and if the webhook route
// really fans out to all of them. Neither is observable through a mocked db.

const WEBHOOK_SECRET = 'test-github-webhook-secret-multi-ws'
const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		storageProvider: StorageProvider
	}
}

/** A fresh installation id per test, so tests never collide on the shared DB. */
function newInstallationId(): string {
	return String(Math.floor(Math.random() * 1_000_000_000) + 1)
}

async function seedInstallation(
	workspaceId: string,
	actorId: string,
	installationId: string,
	overrides: { status?: string; ownerLogin?: string } = {},
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'github',
			status: overrides.status ?? 'active',
			externalId: installationId,
			credentials: encrypt(JSON.stringify({ installation_id: installationId })),
			config: {
				system_actor_id: actorId,
				...(overrides.ownerLogin ? { owner_login: overrides.ownerLogin } : {}),
			},
			createdBy: actorId,
		})
		.returning()
	return row
}

function linkRequest(workspaceId: string, installationId: string) {
	return new Request('http://localhost/api/integrations/github/link', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
		body: JSON.stringify({ installation_id: installationId }),
	})
}

function linkableRequest(workspaceId: string) {
	return new Request('http://localhost/api/integrations/github/linkable', {
		headers: { 'X-Workspace-Id': workspaceId },
	})
}

async function buildApp() {
	const { default: integrationsRoutes } = await import('../../routes/integrations')
	return createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
}

async function buildWebhookApp() {
	const { webhookApp } = await import('../../routes/integrations')
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('storageProvider', createMockStorageProvider())
		await next()
	})
	app.route('/api/webhooks', webhookApp)
	return app
}

function signedGithubWebhook(body: Record<string, unknown>) {
	const raw = JSON.stringify(body)
	const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`
	return new Request('http://localhost/api/webhooks/github', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-github-event': 'pull_request',
			'x-github-delivery': randomBytes(8).toString('hex'),
			'x-hub-signature-256': signature,
		},
		body: raw,
	})
}

async function flushAsyncProcessing(): Promise<void> {
	const { __flushAsyncWebhookProcessingForTests } = await import('../../routes/integrations')
	await __flushAsyncWebhookProcessingForTests()
}

describe('GitHub App installation shared across workspaces', () => {
	let prevSecret: string | undefined
	let prevEncryption: string | undefined

	beforeAll(() => {
		prevSecret = process.env.GITHUB_APP_WEBHOOK_SECRET
		prevEncryption = process.env.INTEGRATION_ENCRYPTION_KEY
		process.env.GITHUB_APP_WEBHOOK_SECRET = WEBHOOK_SECRET
		process.env.INTEGRATION_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY
	})

	afterAll(() => {
		if (prevSecret === undefined) Reflect.deleteProperty(process.env, 'GITHUB_APP_WEBHOOK_SECRET')
		else process.env.GITHUB_APP_WEBHOOK_SECRET = prevSecret
		if (prevEncryption === undefined) {
			Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')
		} else {
			process.env.INTEGRATION_ENCRYPTION_KEY = prevEncryption
		}
	})

	it('binds one installation into a second workspace, leaving two active rows on the same external_id', async () => {
		// The partial unique index is (workspace_id, provider, external_id) — this
		// asserts it really is per workspace. A global unique on external_id would
		// fail the insert with 23505 here, and only real Postgres shows that.
		const actorId = getTestActorId()
		const installationId = newInstallationId()
		const wsA = await insertWorkspace(db, actorId)
		const wsB = await insertWorkspace(db, actorId)
		await seedInstallation(wsA.id, actorId, installationId, { ownerLogin: 'acme-org' })

		const res = await (await buildApp()).request(linkRequest(wsB.id, installationId))
		expect(res.status).toBe(200)

		const rows = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.provider, 'github'), eq(integrations.externalId, installationId)))

		expect(rows).toHaveLength(2)
		expect(rows.every((r) => r.status === 'active')).toBe(true)
		expect(new Set(rows.map((r) => r.workspaceId))).toEqual(new Set([wsA.id, wsB.id]))

		// The bound row carries usable credentials and the source's owner_login,
		// but its own workspace-scoped system actor.
		const linked = rows.find((r) => r.workspaceId === wsB.id)
		if (!linked) throw new Error('expected a row for the second workspace')
		const creds: StoredCredentials = JSON.parse(decrypt(linked.credentials))
		expect(creds.installation_id).toBe(installationId)
		expect((linked.config as { owner_login?: string }).owner_login).toBe('acme-org')
		expect((linked.config as { system_actor_id?: string }).system_actor_id).toBeTruthy()

		const audit = await db
			.select()
			.from(events)
			.where(and(eq(events.entityType, 'integration'), eq(events.entityId, linked.id)))
		expect(audit).toHaveLength(1)
		expect(audit[0].action).toBe('created')
	})

	it('delivers one webhook event per bound workspace', async () => {
		const actorId = getTestActorId()
		const installationId = newInstallationId()
		const wsA = await insertWorkspace(db, actorId)
		const wsB = await insertWorkspace(db, actorId)
		await seedInstallation(wsA.id, actorId, installationId)
		await seedInstallation(wsB.id, actorId, installationId)

		const res = await (await buildWebhookApp()).request(
			signedGithubWebhook({
				action: 'opened',
				installation: { id: Number(installationId) },
				repository: { full_name: 'acme-org/widget' },
				sender: { login: 'someone' },
				pull_request: { number: 7, title: 'Add widget', html_url: 'https://example.test/pr/7' },
			}),
		)
		expect(res.status).toBe(200)
		await flushAsyncProcessing()

		for (const workspaceId of [wsA.id, wsB.id]) {
			const delivered = await db
				.select()
				.from(events)
				.where(
					and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'github.pull_request')),
				)
			expect(delivered).toHaveLength(1)
		}
	})

	it('reactivates a previously disconnected row instead of tripping the unique index', async () => {
		const actorId = getTestActorId()
		const installationId = newInstallationId()
		const wsA = await insertWorkspace(db, actorId)
		const wsB = await insertWorkspace(db, actorId)
		await seedInstallation(wsA.id, actorId, installationId)
		// wsB connected once and disconnected — the revoked row still occupies the
		// (workspace, provider, external_id) slot, so a naive insert would 23505.
		const revoked = await seedInstallation(wsB.id, actorId, installationId, { status: 'revoked' })

		const res = await (await buildApp()).request(linkRequest(wsB.id, installationId))
		expect(res.status).toBe(200)

		const rows = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, wsB.id), eq(integrations.provider, 'github')))
		expect(rows).toHaveLength(1)
		expect(rows[0].id).toBe(revoked.id)
		expect(rows[0].status).toBe('active')
	})

	it('refuses to bind an installation the caller cannot already reach', async () => {
		// The authorization boundary: without it, any actor could bind themselves
		// to any org's installation by guessing a numeric id.
		const strangerId = (await insertActor(db)).id
		const strangerWs = await insertWorkspace(db, strangerId)
		const installationId = newInstallationId()
		await seedInstallation(strangerWs.id, strangerId, installationId)

		const mine = await insertWorkspace(db, getTestActorId())
		const res = await (await buildApp()).request(linkRequest(mine.id, installationId))
		expect(res.status).toBe(404)

		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, mine.id))
		expect(rows).toHaveLength(0)
	})

	it('rejects a non-numeric installation id', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const res = await (await buildApp()).request(linkRequest(ws.id, 'not-an-id'))
		expect(res.status).toBe(400)
	})

	it('lists reachable installations once each, flagging the ones already here', async () => {
		const actorId = getTestActorId()
		const shared = newInstallationId()
		const other = newInstallationId()
		const wsA = await insertWorkspace(db, actorId)
		const wsB = await insertWorkspace(db, actorId)
		await seedInstallation(wsA.id, actorId, shared, { ownerLogin: 'acme-org' })
		await seedInstallation(wsB.id, actorId, shared)
		await seedInstallation(wsA.id, actorId, other, { ownerLogin: 'other-org' })

		const res = await (await buildApp()).request(linkableRequest(wsB.id))
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{
			installationId: string
			ownerLogin: string | null
			alreadyLinked: boolean
		}>

		const sharedEntry = body.filter((i) => i.installationId === shared)
		expect(sharedEntry).toHaveLength(1)
		expect(sharedEntry[0].alreadyLinked).toBe(true)
		expect(sharedEntry[0].ownerLogin).toBe('acme-org')

		const otherEntry = body.filter((i) => i.installationId === other)
		expect(otherEntry).toHaveLength(1)
		expect(otherEntry[0].alreadyLinked).toBe(false)
	})

	it('propagates a recovered installation id to sibling workspaces only', async () => {
		const actorId = getTestActorId()
		const oldId = newInstallationId()
		const newId = newInstallationId()
		const unrelatedId = newInstallationId()
		const wsA = await insertWorkspace(db, actorId)
		const wsB = await insertWorkspace(db, actorId)
		const wsC = await insertWorkspace(db, actorId)
		const source = await seedInstallation(wsA.id, actorId, oldId)
		const sibling = await seedInstallation(wsB.id, actorId, oldId)
		const unrelated = await seedInstallation(wsC.id, actorId, unrelatedId)

		const result = await propagateRecoveredInstallationId(db, {
			sourceIntegrationId: source.id,
			actorId,
			expectedOldInstallationId: oldId,
			newInstallationId: newId,
			repo: 'acme-org/widget',
		})

		expect(result.updatedIntegrationIds).toEqual([sibling.id])

		const [siblingRow] = await db.select().from(integrations).where(eq(integrations.id, sibling.id))
		const siblingCreds: StoredCredentials = JSON.parse(decrypt(siblingRow.credentials))
		expect(siblingCreds.installation_id).toBe(newId)

		// The source row is the caller's own responsibility
		// (persistRecoveredInstallationId) and must not be double-written here.
		const [sourceRow] = await db.select().from(integrations).where(eq(integrations.id, source.id))
		const sourceCreds: StoredCredentials = JSON.parse(decrypt(sourceRow.credentials))
		expect(sourceCreds.installation_id).toBe(oldId)

		const [unrelatedRow] = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, unrelated.id))
		const unrelatedCreds: StoredCredentials = JSON.parse(decrypt(unrelatedRow.credentials))
		expect(unrelatedCreds.installation_id).toBe(unrelatedId)
	})
})
