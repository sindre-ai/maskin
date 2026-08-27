import {
	actors,
	toolBrokerActors,
	workspaceMembers,
	workspaceToolBrokers,
	workspaces,
} from '@maskin/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The factory's return is optional-typed; every test here needs a real row.
const newWorkspace = async () => {
	const ws = await insertWorkspace(db, getTestActorId())
	if (!ws) throw new Error('failed to insert workspace')
	return ws
}

// Real-Postgres coverage for the two constraints the provisioning logic leans on.
// Mocked DB tests cannot catch either: both are database semantics, not code
// paths, and both fail silently in the ways that matter (a duplicate toolkit
// looks fine until two sessions disagree about which one is live; a missing
// cascade leaves rows pointing at a deleted workspace).

describe('workspace_tool_brokers', () => {
	it('provisions a toolkit row for a workspace', async () => {
		const ws = await newWorkspace()

		const [row] = await db
			.insert(workspaceToolBrokers)
			.values({ workspaceId: ws.id, toolkitSlug: 'tk-a', toolkitId: 'id-a' })
			.returning()

		expect(row?.workspaceId).toBe(ws.id)
		expect(row?.status).toBe('active')
	})

	it('refuses a second toolkit for the same workspace', async () => {
		// THE constraint that makes provisioning safe under concurrency: two
		// session launches racing must converge on one toolkit, not create two.
		const ws = await newWorkspace()
		await db
			.insert(workspaceToolBrokers)
			.values({ workspaceId: ws.id, toolkitSlug: 'tk-a', toolkitId: 'id-a' })

		await expect(
			db
				.insert(workspaceToolBrokers)
				.values({ workspaceId: ws.id, toolkitSlug: 'tk-b', toolkitId: 'id-b' }),
		).rejects.toThrow()
	})

	it('lets a concurrent provisioner fall back to the existing row', async () => {
		// The shape the provisioning code actually uses: insert, ignore the
		// conflict, then read back whichever row won.
		const ws = await newWorkspace()
		await db
			.insert(workspaceToolBrokers)
			.values({ workspaceId: ws.id, toolkitSlug: 'tk-first', toolkitId: 'id-first' })

		await db
			.insert(workspaceToolBrokers)
			.values({ workspaceId: ws.id, toolkitSlug: 'tk-second', toolkitId: 'id-second' })
			.onConflictDoNothing()

		const rows = await db
			.select()
			.from(workspaceToolBrokers)
			.where(eq(workspaceToolBrokers.workspaceId, ws.id))

		expect(rows).toHaveLength(1)
		expect(rows[0]?.toolkitSlug).toBe('tk-first')
	})

	it('drops the row when its workspace is deleted', async () => {
		const ws = await newWorkspace()
		await db
			.insert(workspaceToolBrokers)
			.values({ workspaceId: ws.id, toolkitSlug: 'tk-a', toolkitId: 'id-a' })

		// workspace_members has no cascade of its own, so it would block the
		// delete before ours is ever exercised. Clearing it first keeps this test
		// about workspace_tool_brokers.
		await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws.id))
		await db.delete(workspaces).where(eq(workspaces.id, ws.id))

		const rows = await db
			.select()
			.from(workspaceToolBrokers)
			.where(eq(workspaceToolBrokers.workspaceId, ws.id))
		expect(rows).toHaveLength(0)
	})
})

describe('tool_broker_actors', () => {
	const newActor = async () => {
		const actor = await insertActor(db)
		if (!actor) throw new Error('failed to insert actor')
		return actor
	}

	it('refuses a second identity for the same actor', async () => {
		// The backend returns an API key exactly once. A duplicate identity row
		// would strand the first key with no way to read it back.
		const actor = await newActor()
		await db
			.insert(toolBrokerActors)
			.values({ actorId: actor.id, subjectId: 'subj-1', apiKey: 'encrypted-1' })

		await expect(
			db
				.insert(toolBrokerActors)
				.values({ actorId: actor.id, subjectId: 'subj-2', apiKey: 'encrypted-2' }),
		).rejects.toThrow()
	})

	it('drops the identity when its actor is deleted', async () => {
		const actor = await newActor()
		await db
			.insert(toolBrokerActors)
			.values({ actorId: actor.id, subjectId: 'subj-1', apiKey: 'encrypted-1' })

		await db.delete(actors).where(eq(actors.id, actor.id))

		const rows = await db
			.select()
			.from(toolBrokerActors)
			.where(eq(toolBrokerActors.actorId, actor.id))
		expect(rows).toHaveLength(0)
	})
})
