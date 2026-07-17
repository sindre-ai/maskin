import { randomUUID } from 'node:crypto'
import { events, actors, workspaceMembers, workspaces as workspacesTable } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { backfillAll } from '../../../scripts/seed-default-agent'
import { db, getTestActorId } from './global-setup'

async function chiefOfStaffIdFor(workspaceId: string): Promise<string | undefined> {
	const rows = await db
		.select({ actorId: actors.id, name: actors.name })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(eq(workspaceMembers.workspaceId, workspaceId))
	return rows.find((r) => r.name === 'Chief of Staff')?.actorId
}

async function createWorkspace(
	name: string,
	overrides: { createdBy?: string | null; settings?: Record<string, unknown> } = {},
) {
	const [ws] = await db
		.insert(workspacesTable)
		.values({
			name,
			createdBy: overrides.createdBy === undefined ? getTestActorId() : overrides.createdBy,
			settings: overrides.settings ?? {},
		})
		.returning()
	if (ws.createdBy) {
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: ws.createdBy, role: 'owner' })
	}
	return ws
}

describe('seed-default-agent backfillAll (integration)', () => {
	it('pins a workspace with no default_agent_id to a freshly created Chief of Staff actor', async () => {
		const ws = await createWorkspace('Backfill Fresh')

		const result = await backfillAll(db)

		expect(result.pinned).toBeGreaterThanOrEqual(1)
		const chiefId = await chiefOfStaffIdFor(ws.id)
		expect(chiefId).toBeDefined()

		const [row] = await db
			.select({ settings: workspacesTable.settings })
			.from(workspacesTable)
			.where(eq(workspacesTable.id, ws.id))
		expect((row?.settings as { default_agent_id?: string })?.default_agent_id).toBe(chiefId)

		const auditRows = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityType, 'workspace')))
		expect(
			auditRows.some((e) => (e.data as { field?: string } | null)?.field === 'default_agent_id'),
		).toBe(true)
	})

	it('does not overwrite a workspace that already has an explicit default_agent_id', async () => {
		const explicitAgentId = randomUUID()
		const ws = await createWorkspace('Backfill Explicit', {
			settings: { default_agent_id: explicitAgentId },
		})

		await backfillAll(db)

		const [row] = await db
			.select({ settings: workspacesTable.settings })
			.from(workspacesTable)
			.where(eq(workspacesTable.id, ws.id))
		expect((row?.settings as { default_agent_id?: string })?.default_agent_id).toBe(explicitAgentId)
	})

	it('skips a workspace with no created_by actor and does not throw', async () => {
		const ws = await createWorkspace('Backfill No Owner', { createdBy: null })

		const result = await backfillAll(db)

		expect(result.skippedNoOwner).toBeGreaterThanOrEqual(1)
		const [row] = await db
			.select({ settings: workspacesTable.settings })
			.from(workspacesTable)
			.where(eq(workspacesTable.id, ws.id))
		expect((row?.settings as { default_agent_id?: string })?.default_agent_id).toBeUndefined()
	})

	it('is idempotent — a second run pins zero additional workspaces', async () => {
		await createWorkspace('Backfill Idempotent')

		const first = await backfillAll(db)
		expect(first.pinned).toBeGreaterThanOrEqual(1)

		const second = await backfillAll(db)
		expect(second.pinned).toBe(0)
	})

	it('reuses the same Chief of Staff actor for a workspace across repeated runs', async () => {
		const ws = await createWorkspace('Backfill Reuse')

		await backfillAll(db)
		const firstChiefId = await chiefOfStaffIdFor(ws.id)

		await backfillAll(db)
		const secondChiefId = await chiefOfStaffIdFor(ws.id)

		expect(secondChiefId).toBe(firstChiefId)
	})
})
