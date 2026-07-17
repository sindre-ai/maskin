import { events, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { encrypt } from '../../lib/crypto'
import { persistRecoveredInstallationId } from '../../lib/integrations/providers/github/installation-recovery'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

describe('persistRecoveredInstallationId — concurrent-recovery guard against real Postgres', () => {
	async function seedIntegration(workspaceId: string, actorId: string, installationId: string) {
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: 'github',
				status: 'active',
				credentials: encrypt(JSON.stringify({ installation_id: installationId })),
				createdBy: actorId,
			})
			.returning()
		return row
	}

	it('two callers holding pre-rotation snapshots produce exactly one audit event', async () => {
		// Models the READ COMMITTED race the older application-code-only guard
		// couldn't close: both callers pass their pre-rotation snapshot check
		// before either UPDATE lands, so both would insert an
		// `installation_id_recovered` audit row. Under `SELECT … FOR UPDATE` the
		// second caller blocks on the first's row lock, re-reads the rotated
		// value, and short-circuits. Blast radius of the old guard was small
		// (extra audit row, not data corruption), but the recovery flag stays
		// off until this behaviour is in place.
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const integration = await seedIntegration(ws.id, actorId, '42')

		const [first, second] = await Promise.all([
			persistRecoveredInstallationId(db, {
				integrationId: integration.id,
				workspaceId: ws.id,
				actorId,
				expectedOldInstallationId: '42',
				newInstallationId: '9999',
				repo: 'sindre-ai/maskin',
			}),
			persistRecoveredInstallationId(db, {
				integrationId: integration.id,
				workspaceId: ws.id,
				actorId,
				expectedOldInstallationId: '42',
				newInstallationId: '9999',
				repo: 'sindre-ai/maskin',
			}),
		])

		const persistedCount = [first, second].filter((r) => r.persisted).length
		expect(persistedCount).toBe(1)

		const auditRows = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, integration.id), eq(events.entityType, 'integration')))
		const recoveryRows = auditRows.filter(
			(row) => (row.data as Record<string, unknown>)?.reason === 'installation_id_recovered',
		)
		expect(recoveryRows).toHaveLength(1)
		expect(recoveryRows[0].data).toMatchObject({
			reason: 'installation_id_recovered',
			old_installation_id: '42',
			new_installation_id: '9999',
			repo: 'sindre-ai/maskin',
		})
	})

	it('second call short-circuits when the row has already been rotated', async () => {
		// Sequential case: the FOR UPDATE re-read observes the rotated row and
		// returns { persisted: false } without touching credentials or events.
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const integration = await seedIntegration(ws.id, actorId, '42')

		const first = await persistRecoveredInstallationId(db, {
			integrationId: integration.id,
			workspaceId: ws.id,
			actorId,
			expectedOldInstallationId: '42',
			newInstallationId: '9999',
			repo: 'sindre-ai/maskin',
		})
		expect(first.persisted).toBe(true)

		const second = await persistRecoveredInstallationId(db, {
			integrationId: integration.id,
			workspaceId: ws.id,
			actorId,
			expectedOldInstallationId: '42',
			newInstallationId: '9999',
			repo: 'sindre-ai/maskin',
		})
		expect(second.persisted).toBe(false)

		const auditRows = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, integration.id), eq(events.entityType, 'integration')))
		const recoveryRows = auditRows.filter(
			(row) => (row.data as Record<string, unknown>)?.reason === 'installation_id_recovered',
		)
		expect(recoveryRows).toHaveLength(1)
	})

	it('short-circuits and skips the write when the integration row is gone', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const result = await persistRecoveredInstallationId(db, {
			integrationId: '00000000-0000-0000-0000-000000000000',
			workspaceId: ws.id,
			actorId,
			expectedOldInstallationId: '42',
			newInstallationId: '9999',
			repo: 'sindre-ai/maskin',
		})
		expect(result.persisted).toBe(false)
	})
})
