import { actors, integrationTools, toolGrants } from '@maskin/db'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { loadSessionGrants } from '../../lib/tool-grants/session'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Real Postgres, because the load-bearing parts here are database constraints:
// two PARTIAL unique indexes and two cascades. A mocked client accepts anything,
// including the duplicate workspace-level row that would turn "no policy set"
// into "two conflicting policies".

const newWorkspace = async () => {
	const ws = await insertWorkspace(db, getTestActorId())
	if (!ws) throw new Error('failed to insert workspace')
	return ws
}

const newAgent = async () => {
	const actor = await insertActor(db)
	if (!actor) throw new Error('failed to insert actor')
	return actor
}

describe('tool_grants constraints', () => {
	it('stores an agent grant', async () => {
		const ws = await newWorkspace()
		const agent = await newAgent()

		const [row] = await db
			.insert(toolGrants)
			.values({ workspaceId: ws.id, actorId: agent.id, integrationRef: 'integration-slack' })
			.returning()

		expect(row?.mode).toBe('all')
		expect(row?.tools).toEqual([])
	})

	it('refuses a second grant for the same agent and integration', async () => {
		const ws = await newWorkspace()
		const agent = await newAgent()
		const values = {
			workspaceId: ws.id,
			actorId: agent.id,
			integrationRef: 'integration-slack',
		}

		await db.insert(toolGrants).values(values)
		await expect(db.insert(toolGrants).values(values)).rejects.toThrow()
	})

	it('refuses a second WORKSPACE-level row for the same integration', async () => {
		// The reason both indexes are partial. Postgres treats NULLs as distinct, so
		// a plain unique index over (workspace_id, actor_id, integration_ref) would
		// allow two rows here — and "no default" would silently become "two
		// conflicting defaults", with which one wins decided by row order.
		const ws = await newWorkspace()
		const values = { workspaceId: ws.id, actorId: null, integrationRef: 'integration-slack' }

		await db.insert(toolGrants).values(values)
		await expect(db.insert(toolGrants).values(values)).rejects.toThrow()
	})

	it('allows a workspace row and an agent row for the same integration', async () => {
		// They must coexist: the workspace row is the ceiling, the agent row the
		// grant. A single unique index over both would have made this impossible.
		const ws = await newWorkspace()
		const agent = await newAgent()

		await db
			.insert(toolGrants)
			.values({ workspaceId: ws.id, actorId: null, integrationRef: 'integration-slack' })
		await db
			.insert(toolGrants)
			.values({ workspaceId: ws.id, actorId: agent.id, integrationRef: 'integration-slack' })

		const rows = await db
			.select()
			.from(toolGrants)
			.where(
				and(eq(toolGrants.workspaceId, ws.id), eq(toolGrants.integrationRef, 'integration-slack')),
			)
		expect(rows).toHaveLength(2)
	})

	it('allows the same agent to hold grants for different integrations', async () => {
		const ws = await newWorkspace()
		const agent = await newAgent()

		await db
			.insert(toolGrants)
			.values({ workspaceId: ws.id, actorId: agent.id, integrationRef: 'integration-slack' })
		await db
			.insert(toolGrants)
			.values({ workspaceId: ws.id, actorId: agent.id, integrationRef: 'github-acme' })

		const rows = await db.select().from(toolGrants).where(eq(toolGrants.actorId, agent.id))
		expect(rows).toHaveLength(2)
	})

	it('rejects a mode outside the three we handle', async () => {
		// Resolution branches on this string; an unknown value would fall through
		// whichever branch happened to be last.
		const ws = await newWorkspace()
		const agent = await newAgent()

		await expect(
			db.insert(toolGrants).values({
				workspaceId: ws.id,
				actorId: agent.id,
				integrationRef: 'x',
				mode: 'everything',
			}),
		).rejects.toThrow()
	})

	it('removes an agent’s grants when the agent is deleted', async () => {
		// Otherwise a deleted agent's grants linger and are inherited by whatever
		// reuses the id.
		const ws = await newWorkspace()
		const agent = await newAgent()
		await db
			.insert(toolGrants)
			.values({ workspaceId: ws.id, actorId: agent.id, integrationRef: 'integration-slack' })

		await db.delete(actors).where(eq(actors.id, agent.id))

		const rows = await db.select().from(toolGrants).where(eq(toolGrants.workspaceId, ws.id))
		expect(rows).toHaveLength(0)
	})
})

describe('loadSessionGrants against real Postgres', () => {
	it('reports a workspace with no rows as unenforced', async () => {
		// The upgrade path, and the one that must not regress: no policy means the
		// workspace behaves exactly as it did before this feature existed.
		const ws = await newWorkspace()
		const agent = await newAgent()

		const grants = await loadSessionGrants(db, { workspaceId: ws.id, actorId: agent.id })

		expect(grants.enforced).toBe(false)
		expect(grants.refs.size).toBe(0)
	})

	it('enforces once a row exists, and denies what is not granted', async () => {
		const ws = await newWorkspace()
		const agent = await newAgent()
		await db
			.insert(toolGrants)
			.values({ workspaceId: ws.id, actorId: agent.id, integrationRef: 'github-acme' })

		const grants = await loadSessionGrants(db, { workspaceId: ws.id, actorId: agent.id })

		expect(grants.enforced).toBe(true)
		expect(grants.refs.has('github-acme')).toBe(true)
		expect(grants.refs.has('integration-slack')).toBe(false)
	})

	it('does not leak one agent’s grants to another', async () => {
		const ws = await newWorkspace()
		const [a, b] = [await newAgent(), await newAgent()]
		await db
			.insert(toolGrants)
			.values({ workspaceId: ws.id, actorId: a.id, integrationRef: 'integration-slack' })

		const forB = await loadSessionGrants(db, { workspaceId: ws.id, actorId: b.id })

		// B sees the workspace as enforced (a policy exists) but holds nothing.
		expect(forB.refs.has('integration-slack')).toBe(false)
	})

	it('turns a read grant into the declared read-only tools', async () => {
		const ws = await newWorkspace()
		const agent = await newAgent()
		await db.insert(integrationTools).values([
			{ workspaceId: ws.id, integrationRef: 'w1_linear', name: 'list_issues', readOnly: true },
			{ workspaceId: ws.id, integrationRef: 'w1_linear', name: 'create_issue', readOnly: false },
			{ workspaceId: ws.id, integrationRef: 'w1_linear', name: 'run_flow', readOnly: null },
		])
		await db.insert(toolGrants).values({
			workspaceId: ws.id,
			actorId: agent.id,
			integrationRef: 'w1_linear',
			mode: 'read',
		})

		const grants = await loadSessionGrants(db, { workspaceId: ws.id, actorId: agent.id })
		const [grant] = grants.resolved

		expect(grant?.tools).toEqual(['list_issues'])
		// The undeclared one is not swept in — that is what keeps "read only" honest.
		expect(grant?.tools).not.toContain('run_flow')
	})
})
