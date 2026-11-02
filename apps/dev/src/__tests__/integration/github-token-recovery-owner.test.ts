import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { events, integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { decrypt, encrypt } from '../../lib/crypto'
import type { StoredCredentials } from '../../lib/integrations/types'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// GET /api/integrations/:id/github-token?repo= with the recovery flag on.
// Discovery asks GitHub which install owns a caller-supplied repo; the route
// must only mint against, and persist, an install owned by the row's account.
// The sibling-row assertions need a real database: the propagate step rewrites
// every row sharing the source's external_id, which a mocked db cannot show.
// All installation ids, logins and tokens below are fake.

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

/** A fresh installation id per test, so tests never collide on the shared DB. */
function newInstallationId(): string {
	return String(Math.floor(Math.random() * 1_000_000_000) + 1)
}

async function seedRow(workspaceId: string, externalId: string, cachedId: string, owner: string) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'github',
			status: 'active',
			externalId,
			credentials: encrypt(JSON.stringify({ installation_id: cachedId })),
			config: { system_actor_id: getTestActorId(), owner_login: owner },
			createdBy: getTestActorId(),
		})
		.returning()
	return row
}

async function readRow(id: string) {
	const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
	const creds: StoredCredentials = JSON.parse(decrypt(row.credentials))
	return { credentialsBlob: row.credentials, installationId: creds.installation_id, row }
}

async function tokenRequest(workspaceId: string, integrationId: string, repo: string) {
	const { default: integrationsRoutes } = await import('../../routes/integrations')
	const app = createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
	return app.request(
		new Request(
			`http://localhost/api/integrations/${integrationId}/github-token?repo=${encodeURIComponent(repo)}`,
			{ headers: { 'X-Workspace-Id': workspaceId } },
		),
	)
}

function mockGithub(opts: { staleId: string; discovered: { id: number; login: string } }) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = String(input)
		if (url.endsWith(`/app/installations/${opts.staleId}/access_tokens`)) {
			return new Response('Not Found', { status: 404 })
		}
		if (url.includes('/repos/') && url.endsWith('/installation')) {
			return new Response(
				JSON.stringify({ id: opts.discovered.id, account: { login: opts.discovered.login } }),
				{ status: 200 },
			)
		}
		if (url.endsWith(`/app/installations/${opts.discovered.id}/access_tokens`)) {
			return new Response(JSON.stringify({ token: 'ghs_fake_recovered' }), { status: 200 })
		}
		return new Response('unexpected', { status: 500 })
	})
}

describe('GitHub token recovery checks the installation owner', () => {
	const prev = {
		flag: process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED,
		appId: process.env.GITHUB_APP_ID,
		key: process.env.GITHUB_APP_PRIVATE_KEY,
		enc: process.env.INTEGRATION_ENCRYPTION_KEY,
	}

	beforeAll(() => {
		process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED = 'true'
		process.env.GITHUB_APP_ID = '12345'
		process.env.GITHUB_APP_PRIVATE_KEY = privateKey
		process.env.INTEGRATION_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
	})

	afterAll(() => {
		process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED = prev.flag
		process.env.GITHUB_APP_ID = prev.appId
		process.env.GITHUB_APP_PRIVATE_KEY = prev.key
		process.env.INTEGRATION_ENCRYPTION_KEY = prev.enc
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('mismatched account: mints nothing and leaves the source and sibling rows untouched', async () => {
		const actorId = getTestActorId()
		const stale = newInstallationId()
		const foreign = Number(newInstallationId())
		const wsA = await insertWorkspace(db, actorId)
		const wsB = await insertWorkspace(db, actorId)
		const source = await seedRow(wsA.id, stale, stale, 'acme-org')
		const sibling = await seedRow(wsB.id, stale, stale, 'acme-org')

		const beforeSource = await readRow(source.id)
		const beforeSibling = await readRow(sibling.id)
		const fetchSpy = mockGithub({ staleId: stale, discovered: { id: foreign, login: 'other-org' } })

		const res = await tokenRequest(wsA.id, source.id, 'other-org/widget')

		expect(res.status).toBe(401)
		const text = await res.text()
		expect(text).not.toContain('ghs_fake_recovered')
		expect(JSON.parse(text).error.code).toBe('AUTH_REVOKED')
		expect(fetchSpy).not.toHaveBeenCalledWith(
			`https://api.github.com/app/installations/${foreign}/access_tokens`,
			expect.anything(),
		)

		const afterSource = await readRow(source.id)
		const afterSibling = await readRow(sibling.id)
		expect(afterSource.installationId).toBe(stale)
		expect(afterSibling.installationId).toBe(stale)
		// Byte-identical ciphertext and updated_at: nothing was written to either row.
		expect(afterSource.credentialsBlob).toBe(beforeSource.credentialsBlob)
		expect(afterSibling.credentialsBlob).toBe(beforeSibling.credentialsBlob)
		expect(afterSource.row.updatedAt).toEqual(beforeSource.row.updatedAt)
		expect(afterSibling.row.updatedAt).toEqual(beforeSibling.row.updatedAt)

		const auditRows = await db.select().from(events).where(eq(events.entityId, source.id))
		expect(auditRows.filter((e) => JSON.stringify(e.data).includes(String(foreign)))).toHaveLength(
			0,
		)
	})

	it('matching account: recovers, rewrites the source row and rotates the sibling', async () => {
		const actorId = getTestActorId()
		const stale = newInstallationId()
		const fresh = Number(newInstallationId())
		const wsA = await insertWorkspace(db, actorId)
		const wsB = await insertWorkspace(db, actorId)
		const source = await seedRow(wsA.id, stale, stale, 'acme-org')
		const sibling = await seedRow(wsB.id, stale, stale, 'acme-org')

		mockGithub({ staleId: stale, discovered: { id: fresh, login: 'Acme-Org' } })

		const res = await tokenRequest(wsA.id, source.id, 'acme-org/widget')

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ token: 'ghs_fake_recovered' })
		expect((await readRow(source.id)).installationId).toBe(String(fresh))
		expect((await readRow(sibling.id)).installationId).toBe(String(fresh))
	})
})
