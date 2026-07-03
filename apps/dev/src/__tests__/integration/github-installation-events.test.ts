import { events, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { handleGithubInstallationEvent } from '../../lib/integrations/providers/github/installation-events'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

async function insertGithubActive(
	workspaceId: string,
	createdBy: string,
	externalId: string,
	ownerLogin: string,
	systemActorId: string,
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'github',
			status: 'active',
			externalId,
			credentials: 'encrypted-blob',
			config: { owner_login: ownerLogin, system_actor_id: systemActorId },
			createdBy,
		})
		.returning({ id: integrations.id })
	return row?.id ?? ''
}

async function insertGithubPending(workspaceId: string, createdBy: string, nonce: string) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'github',
			status: 'pending',
			externalId: nonce,
			credentials: '',
			createdBy,
		})
		.returning({ id: integrations.id })
	return row?.id ?? ''
}

describe('handleGithubInstallationEvent Integration', () => {
	let workspaceId: string
	let actorId: string
	let systemActorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		const systemActor = await insertActor(db, { name: 'GitHub', type: 'system' })
		systemActorId = systemActor.id
		await sql`DELETE FROM integrations WHERE workspace_id = ${workspaceId}`
	})

	it('revokes the superseded row and clears pending rows on installation.created', async () => {
		const previousId = await insertGithubActive(
			workspaceId,
			actorId,
			'137740772',
			'sindre-ai',
			systemActorId,
		)
		const stalePendingId = await insertGithubPending(workspaceId, actorId, 'nonce-stale')

		const result = await handleGithubInstallationEvent(db, {
			action: 'created',
			installation: { id: 141870781, account: { login: 'sindre-ai' } },
		})

		expect(result.kind).toBe('reconciled')
		expect(result.installationId).toBe('141870781')

		const previous = await db.select().from(integrations).where(eq(integrations.id, previousId))
		expect(previous[0]?.status).toBe('revoked')

		const stalePending = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, stalePendingId))
		expect(stalePending).toHaveLength(0)

		const auditEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityType, 'integration'), eq(events.entityId, previousId)))
		expect(auditEvents.length).toBeGreaterThan(0)
		const supersededEvent = auditEvents.find(
			(e) =>
				typeof e.data === 'object' &&
				e.data !== null &&
				(e.data as Record<string, unknown>).reason === 'superseded_by_reinstall',
		)
		expect(supersededEvent).toBeDefined()
	})

	it('leaves other orgs alone — a churn on org A does not touch org B', async () => {
		const orgAId = await insertGithubActive(
			workspaceId,
			actorId,
			'100000000',
			'org-a',
			systemActorId,
		)
		const orgBId = await insertGithubActive(
			workspaceId,
			actorId,
			'200000000',
			'org-b',
			systemActorId,
		)

		await handleGithubInstallationEvent(db, {
			action: 'created',
			installation: { id: 100000001, account: { login: 'org-a' } },
		})

		const orgB = await db.select().from(integrations).where(eq(integrations.id, orgBId))
		expect(orgB[0]?.status).toBe('active')

		const orgA = await db.select().from(integrations).where(eq(integrations.id, orgAId))
		expect(orgA[0]?.status).toBe('revoked')
	})

	it('marks the matching row revoked on installation.deleted', async () => {
		const activeId = await insertGithubActive(
			workspaceId,
			actorId,
			'141870781',
			'sindre-ai',
			systemActorId,
		)

		const result = await handleGithubInstallationEvent(db, {
			action: 'deleted',
			installation: { id: 141870781, account: { login: 'sindre-ai' } },
		})

		expect(result.kind).toBe('revoked')
		const remaining = await db.select().from(integrations).where(eq(integrations.id, activeId))
		expect(remaining[0]?.status).toBe('revoked')
	})

	it('ignores installation.created when no matching prior row exists', async () => {
		const result = await handleGithubInstallationEvent(db, {
			action: 'created',
			installation: { id: 141870781, account: { login: 'brand-new-org' } },
		})
		expect(result.kind).toBe('ignored')
	})
})
