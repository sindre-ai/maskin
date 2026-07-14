import { objects, relationships as relationshipsTable, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertObject, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

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

// T8 — resolveGithubRepoSlug against real Postgres. The unit tests cover the
// branching against a mocked `db.select`, but only the real-DB path proves the
// SQL renders correctly on real tables: the `activeSessionId = session.id`
// lookup on `objects`, and the `breaks_into` walk on `relationships` in either
// direction. These correlated / OR-branch reads are the bug class flagged in
// `.claude/rules/known-pitfalls.md` under "Drizzle correlated subquery
// rendering" — mocked selects can't catch them.
describe('SessionManager.resolveGithubRepoSlug — sourcing chain against real Postgres', () => {
	let workspaceId: string
	let actorId: string
	let manager: SessionManager

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		manager = new SessionManager(db, stubStorage())
	})

	afterEach(async () => {
		await manager.stop()
	})

	async function linkSessionToObject(objectId: string, sessionId: string) {
		// object.active_session_id is what resolveGithubRepoSlug queries by
		await db.update(objects).set({ activeSessionId: sessionId }).where(eq(objects.id, objectId))
	}

	it('returns bet.metadata.repo when the session is scoped to a bet directly', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			metadata: { repo: 'sindre-ai/maskin' },
		})
		const session = await insertSession(db, workspaceId, actorId, actorId)
		await linkSessionToObject(bet.id, session.id)

		const [reloaded] = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1)
		const resolved = await manager.resolveGithubRepoSlug(reloaded)

		expect(resolved).toEqual({ slug: 'sindre-ai/maskin', source: 'bet' })
	})

	it("walks breaks_into from a task to the parent bet's metadata.repo (task→bet edge)", async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			metadata: { repo: 'sindre-ai/maskin' },
		})
		const task = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			metadata: null,
		})
		await db.insert(relationshipsTable).values({
			sourceType: 'task',
			sourceId: task.id,
			targetType: 'bet',
			targetId: bet.id,
			type: 'breaks_into',
			createdBy: actorId,
		})
		const session = await insertSession(db, workspaceId, actorId, actorId)
		await linkSessionToObject(task.id, session.id)

		const [reloaded] = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1)
		const resolved = await manager.resolveGithubRepoSlug(reloaded)

		expect(resolved).toEqual({ slug: 'sindre-ai/maskin', source: 'bet' })
	})

	it('walks breaks_into from a task when the edge points the other direction (bet→task)', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			metadata: { repo: 'sindre-ai/maskin' },
		})
		const task = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			metadata: null,
		})
		await db.insert(relationshipsTable).values({
			sourceType: 'bet',
			sourceId: bet.id,
			targetType: 'task',
			targetId: task.id,
			type: 'breaks_into',
			createdBy: actorId,
		})
		const session = await insertSession(db, workspaceId, actorId, actorId)
		await linkSessionToObject(task.id, session.id)

		const [reloaded] = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1)
		const resolved = await manager.resolveGithubRepoSlug(reloaded)

		expect(resolved).toEqual({ slug: 'sindre-ai/maskin', source: 'bet' })
	})

	it('prefers the task-level override when both task.metadata.repo and parent bet.metadata.repo are set', async () => {
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			metadata: { repo: 'sindre-ai/maskin' },
		})
		const task = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			metadata: { repo: 'sindre-ai/other-repo' },
		})
		await db.insert(relationshipsTable).values({
			sourceType: 'task',
			sourceId: task.id,
			targetType: 'bet',
			targetId: bet.id,
			type: 'breaks_into',
			createdBy: actorId,
		})
		const session = await insertSession(db, workspaceId, actorId, actorId)
		await linkSessionToObject(task.id, session.id)

		const [reloaded] = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1)
		const resolved = await manager.resolveGithubRepoSlug(reloaded)

		expect(resolved).toEqual({ slug: 'sindre-ai/other-repo', source: 'task' })
	})

	it('leaves the slug null when the task has no repo and no breaks_into edge to a bet', async () => {
		const task = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			metadata: null,
		})
		const session = await insertSession(db, workspaceId, actorId, actorId)
		await linkSessionToObject(task.id, session.id)

		const [reloaded] = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1)

		// Ensure no accidental sandbox default from the host leaks into the fallback
		const original = process.env.GITHUB_REPO
		// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
		delete process.env.GITHUB_REPO
		try {
			const resolved = await manager.resolveGithubRepoSlug(reloaded)
			expect(resolved.slug).toBeNull()
			expect(resolved.source).toBe('none')
			expect(resolved.rejected).toBeUndefined()
		} finally {
			if (original === undefined) {
				// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
				delete process.env.GITHUB_REPO
			} else {
				process.env.GITHUB_REPO = original
			}
		}

		// Sanity check: our test-local `breaks_into` filter didn't sweep in
		// unrelated relationships either
		const stray = await db
			.select()
			.from(relationshipsTable)
			.where(
				and(eq(relationshipsTable.type, 'breaks_into'), eq(relationshipsTable.sourceId, task.id)),
			)
		expect(stray).toHaveLength(0)
	})
})
