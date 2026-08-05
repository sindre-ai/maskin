import { events, actors, workspaceMembers, workspaces as workspacesTable } from '@maskin/db/schema'
import { SDR_AGENT_DEFAULT } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { backfillAll, backfillOne } from '../../../scripts/backfill-sdr-agent'
import { db, getTestActorId } from './global-setup'

async function sdrAgentIdFor(workspaceId: string): Promise<string | undefined> {
	const [row] = await db
		.select({ actorId: actors.id, tools: actors.tools })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, SDR_AGENT_DEFAULT.name)),
		)
		.limit(1)
	return row?.actorId
}

async function sdrAgentToolsFor(workspaceId: string): Promise<Record<string, unknown> | undefined> {
	const [row] = await db
		.select({ tools: actors.tools })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, SDR_AGENT_DEFAULT.name)),
		)
		.limit(1)
	return row?.tools as Record<string, unknown> | undefined
}

async function createWorkspace(name: string, overrides: { createdBy?: string | null } = {}) {
	const [ws] = await db
		.insert(workspacesTable)
		.values({
			name,
			createdBy: overrides.createdBy === undefined ? getTestActorId() : overrides.createdBy,
			settings: {},
		})
		.returning()
	if (ws.createdBy) {
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: ws.createdBy, role: 'owner' })
	}
	return ws
}

describe('backfill-sdr-agent backfillOne (integration)', () => {
	it('creates the SDR agent with the linkedin capability in a workspace that has none', async () => {
		const ws = await createWorkspace('Backfill Fresh SDR')

		const result = await backfillOne(db, ws.id)

		expect(result.outcome).toBe('created')
		expect(result.sdrActorId).toBeTruthy()

		const tools = await sdrAgentToolsFor(ws.id)
		expect(tools).toBeDefined()
		const capabilities = (tools as { capabilities?: string[] } | undefined)?.capabilities
		expect(capabilities).toContain('linkedin')
	})

	it('emits a workspace.updated audit event on creation', async () => {
		const ws = await createWorkspace('Backfill Audit SDR')

		await backfillOne(db, ws.id)

		const auditRows = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityType, 'workspace')))
		const sdrEvent = auditRows.find(
			(e) => (e.data as { field?: string } | null)?.field === 'sdr_agent_actor_id',
		)
		expect(sdrEvent).toBeDefined()
		expect((sdrEvent?.data as { previous?: unknown }).previous).toBeNull()
		expect(typeof (sdrEvent?.data as { next?: unknown }).next).toBe('string')
	})

	it('is idempotent — a second call is a no-op and reuses the same actor', async () => {
		const ws = await createWorkspace('Backfill Idempotent SDR')

		const first = await backfillOne(db, ws.id)
		const firstId = await sdrAgentIdFor(ws.id)
		expect(first.outcome).toBe('created')

		const second = await backfillOne(db, ws.id)
		const secondId = await sdrAgentIdFor(ws.id)

		expect(second.outcome).toBe('alreadyExisted')
		expect(secondId).toBe(firstId)

		// And it must not duplicate the audit event.
		const sdrEvents = (
			await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, ws.id), eq(events.entityType, 'workspace')))
		).filter((e) => (e.data as { field?: string } | null)?.field === 'sdr_agent_actor_id')
		expect(sdrEvents).toHaveLength(1)
	})

	it('skips a workspace with no created_by actor without throwing', async () => {
		const ws = await createWorkspace('Backfill No Owner SDR', { createdBy: null })

		const result = await backfillOne(db, ws.id)

		expect(result.outcome).toBe('skippedNoOwner')
		expect(await sdrAgentIdFor(ws.id)).toBeUndefined()
	})

	it('throws when the workspace does not exist', async () => {
		await expect(backfillOne(db, '00000000-0000-0000-0000-000000000009')).rejects.toThrow(
			/not found/,
		)
	})
})

describe('backfill-sdr-agent backfillAll (integration)', () => {
	it('creates SDR agents across every workspace and returns an accurate summary', async () => {
		const a = await createWorkspace('Sweep A')
		const b = await createWorkspace('Sweep B')
		const c = await createWorkspace('Sweep C No Owner', { createdBy: null })

		const result = await backfillAll(db)

		expect(result.created).toBeGreaterThanOrEqual(2)
		expect(result.skippedNoOwner).toBeGreaterThanOrEqual(1)
		expect(result.failed).toBe(0)
		expect(await sdrAgentIdFor(a.id)).toBeTruthy()
		expect(await sdrAgentIdFor(b.id)).toBeTruthy()
		expect(await sdrAgentIdFor(c.id)).toBeUndefined()
	})

	it('is idempotent across the whole sweep', async () => {
		await createWorkspace('Sweep Idempotent')

		const first = await backfillAll(db)
		expect(first.created).toBeGreaterThanOrEqual(1)

		const second = await backfillAll(db)
		expect(second.created).toBe(0)
	})
})
