import { randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decrypt, encrypt } from '../../lib/crypto'
import type { StoredCredentials } from '../../lib/integrations/types'
import { insertActor, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// Connecting an org that already has the App installed.
//
// GitHub installs its App once per org, so a second workspace sent to
// `installations/new` is bounced to the configure page and never triggers our
// callback. The fix routes Connect through `login/oauth/authorize` instead: the
// callback exchanges the code for a user token, asks GitHub which installations
// that user can reach, and — when there is more than one — parks the candidates
// on the pending row for the user to choose from.
//
// This exercises the finalize half against real Postgres, because that is where
// the failure modes live: the partial unique index on
// (workspace_id, provider, external_id) rejects a second row for the same
// installation, so binding must refresh in place rather than insert; and the
// pending row must be cleaned up without deleting the row just written.

const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex')

/** A fresh installation id per test, so tests never collide on the shared DB. */
function newInstallationId(): string {
	return String(Math.floor(Math.random() * 1_000_000_000) + 1)
}

/** A pending row carrying parked installation choices — the state the connect
 *  callback leaves behind when the user can reach more than one org. */
async function seedPendingSelection(
	workspaceId: string,
	actorId: string,
	choices: Array<{ installationId: string; ownerLogin: string | null }>,
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'github',
			status: 'pending',
			externalId: randomBytes(16).toString('hex'),
			credentials: encrypt(JSON.stringify({ installation_choices: choices })),
			createdBy: actorId,
		})
		.returning()
	if (!row) throw new Error('failed to seed pending selection')
	return row
}

function selectRequest(workspaceId: string, integrationId: string, installationId: string) {
	return new Request('http://localhost/api/integrations/github/select-installation', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
		body: JSON.stringify({ integration_id: integrationId, installation_id: installationId }),
	})
}

function pendingRequest(workspaceId: string, integrationId: string) {
	return new Request(
		`http://localhost/api/integrations/github/pending-selection/${integrationId}`,
		{ headers: { 'X-Workspace-Id': workspaceId } },
	)
}

const { default: integrationsRoutes } = await import('../../routes/integrations')

function buildApp() {
	return createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
}

describe('GitHub installation selection after user authorization', () => {
	let prevEncryption: string | undefined

	beforeAll(() => {
		prevEncryption = process.env.INTEGRATION_ENCRYPTION_KEY
		process.env.INTEGRATION_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY
	})

	afterAll(() => {
		process.env.INTEGRATION_ENCRYPTION_KEY = prevEncryption
	})

	it('lists the parked installations for the pending row', async () => {
		const actorId = getTestActorId()
		const workspaceId = (await insertWorkspace(db, actorId)).id
		const choices = [
			{ installationId: newInstallationId(), ownerLogin: 'sindre-ai' },
			{ installationId: newInstallationId(), ownerLogin: 'vaerksted-ai' },
		]
		const pending = await seedPendingSelection(workspaceId, actorId, choices)

		const app = buildApp()
		const res = await app.request(pendingRequest(workspaceId, pending.id))

		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			integrationId: string
			installations: Array<{ installationId: string; ownerLogin: string | null }>
		}
		expect(body.integrationId).toBe(pending.id)
		expect(body.installations).toEqual(choices)
	})

	it('binds the chosen installation and removes the pending row', async () => {
		const actorId = getTestActorId()
		const workspaceId = (await insertWorkspace(db, actorId)).id
		const chosen = newInstallationId()
		const pending = await seedPendingSelection(workspaceId, actorId, [
			{ installationId: chosen, ownerLogin: 'sindre-ai' },
			{ installationId: newInstallationId(), ownerLogin: 'vaerksted-ai' },
		])

		const app = buildApp()
		const res = await app.request(selectRequest(workspaceId, pending.id, chosen))
		expect(res.status).toBe(200)

		const [active] = await db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.provider, 'github'),
					eq(integrations.externalId, chosen),
				),
			)
		expect(active?.status).toBe('active')
		expect((active?.config as { owner_login?: string })?.owner_login).toBe('sindre-ai')

		// Credentials must be the App installation id — the user token that proved
		// entitlement is deliberately never stored.
		const creds = JSON.parse(decrypt(active?.credentials ?? '')) as StoredCredentials
		expect(creds.installation_id).toBe(chosen)
		expect(creds.accessToken).toBeUndefined()

		// The pending row existed only to carry the candidate list.
		const [leftover] = await db.select().from(integrations).where(eq(integrations.id, pending.id))
		expect(leftover).toBeUndefined()
	})

	// The authorization boundary: the parked list is GitHub's own answer to
	// "which installations can this user reach", so an id outside it must be
	// refused even though it is a well-formed installation id.
	it('refuses an installation that was not among the authorized choices', async () => {
		const actorId = getTestActorId()
		const workspaceId = (await insertWorkspace(db, actorId)).id
		const pending = await seedPendingSelection(workspaceId, actorId, [
			{ installationId: newInstallationId(), ownerLogin: 'sindre-ai' },
			{ installationId: newInstallationId(), ownerLogin: 'vaerksted-ai' },
		])
		const notOffered = newInstallationId()

		const app = buildApp()
		const res = await app.request(selectRequest(workspaceId, pending.id, notOffered))
		expect(res.status).toBe(404)

		const rows = await db
			.select()
			.from(integrations)
			.where(
				and(eq(integrations.workspaceId, workspaceId), eq(integrations.externalId, notOffered)),
			)
		expect(rows).toHaveLength(0)
	})

	// A pending row belonging to someone else's workspace must not be readable or
	// usable, even with a valid row id.
	it('does not expose a pending selection from another workspace', async () => {
		const ownerId = getTestActorId()
		const ownerWorkspace = (await insertWorkspace(db, ownerId)).id
		const otherActor = (await insertActor(db)).id
		const otherWorkspace = (await insertWorkspace(db, otherActor)).id
		const chosen = newInstallationId()
		const pending = await seedPendingSelection(ownerWorkspace, ownerId, [
			{ installationId: chosen, ownerLogin: 'sindre-ai' },
			{ installationId: newInstallationId(), ownerLogin: 'vaerksted-ai' },
		])

		const app = buildApp()
		expect((await app.request(pendingRequest(otherWorkspace, pending.id))).status).toBe(404)
		expect((await app.request(selectRequest(otherWorkspace, pending.id, chosen))).status).toBe(404)
	})

	// The partial unique index on (workspace_id, provider, external_id) makes a
	// second insert for the same installation fail at commit time, so a workspace
	// that previously disconnected this org must be refreshed in place. Only a
	// real Postgres run can catch this.
	it('reactivates a revoked row for the same installation instead of inserting', async () => {
		const actorId = getTestActorId()
		const workspaceId = (await insertWorkspace(db, actorId)).id
		const chosen = newInstallationId()

		const [revoked] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: 'github',
				status: 'revoked',
				externalId: chosen,
				credentials: encrypt(JSON.stringify({ installation_id: chosen })),
				createdBy: actorId,
			})
			.returning()

		const pending = await seedPendingSelection(workspaceId, actorId, [
			{ installationId: chosen, ownerLogin: 'sindre-ai' },
			{ installationId: newInstallationId(), ownerLogin: 'vaerksted-ai' },
		])

		const app = buildApp()
		const res = await app.request(selectRequest(workspaceId, pending.id, chosen))
		expect(res.status).toBe(200)

		const rows = await db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.provider, 'github'),
					eq(integrations.externalId, chosen),
				),
			)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.id).toBe(revoked?.id)
		expect(rows[0]?.status).toBe('active')
	})
})
