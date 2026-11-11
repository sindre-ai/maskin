import { events, actors, sendPermissions, workspaceMembers } from '@maskin/db/schema'
import { STARTING_SEND_MODES } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { resolveSendMode } from '../../lib/send-permissions'
import { insertActor, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: routes } = await import('../../routes/send-permissions')

function buildApp() {
	return createIntegrationApp({ path: '/api/send-permissions', module: routes as never })
}

function put(workspaceId: string, body: unknown, headers: Record<string, string> = {}) {
	return new Request('http://localhost/api/send-permissions', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId, ...headers },
		body: JSON.stringify(body),
	})
}

function get(workspaceId: string) {
	return new Request('http://localhost/api/send-permissions', {
		headers: { 'X-Workspace-Id': workspaceId },
	})
}

async function insertAgent(workspaceId: string) {
	const agent = await insertActor(db, { type: 'agent' })
	await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
	return agent
}

async function rows(workspaceId: string) {
	return db.select().from(sendPermissions).where(eq(sendPermissions.workspaceId, workspaceId))
}

describe('PUT /api/send-permissions', () => {
	it('saves an agent setting and a workspace default, and updates them in place', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertAgent(ws.id)
		const app = buildApp()

		const first = await app.request(put(ws.id, { agent_id: agent.id, kind: 'email', mode: 'deny' }))
		expect(first.status).toBe(200)
		const second = await app.request(
			put(ws.id, { agent_id: agent.id, kind: 'email', mode: 'always_allow' }),
		)
		expect(second.status).toBe(200)
		expect(await second.json()).toMatchObject({ mode: 'always_allow', previous_mode: 'deny' })
		await app.request(put(ws.id, { agent_id: null, kind: 'email', mode: 'ask_first' }))
		await app.request(put(ws.id, { agent_id: null, kind: 'email', mode: 'deny' }))

		const saved = await rows(ws.id)
		expect(saved).toHaveLength(2)
		expect(saved.find((r) => r.agentId === agent.id)?.mode).toBe('always_allow')
		expect(saved.find((r) => r.agentId === null)?.mode).toBe('deny')
	})

	it('removes an agent setting with mode null, and refuses to remove the workspace default', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertAgent(ws.id)
		const app = buildApp()
		await app.request(put(ws.id, { agent_id: agent.id, kind: 'slack_message', mode: 'deny' }))

		const removed = await app.request(
			put(ws.id, { agent_id: agent.id, kind: 'slack_message', mode: null }),
		)
		expect(removed.status).toBe(200)
		expect(await rows(ws.id)).toHaveLength(0)

		const refused = await app.request(put(ws.id, { agent_id: null, kind: 'email', mode: null }))
		expect(refused.status).toBe(400)
	})

	it('writes an audit event with the before and after', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertAgent(ws.id)
		const app = buildApp()
		await app.request(put(ws.id, { agent_id: agent.id, kind: 'email', mode: 'always_allow' }))
		await app.request(put(ws.id, { agent_id: agent.id, kind: 'email', mode: 'deny' }))

		const logged = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.action, 'send_permission_updated')))
			.orderBy(events.id)
		expect(logged.map((e) => (e.data as { after: string }).after)).toEqual(['always_allow', 'deny'])
		expect((logged[1].data as { before: string }).before).toBe('always_allow')
	})

	it('rejects an unknown kind, an unknown mode and an agent from another workspace', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const other = await insertWorkspace(db, getTestActorId())
		const stranger = await insertAgent(other.id)
		const app = buildApp()

		for (const body of [
			{ agent_id: null, kind: 'fax', mode: 'deny' },
			{ agent_id: null, kind: 'email', mode: 'sometimes' },
			{ kind: 'email', mode: 'deny' },
		]) {
			expect((await app.request(put(ws.id, body))).status).toBe(400)
		}
		const res = await app.request(
			put(ws.id, { agent_id: stranger.id, kind: 'email', mode: 'always_allow' }),
		)
		expect(res.status).toBe(404)
		expect(await rows(ws.id)).toHaveLength(0)
	})

	it('refuses an agent, even one that owns the workspace, so it cannot allow its own sends', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await db.update(actors).set({ type: 'agent' }).where(eq(actors.id, actorId))
		try {
			const res = await buildApp().request(
				put(ws.id, { agent_id: actorId, kind: 'email', mode: 'always_allow' }),
			)
			expect(res.status).toBe(403)
			expect(await rows(ws.id)).toHaveLength(0)
		} finally {
			await db.update(actors).set({ type: 'human' }).where(eq(actors.id, actorId))
		}
	})

	it('refuses a person whose key reaches the API through MCP', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const res = await buildApp().request(
			put(
				ws.id,
				{ agent_id: null, kind: 'email', mode: 'always_allow' },
				{ 'X-Client-Source': 'mcp' },
			),
		)
		expect(res.status).toBe(403)
		expect(await rows(ws.id)).toHaveLength(0)
	})

	it('refuses a member and a viewer', async () => {
		for (const role of ['member', 'viewer']) {
			const owner = await insertActor(db)
			const ws = await insertWorkspace(db, owner.id)
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: ws.id, actorId: getTestActorId(), role })
			const res = await buildApp().request(
				put(ws.id, { agent_id: null, kind: 'email', mode: 'always_allow' }),
			)
			expect(res.status).toBe(403)
			expect(await rows(ws.id)).toHaveLength(0)
		}
	})
})

describe('resolveSendMode', () => {
	it('falls back to the starting table when nothing is saved, and asks first for an unknown kind', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertAgent(ws.id)
		const email = await resolveSendMode(db, {
			workspaceId: ws.id,
			agentId: agent.id,
			kind: 'email',
		})
		expect(email).toEqual({ mode: STARTING_SEND_MODES.email, source: 'starting', settingId: null })
		const slack = await resolveSendMode(db, {
			workspaceId: ws.id,
			agentId: agent.id,
			kind: 'slack_message',
		})
		expect(slack.mode).toBe('always_allow')
		const unknown = await resolveSendMode(db, {
			workspaceId: ws.id,
			agentId: agent.id,
			kind: 'fax',
		})
		expect(unknown.mode).toBe('ask_first')
	})

	it('lets an agent setting beat the workspace default, and the default beat the starting table', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertAgent(ws.id)
		const other = await insertAgent(ws.id)
		const app = buildApp()
		await app.request(put(ws.id, { agent_id: null, kind: 'email', mode: 'deny' }))
		await app.request(put(ws.id, { agent_id: agent.id, kind: 'email', mode: 'always_allow' }))
		const at = (agentId: string, kind = 'email') =>
			resolveSendMode(db, { workspaceId: ws.id, agentId, kind })

		expect(await at(agent.id)).toMatchObject({ mode: 'always_allow', source: 'agent' })
		expect(await at(other.id)).toMatchObject({ mode: 'deny', source: 'workspace' })
		expect(await at(agent.id, 'linkedin_post')).toMatchObject({
			mode: 'always_allow',
			source: 'starting',
		})
	})

	it('reads the latest setting on every call', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertAgent(ws.id)
		const app = buildApp()
		const mode = async () =>
			(await resolveSendMode(db, { workspaceId: ws.id, agentId: agent.id, kind: 'email' })).mode
		await app.request(put(ws.id, { agent_id: agent.id, kind: 'email', mode: 'ask_first' }))
		expect(await mode()).toBe('ask_first')
		await app.request(put(ws.id, { agent_id: agent.id, kind: 'email', mode: 'deny' }))
		expect(await mode()).toBe('deny')
		await app.request(put(ws.id, { agent_id: agent.id, kind: 'email', mode: null }))
		expect(await mode()).toBe(STARTING_SEND_MODES.email)
	})
})

describe('GET /api/send-permissions', () => {
	it('lists the workspace default per kind and each agent with where its mode comes from', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertAgent(ws.id)
		const app = buildApp()
		await app.request(put(ws.id, { agent_id: null, kind: 'email', mode: 'deny' }))
		await app.request(put(ws.id, { agent_id: agent.id, kind: 'slack_message', mode: 'ask_first' }))

		const res = await app.request(get(ws.id))
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			workspace_default: Record<string, { mode: string; source: string }>
			agents: Array<{
				agent_id: string
				settings: Record<string, { mode: string; source: string }>
			}>
		}
		expect(body.workspace_default.email).toEqual({ mode: 'deny', source: 'workspace' })
		expect(body.workspace_default.linkedin_post).toEqual({
			mode: 'always_allow',
			source: 'starting',
		})
		const row = body.agents.find((a) => a.agent_id === agent.id)
		expect(row?.settings.email).toEqual({ mode: 'deny', source: 'workspace' })
		expect(row?.settings.slack_message).toEqual({ mode: 'ask_first', source: 'agent' })
	})
})
