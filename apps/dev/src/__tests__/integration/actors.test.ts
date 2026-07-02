import {
	actors,
	agentFiles,
	files,
	imports,
	notifications,
	readState,
	relationships,
	sessions,
	subscriptions,
	triggers,
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
	insertObject,
	insertRelationship,
	insertSession,
	insertTrigger,
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

// A human self-delete in a shared workspace must reassign or drop every FK
// from actors.id before the actors row is removed. Any missed FK — triggers,
// agent_files, relationships, workspace_skills — surfaces as a 23503 rollback
// on the final delete, and the user cannot delete their account.
describe('Actors Integration — human self-delete in a shared workspace', () => {
	it('reassigns / drops all actors-referencing FKs, then removes the human', async () => {
		// Create a workspace with the test actor (this is the "other human" keeping
		// the workspace from being solely-owned by the human we'll delete).
		const otherHumanId = getTestActorId()
		const ws = await insertWorkspace(db, otherHumanId)
		const workspaceId = ws.id

		// The workspace's Sindre (system agent) — where authored content will be
		// reassigned to after the human is gone.
		const sindre = await insertActor(db, {
			type: 'agent',
			name: 'Sindre',
			isSystem: true,
		})
		await db.insert(workspaceMembers).values({
			workspaceId,
			actorId: sindre.id,
			role: 'member',
		})

		// The human who's about to delete their own account.
		const deleting = await insertActor(db, { type: 'human', name: 'Departing' })
		await db.insert(workspaceMembers).values({
			workspaceId,
			actorId: deleting.id,
			role: 'member',
		})

		// FK-bearing rows owned by (or targeting) the deleting human:
		//   - trigger authored by the human, targeting Sindre → createdBy reassign
		//   - trigger targeting the human → hard-deleted (target is gone)
		//   - agent file owned by the human → hard-deleted
		//   - workspace skill authored by the human → createdBy reassigned to Sindre
		//   - relationship between two workspace objects, authored by the human →
		//       createdBy reassigned to Sindre
		const triggerByHuman = await insertTrigger(db, workspaceId, deleting.id, sindre.id)
		const triggerAtHuman = await insertTrigger(db, workspaceId, otherHumanId, deleting.id)
		const [agentFile] = await db
			.insert(agentFiles)
			.values(buildAgentFile({ workspaceId, actorId: deleting.id }))
			.returning()
		const [wsSkill] = await db
			.insert(workspaceSkills)
			.values(buildWorkspaceSkill({ workspaceId, createdBy: deleting.id }))
			.returning()
		const sourceObj = await insertObject(db, workspaceId, otherHumanId, { type: 'insight' })
		const targetObj = await insertObject(db, workspaceId, otherHumanId, { type: 'bet' })
		const rel = await insertRelationship(db, deleting.id, {
			sourceType: 'insight',
			sourceId: sourceObj.id,
			targetType: 'bet',
			targetId: targetObj.id,
		})

		// Drive the delete through the route handler, authenticated as the human
		// who's deleting themselves.
		const app = createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
		app.use('/api/actors/*', async (c, next) => {
			c.set('actorId', deleting.id)
			await next()
		})

		const res = await app.request(jsonRequest('DELETE', `/api/actors/${deleting.id}`))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ deleted: true })

		// The actor is gone; no FK violation blocked the delete.
		const remainingActor = await db.select().from(actors).where(eq(actors.id, deleting.id))
		expect(remainingActor).toHaveLength(0)

		// The workspace and its other member survive.
		const remainingWs = await db
			.select()
			.from(workspaceMembers)
			.where(eq(workspaceMembers.workspaceId, workspaceId))
		expect(remainingWs.some((m) => m.actorId === otherHumanId)).toBe(true)
		expect(remainingWs.some((m) => m.actorId === deleting.id)).toBe(false)

		// Trigger targeting the deleted user is dropped (retargeting to Sindre
		// would silently fire against a system actor).
		const remainingTargetTrigger = await db
			.select()
			.from(triggers)
			.where(eq(triggers.id, triggerAtHuman.id))
		expect(remainingTargetTrigger).toHaveLength(0)

		// Trigger authored by the user survives, with authorship moved to Sindre.
		const [survivingTrigger] = await db
			.select()
			.from(triggers)
			.where(eq(triggers.id, triggerByHuman.id))
		expect(survivingTrigger.createdBy).toBe(sindre.id)

		// Agent files owned by the deleted user are gone.
		const remainingAgentFiles = await db
			.select()
			.from(agentFiles)
			.where(eq(agentFiles.id, agentFile.id))
		expect(remainingAgentFiles).toHaveLength(0)

		// Workspace skill authored by the user survives, createdBy reassigned.
		const [skillAfter] = await db
			.select()
			.from(workspaceSkills)
			.where(eq(workspaceSkills.id, wsSkill.id))
		expect(skillAfter.createdBy).toBe(sindre.id)

		// Relationship authored by the user survives, createdBy reassigned.
		const [relAfter] = await db.select().from(relationships).where(eq(relationships.id, rel.id))
		expect(relAfter.createdBy).toBe(sindre.id)
	})
})
