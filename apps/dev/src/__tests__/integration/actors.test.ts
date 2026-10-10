import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import {
	events,
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
	workspaces,
} from '@maskin/db/schema'
import { ACTOR_DESCRIPTION_MAX_LENGTH, ACTOR_DESCRIPTION_MAX_STORED_LENGTH } from '@maskin/shared'
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
const { default: eventsRoutes } = await import('../../routes/events')

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
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.skills).toEqual([{ id: skill.id, name: skill.name }])
	})

	it('returns an empty skills array when no skills are attached', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, { type: 'agent', name: 'Skill-less Agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.skills).toEqual([])
	})
})

describe('Actors Integration — PATCH /:id description', () => {
	// Profile's "How to work with me" writes multi-paragraph prose into this
	// same column. It was bounded by the 80-character agent tagline length, so
	// anything a human actually typed 400'd and their text was discarded.
	// Profile edits the *caller's own* actor. A human PATCHing a different human
	// is the admin path and needs an X-Workspace-Id header, so writing this
	// against a freshly inserted human would 403 on the workspace-context guard
	// long before the length bound is reached.
	it('accepts a description longer than the agent tagline cap', async () => {
		const app = createApp()
		const self = getTestActorId()
		const prose = `${'Ask before emailing anyone. '.repeat(20)}

Never ship on a Friday.`
		expect(prose.length).toBeGreaterThan(ACTOR_DESCRIPTION_MAX_LENGTH)

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${self}`, { description: prose }),
		)
		expect(res.status).toBe(200)

		const [row] = await db.select().from(actors).where(eq(actors.id, self))
		expect(row.description).toBe(prose)
	})

	it('still rejects a description past the storage bound', async () => {
		const app = createApp()

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${getTestActorId()}`, {
				description: 'x'.repeat(ACTOR_DESCRIPTION_MAX_STORED_LENGTH + 1),
			}),
		)
		expect(res.status).toBe(400)
	})
})

describe('Actors Integration — by-id routes are scoped to the caller workspaces', () => {
	const fakeTools = {
		mcpServers: { fake: { type: 'http', url: 'https://example.invalid/mcp' } },
	}

	async function seedAgentInWorkspaceOf(ownerId: string, callerRole?: 'member' | 'admin') {
		const ws = await insertWorkspace(db, ownerId)
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'Scoped Agent',
			systemPrompt: 'original prompt',
			tools: { mcpServers: {} },
			llmConfig: { model: 'original-model' },
		})
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
		if (callerRole) {
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: ws.id, actorId: getTestActorId(), role: callerRole })
		}
		return { ws, agent }
	}

	async function readAgent(id: string) {
		const [row] = await db.select().from(actors).where(eq(actors.id, id))
		return row
	}

	it('GET returns 404 for an agent that only lives in a workspace the caller is not in', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id)

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))

		expect(res.status).toBe(404)
	})

	it('GET returns 404 when the header names a workspace the caller is in but the agent is not', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id)
		const mine = await insertWorkspace(db, getTestActorId())

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`, { 'x-workspace-id': mine.id }))

		expect(res.status).toBe(404)
	})

	it('GET returns 200 for an agent in a shared workspace, with and without the header', async () => {
		const app = createApp()
		const { ws, agent } = await seedAgentInWorkspaceOf(getTestActorId())

		const bare = await app.request(jsonGet(`/api/actors/${agent.id}`))
		const headed = await app.request(
			jsonGet(`/api/actors/${agent.id}`, { 'x-workspace-id': ws.id }),
		)

		expect(bare.status).toBe(200)
		expect(headed.status).toBe(200)
	})

	it('PATCH returns 404 and leaves the row unchanged for an agent in a workspace the caller is not in', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id)

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, {
				system_prompt: 'changed prompt',
				tools: fakeTools,
				llm_config: { model: 'changed-model' },
			}),
		)

		expect(res.status).toBe(404)
		const row = await readAgent(agent.id)
		expect(row.systemPrompt).toBe('original prompt')
		expect(row.tools).toEqual({ mcpServers: {} })
		expect(row.llmConfig).toEqual({ model: 'original-model' })
	})

	it('PATCH returns 403 and leaves tools and llm_config unchanged for a plain member of the shared workspace', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id, 'member')

		const toolsRes = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { tools: fakeTools }),
		)
		const llmRes = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { llm_config: { model: 'changed-model' } }),
		)

		expect(toolsRes.status).toBe(403)
		expect(llmRes.status).toBe(403)
		const row = await readAgent(agent.id)
		expect(row.tools).toEqual({ mcpServers: {} })
		expect(row.llmConfig).toEqual({ model: 'original-model' })
	})

	it('PATCH lets a plain member change the system prompt and description of the shared agent', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id, 'member')

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, {
				system_prompt: 'retuned prompt',
				description: 'retuned description',
			}),
		)

		expect(res.status).toBe(200)
		const row = await readAgent(agent.id)
		expect(row.systemPrompt).toBe('retuned prompt')
		expect(row.description).toBe('retuned description')
	})

	it('PATCH lets an admin of the shared workspace change tools and llm_config', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id, 'admin')

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, {
				tools: fakeTools,
				llm_config: { model: 'changed-model' },
			}),
		)

		expect(res.status).toBe(200)
		const row = await readAgent(agent.id)
		expect(row.tools).toMatchObject(fakeTools)
		expect(row.llmConfig).toEqual({ model: 'changed-model' })
	})

	it('PATCH refuses when the caller is admin in one workspace and only a member in the one the agent is in', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id, 'member')
		await insertWorkspace(db, getTestActorId()) // caller owns an unrelated workspace

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { tools: fakeTools }),
		)

		expect(res.status).toBe(403)
		expect((await readAgent(agent.id)).tools).toEqual({ mcpServers: {} })
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

	it('stores only identity fields in the deleted event, no tools, llm_config or credentials', async () => {
		const app = createApp()
		await db
			.update(actors)
			.set({
				apiKey: 'fake-api-key-for-test',
				systemPrompt: 'fake system prompt for test',
				tools: { mcpServers: { fake: { env: { FAKE_TOKEN: 'fake-env-secret-for-test' } } } },
				llmConfig: { api_key: 'fake-llm-key-for-test' },
				memory: { notes: 'fake memory for test' },
			})
			.where(eq(actors.id, agentId))

		const res = await app.request(
			jsonRequest('DELETE', `/api/actors/${agentId}`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)

		const rows = await db.select().from(events).where(eq(events.entityId, agentId))
		const deleted = rows.filter((r) => r.action === 'deleted')
		expect(deleted).toHaveLength(1)
		expect(deleted[0].data).toEqual({
			id: agentId,
			type: 'agent',
			name: 'Delete Me',
			is_system: false,
		})
		expect(JSON.stringify(rows)).not.toMatch(/fake-/)

		// The events read routes return the stored row as is, so check what
		// they actually serve: history, and the SSE replay path.
		const historyRes = await createIntegrationApp({
			path: '/api/events',
			module: eventsRoutes,
		}).request(
			jsonGet(`/api/events/history?entity_id=${agentId}`, { 'x-workspace-id': workspaceId }),
		)
		expect(historyRes.status).toBe(200)
		const historyText = await historyRes.text()
		expect(historyText).toContain('Delete Me')
		expect(historyText).not.toMatch(/fake-/)

		const sseApp = new OpenAPIHono()
		sseApp.use('*', async (c, next) => {
			c.set('db' as never, db as never)
			c.set('actorId' as never, getTestActorId() as never)
			c.set('notifyBridge' as never, { on() {}, off() {} } as never)
			await next()
		})
		sseApp.route('/api/events', eventsRoutes as never)
		const abort = new AbortController()
		const sseRes = await sseApp.request('/api/events', {
			headers: { 'x-workspace-id': workspaceId, 'last-event-id': '0' },
			signal: abort.signal,
		})
		expect(sseRes.status).toBe(200)
		const reader = (sseRes.body as ReadableStream<Uint8Array>).getReader()
		const decoder = new TextDecoder()
		let sseText = ''
		while (!sseText.includes('Delete Me')) {
			const { value, done } = await reader.read()
			if (done) break
			sseText += decoder.decode(value)
		}
		abort.abort()
		await reader.cancel().catch(() => {})
		expect(sseText).toContain('Delete Me')
		expect(sseText).not.toMatch(/fake-/)
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

describe('Actors Integration — signup workspace provisioning', () => {
	// Signup used to seed only Workspace Coach in-transaction and leave the rest
	// of the roster to a post-commit call, so a signed-up workspace was furnished
	// differently from one created via POST /api/workspaces. Both now share
	// provisionWorkspace(), so the auto-created workspace must come out with the
	// full default agent roster and a pinned default chat agent.
	const DEFAULT_AGENT_NAMES = [
		'Chief of Staff',
		'Driver',
		'Knowledge Curator',
		'Researcher',
		'Signal Analyst',
		'Strategist',
		'Workspace Coach',
	]

	it('auto-creates a workspace seeded with the full default agent roster', async () => {
		const app = createApp()

		const res = await app.request(
			jsonRequest('POST', '/api/actors', {
				type: 'human',
				name: 'Provisioned Human',
				email: `provisioned-${randomUUID()}@example.com`,
				password: 'correct-horse-battery',
			}),
		)
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.workspace_id).toBeTruthy()

		const memberNames = await db
			.select({ name: actors.name })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(eq(workspaceMembers.workspaceId, body.workspace_id))

		const agentNames = memberNames
			.map((r) => r.name)
			.filter((n) => DEFAULT_AGENT_NAMES.includes(n))
			.sort()
		expect(agentNames).toEqual(DEFAULT_AGENT_NAMES)
	})

	it('does not return the stored passwordHash in the signup response', async () => {
		const app = createApp()
		const email = `no-hash-${randomUUID()}@example.com`

		const res = await app.request(
			jsonRequest('POST', '/api/actors', {
				type: 'human',
				name: 'No Hash Human',
				email,
				password: 'correct-horse-battery',
			}),
		)
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body).not.toHaveProperty('passwordHash')
		expect(JSON.stringify(body)).not.toContain('$2')

		// Guard against a vacuous pass: the hash really was stored for this actor.
		const [row] = await db
			.select({ passwordHash: actors.passwordHash })
			.from(actors)
			.where(eq(actors.id, body.id))
			.limit(1)
		expect(row?.passwordHash).toBeTruthy()
		expect(JSON.stringify(body)).not.toContain(row?.passwordHash as string)
	})

	it('pins Chief of Staff as the auto-created workspace default chat agent', async () => {
		const app = createApp()

		const res = await app.request(
			jsonRequest('POST', '/api/actors', {
				type: 'human',
				name: 'Pinned Default',
				email: `pinned-${randomUUID()}@example.com`,
				password: 'correct-horse-battery',
			}),
		)
		expect(res.status).toBe(201)
		const { workspace_id: workspaceId } = await res.json()

		const [ws] = await db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.limit(1)

		const defaultAgentId = (ws?.settings as { default_agent_id?: string } | null)?.default_agent_id
		expect(defaultAgentId).toBeTruthy()

		const [chief] = await db
			.select({ name: actors.name })
			.from(actors)
			.where(eq(actors.id, defaultAgentId as string))
			.limit(1)
		expect(chief?.name).toBe('Chief of Staff')
	})
})
