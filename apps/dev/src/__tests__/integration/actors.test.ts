import {
	actors,
	agentFiles,
	agentSkills,
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
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: workspacesRoutes } = await import('../../routes/workspaces')

function createApp() {
	return createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
}

function createMcpFlowApp() {
	return createIntegrationApp(
		{ path: '/api/actors', module: actorsRoutes },
		{ path: '/api/workspaces', module: workspacesRoutes },
	)
}

describe('Actors Integration — GET /:id', () => {
	it('includes id and name of attached workspace skills', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, { type: 'agent', name: 'Skilled Agent' })
		const [skill] = await db
			.insert(workspaceSkills)
			.values(buildWorkspaceSkill({ workspaceId: ws.id, createdBy: getTestActorId() }))
			.returning()
		await db.insert(agentSkills).values({ actorId: agent.id, workspaceSkillId: skill.id })

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.skills).toEqual([{ id: skill.id, name: skill.name }])
	})

	it('returns an empty skills array when no skills are attached', async () => {
		const app = createApp()
		const agent = await insertActor(db, { type: 'agent', name: 'Skill-less Agent' })

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.skills).toEqual([])
	})
})

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

// Regression coverage for the MCP `create_actor` workspace-attach path.
// The MCP handler in packages/mcp/src/server.ts (~L2708) calls two HTTP
// endpoints in sequence — POST /api/actors (skipAuth) then POST
// /api/workspaces/:id/members (caller-auth) — and the reported bug
// (insight 4beeafd5) was that the second call silently failed on some
// deployments, leaving new agents un-attached to the workspace they were
// created in. This test replays that exact HTTP sequence against real
// Postgres and asserts the new agent is queryable via the same list
// endpoint list_actors reads (`GET /api/actors?workspace_id=...`) with
// role = 'member'. A regression that breaks the members insert or the
// workspace-scoped list query will fail this test.
describe('Actors Integration — MCP create_actor + attach flow', () => {
	it('creates an agent and attaches it to the workspace so list_actors returns it as a member', async () => {
		const app = createMcpFlowApp()
		const ws = await insertWorkspace(db, getTestActorId())

		const createRes = await app.request(
			jsonRequest('POST', '/api/actors', { type: 'agent', name: 'MCP-created agent' }),
		)
		expect(createRes.status).toBe(201)
		const created = await createRes.json()
		expect(created.id).toBeDefined()
		expect(created.type).toBe('agent')
		// Agents don't get an auto-created workspace, so the create response
		// has no workspace_id — the MCP handler adds the attach in a second call.
		expect(created.workspace_id).toBeUndefined()

		const attachRes = await app.request(
			jsonRequest(
				'POST',
				`/api/workspaces/${ws.id}/members`,
				{ actor_id: created.id, role: 'member' },
				{ 'x-workspace-id': ws.id },
			),
		)
		expect(attachRes.status).toBe(201)
		expect(await attachRes.json()).toEqual({ added: true })

		// list_actors: same query as `GET /api/actors?workspace_id=<id>` via
		// the workspace-scoped branch. The new agent must appear with the
		// role recorded on the workspaceMembers join.
		const listRes = await app.request(jsonGet('/api/actors', { 'x-workspace-id': ws.id }))
		expect(listRes.status).toBe(200)
		const members = (await listRes.json()) as Array<{
			id: string
			name: string
			type: string
			role: string
		}>
		const newAgent = members.find((m) => m.id === created.id)
		expect(newAgent).toBeDefined()
		expect(newAgent?.role).toBe('member')
		expect(newAgent?.type).toBe('agent')

		// Belt-and-braces DB check: exactly one workspaceMembers row for the
		// new agent in this workspace.
		const rows = await db
			.select()
			.from(workspaceMembers)
			.where(eq(workspaceMembers.actorId, created.id))
		expect(rows).toHaveLength(1)
		expect(rows[0].workspaceId).toBe(ws.id)
		expect(rows[0].role).toBe('member')
	})
})
