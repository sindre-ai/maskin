import {
	actors,
	agentFiles,
	files,
	imports,
	notifications,
	readState,
	sessions,
	subscriptions,
	workspaceMembers,
	workspaceSkills,
} from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import {
	buildAgentFile,
	buildFile,
	buildImport,
	buildReadState,
	buildSubscription,
	buildWorkspaceSkill,
	insertActor,
	insertNotification,
	insertSession,
	insertWorkspace,
} from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')

function createApp() {
	return createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
}

describe('Actors Integration — DELETE', () => {
	let workspaceId: string
	let agentId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent', name: 'Delete Me' })
		agentId = agent.id
		await db.insert(workspaceMembers).values({
			workspaceId,
			actorId: agentId,
			role: 'member',
		})
	})

	it('cleans up subscriptions, read_state, sessions, and authored artifacts', async () => {
		const app = createApp()
		const humanId = getTestActorId()

		// Per-actor feed bookkeeping rows that previously blocked the delete.
		await db.insert(subscriptions).values(buildSubscription({ workspaceId, actorId: agentId }))
		await db.insert(readState).values(buildReadState({ workspaceId, actorId: agentId }))

		// A session this agent created for another actor — exercises the
		// sessions.created_by reassignment branch.
		const createdSession = await insertSession(db, workspaceId, humanId, agentId)

		// A session the agent ran itself — deleted along with the actor.
		const ownSession = await insertSession(db, workspaceId, agentId, humanId)

		// A notification sent to the human about the agent's own session. Its
		// source/target actor is the human, not the agent, so the agent-scoped
		// notification cleanup won't touch it — but it still references
		// ownSession via session_id, which is about to be hard-deleted. Without
		// ON DELETE SET NULL on notifications.session_id, this FK reference
		// blocks the session delete with a 23503 violation.
		const notification = await insertNotification(db, workspaceId, humanId, {
			targetActorId: humanId,
			sessionId: ownSession.id,
		})

		// A file the agent pushed back to storage while running its own session
		// (e.g. an updated memory/learnings file) — this is how every completed
		// session's agent_files row ends up referencing sessions.id. It's owned
		// by the same agent that's about to be deleted, so it's cleaned up by
		// the agent-scoped agent_files delete below — but only after the agent's
		// own sessions are deleted first. Without ON DELETE SET NULL on
		// agent_files.session_id, that ordering blocks the session delete with a
		// 23503 violation.
		const [agentFile] = await db
			.insert(agentFiles)
			.values(buildAgentFile({ workspaceId, actorId: agentId, sessionId: ownSession.id }))
			.returning()

		// Workspace artifacts authored by the agent.
		const [wsSkill] = await db
			.insert(workspaceSkills)
			.values(buildWorkspaceSkill({ workspaceId, createdBy: agentId }))
			.returning()
		const [fileRow] = await db
			.insert(files)
			.values(buildFile({ workspaceId, createdBy: agentId }))
			.returning()
		const [importRow] = await db
			.insert(imports)
			.values(buildImport({ workspaceId, createdBy: agentId }))
			.returning()

		const res = await app.request(
			jsonRequest('DELETE', `/api/actors/${agentId}`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ deleted: true })

		// Actor is gone.
		const remainingActor = await db.select().from(actors).where(eq(actors.id, agentId))
		expect(remainingActor).toHaveLength(0)

		// Subscriptions and read_state for the agent are gone.
		const remainingSubs = await db
			.select()
			.from(subscriptions)
			.where(eq(subscriptions.actorId, agentId))
		expect(remainingSubs).toHaveLength(0)
		const remainingReads = await db.select().from(readState).where(eq(readState.actorId, agentId))
		expect(remainingReads).toHaveLength(0)

		// The agent's own session is deleted.
		const ownSessionAfter = await db.select().from(sessions).where(eq(sessions.id, ownSession.id))
		expect(ownSessionAfter).toHaveLength(0)

		// The human's notification about that session survives (it isn't owned
		// by the deleted agent) but its session_id is nulled rather than
		// blocking the session delete with a FK violation.
		const [notificationAfter] = await db
			.select()
			.from(notifications)
			.where(eq(notifications.id, notification.id))
		expect(notificationAfter).toBeDefined()
		expect(notificationAfter.sessionId).toBeNull()

		// The agent's own file record is gone (agent-scoped agent_files cleanup),
		// which only runs because the session delete above no longer blocks on
		// this row's session_id FK.
		const remainingAgentFiles = await db
			.select()
			.from(agentFiles)
			.where(eq(agentFiles.id, agentFile.id))
		expect(remainingAgentFiles).toHaveLength(0)

		// The session the agent created for the human is reassigned, not deleted.
		const [createdSessionAfter] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, createdSession.id))
		expect(createdSessionAfter).toBeDefined()
		expect(createdSessionAfter.createdBy).toBe(humanId)

		// Workspace skills: createdBy is nulled.
		const [skillAfter] = await db
			.select()
			.from(workspaceSkills)
			.where(eq(workspaceSkills.id, wsSkill.id))
		expect(skillAfter.createdBy).toBeNull()

		// Files and imports: createdBy is reassigned to the deleting actor.
		const [fileAfter] = await db.select().from(files).where(eq(files.id, fileRow.id))
		expect(fileAfter.createdBy).toBe(humanId)
		const [importAfter] = await db.select().from(imports).where(eq(imports.id, importRow.id))
		expect(importAfter.createdBy).toBe(humanId)
	})
})
