import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { authMiddleware } from '@maskin/auth'
import { actors, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { createApiError, mapStatusToCode } from '../../lib/errors'
import {
	buildWorkspaceSkill,
	insertActor,
	insertConversation,
	insertNotification,
	insertWorkspace,
} from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: agentSkillsRoutes } = await import('../../routes/agent-skills')
const { default: agentSkillAttachmentsRoutes } = await import(
	'../../routes/agent-skill-attachments'
)
const { default: sessionsRoutes } = await import('../../routes/sessions')
const { default: conversationsRoutes } = await import('../../routes/conversations')
const { default: notificationsRoutes } = await import('../../routes/notifications')

// Real authMiddleware (the role comes from its membership lookup) in front of the
// real Group C routes, so a viewer API key goes through the same path as in production.
function createApp() {
	const app = new OpenAPIHono()
	app.use('*', authMiddleware(db, { cacheTtlMs: 0 }))
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		// A viewer is turned away before any route touches these.
		c.set('agentStorage' as never, {} as never)
		c.set('sessionManager' as never, {} as never)
		c.set('storageProvider' as never, {} as never)
		c.set('notifyBridge' as never, {} as never)
		await next()
	})
	app.onError((err, c) => {
		if ('status' in err && typeof err.status === 'number') {
			return c.json(createApiError(mapStatusToCode(err.status), err.message), err.status as 400)
		}
		throw err
	})
	app.route('/api/actors', actorsRoutes as never)
	app.route('/api/actors', agentSkillsRoutes as never)
	app.route('/api/actors', agentSkillAttachmentsRoutes as never)
	app.route('/api/sessions', sessionsRoutes as never)
	app.route('/api/conversations', conversationsRoutes as never)
	app.route('/api/notifications', notificationsRoutes as never)
	return app
}

describe('Viewer role is read-only on agents and sessions (Group C)', () => {
	let workspaceId: string
	let viewerId: string
	let viewerKey: string
	let memberId: string
	let memberKey: string
	let agentId: string
	let workspaceSkillId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id

		const viewer = await insertActor(db, { name: 'Viewer' })
		viewerId = viewer.id
		viewerKey = viewer.apiKey
		await db.insert(workspaceMembers).values({ workspaceId, actorId: viewer.id, role: 'viewer' })

		const member = await insertActor(db, { name: 'Member' })
		memberId = member.id
		memberKey = member.apiKey
		await db.insert(workspaceMembers).values({ workspaceId, actorId: member.id, role: 'member' })

		const agent = await insertActor(db, { name: 'Agent', type: 'agent' })
		agentId = agent.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })

		const [skill] = await db
			.insert(workspaceSkills)
			.values(buildWorkspaceSkill({ workspaceId, createdBy: getTestActorId() }) as never)
			.returning()
		workspaceSkillId = skill?.id as string
	})

	const auth = (key: string) => ({ Authorization: `Bearer ${key}`, 'x-workspace-id': workspaceId })

	const expectForbidden = async (res: Response) => {
		expect(res.status).toBe(403)
		expect((await res.json()).error.code).toBe('FORBIDDEN')
	}

	it('returns 403 to a viewer on every session write and 200 on session reads', async () => {
		const app = createApp()
		const headers = auth(viewerKey)
		const sessionId = randomUUID()

		await expectForbidden(
			await app.request(
				jsonRequest(
					'POST',
					'/api/sessions',
					{ actor_id: agentId, action_prompt: 'Run tests' },
					headers,
				),
			),
		)
		await expectForbidden(
			await app.request(
				jsonRequest('PATCH', `/api/sessions/${sessionId}`, { current_activity: 'x' }, headers),
			),
		)
		for (const action of ['stop', 'pause', 'resume']) {
			await expectForbidden(
				await app.request(jsonRequest('POST', `/api/sessions/${sessionId}/${action}`, {}, headers)),
			)
		}
		await expectForbidden(
			await app.request(
				jsonRequest('POST', `/api/sessions/${sessionId}/input`, { content: 'hello' }, headers),
			),
		)
		await expectForbidden(
			await app.request(
				jsonRequest(
					'POST',
					`/api/sessions/${sessionId}/ask`,
					{
						questions: [
							{ question: 'Which one?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] },
						],
					},
					headers,
				),
			),
		)

		const list = await app.request(jsonGet('/api/sessions', headers))
		expect(list.status).toBe(200)
	})

	it('returns 403 to a viewer on every actor write', async () => {
		const app = createApp()
		const headers = auth(viewerKey)

		await expectForbidden(
			await app.request(
				jsonRequest('PATCH', `/api/actors/${agentId}`, { name: 'renamed' }, headers),
			),
		)
		await expectForbidden(await app.request(jsonDelete(`/api/actors/${agentId}`, headers)))
		await expectForbidden(
			await app.request(jsonRequest('POST', `/api/actors/${viewerId}/api-keys`, {}, headers)),
		)
		for (const action of ['pause', 'reset', 'run']) {
			await expectForbidden(
				await app.request(jsonRequest('POST', `/api/actors/${agentId}/${action}`, {}, headers)),
			)
		}

		const read = await app.request(jsonGet(`/api/actors/${agentId}`, headers))
		expect(read.status).toBe(200)
	})

	it('returns 403 to a viewer on agent skill writes', async () => {
		const app = createApp()
		const headers = auth(viewerKey)

		await expectForbidden(
			await app.request(
				jsonRequest(
					'PUT',
					`/api/actors/${agentId}/skills/my-skill`,
					{ description: 'A skill', content: 'Do the thing' },
					headers,
				),
			),
		)
		await expectForbidden(
			await app.request(jsonDelete(`/api/actors/${agentId}/skills/my-skill`, headers)),
		)
		await expectForbidden(
			await app.request(
				jsonRequest(
					'POST',
					`/api/actors/${agentId}/workspace-skills`,
					{ workspaceSkillId },
					headers,
				),
			),
		)
		await expectForbidden(
			await app.request(
				jsonRequest(
					'POST',
					`/api/actors/${agentId}/workspace-skills/batch`,
					{ workspaceSkillIds: [workspaceSkillId] },
					headers,
				),
			),
		)
		await expectForbidden(
			await app.request(
				jsonDelete(`/api/actors/${agentId}/workspace-skills/${workspaceSkillId}`, headers),
			),
		)
	})

	it('returns 403 to a viewer on every conversation write and 200 on the list', async () => {
		const app = createApp()
		const headers = auth(viewerKey)
		const conversation = await insertConversation(db, workspaceId, getTestActorId())
		const base = `/api/conversations/${conversation?.id}`

		await expectForbidden(
			await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Hello', participant_actor_ids: [] },
					headers,
				),
			),
		)
		await expectForbidden(
			await app.request(jsonRequest('PATCH', base, { title: 'Renamed' }, headers)),
		)
		await expectForbidden(
			await app.request(
				jsonRequest('POST', `${base}/participants`, { actor_ids: [agentId] }, headers),
			),
		)
		await expectForbidden(await app.request(jsonDelete(`${base}/participants/${agentId}`, headers)))
		await expectForbidden(
			await app.request(jsonRequest('POST', `${base}/messages`, { content: 'hi' }, headers)),
		)
		await expectForbidden(
			await app.request(jsonRequest('PATCH', `${base}/messages/1`, { content: 'edited' }, headers)),
		)
		await expectForbidden(
			await app.request(jsonRequest('POST', `${base}/messages/1/retry`, {}, headers)),
		)

		const list = await app.request(jsonGet('/api/conversations', headers))
		expect(list.status).toBe(200)
	})

	it('returns 403 to a viewer on notification respond, since it wakes an agent', async () => {
		const app = createApp()
		const notification = await insertNotification(db, workspaceId, agentId)

		await expectForbidden(
			await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${notification?.id}/respond`,
					{ response: 'go ahead' },
					auth(viewerKey),
				),
			),
		)
	})

	it('keeps the personal pin, archive and read marker open to a viewer (Group E)', async () => {
		const app = createApp()
		const conversation = await insertConversation(db, workspaceId, getTestActorId())

		// Not a participant, so this ends in a 404, never the viewer 403.
		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/conversations/${conversation?.id}/me`,
				{ pinned: true },
				auth(viewerKey),
			),
		)
		expect(res.status).toBe(404)
	})

	it('lets a viewer set their own default workspace, which is a personal preference', async () => {
		const res = await createApp().request(
			jsonRequest(
				'PATCH',
				`/api/actors/${viewerId}`,
				{ default_workspace_id: workspaceId },
				auth(viewerKey),
			),
		)
		expect(res.status).toBe(200)
	})

	describe('actor routes with an optional workspace header', () => {
		it('refuses a viewer who leaves the header off', async () => {
			const app = createApp()
			const bearerOnly = { Authorization: `Bearer ${viewerKey}` }

			await expectForbidden(
				await app.request(jsonRequest('POST', `/api/actors/${viewerId}/api-keys`, {}, bearerOnly)),
			)
			await expectForbidden(
				await app.request(
					jsonRequest('PATCH', `/api/actors/${agentId}`, { name: 'renamed' }, bearerOnly),
				),
			)
		})

		it('lets a viewer here who is a member elsewhere write without the header', async () => {
			const app = createApp()
			const other = await insertWorkspace(db, getTestActorId())
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: other.id, actorId: viewerId, role: 'member' })

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/actors/${viewerId}/api-keys`,
					{},
					{ Authorization: `Bearer ${viewerKey}` },
				),
			)
			expect(res.status).toBe(200)
		})
	})

	describe('creating an agent through the signup route', () => {
		const createAgent = (name: string, key: string, body: Record<string, unknown>) =>
			createApp().request(
				jsonRequest(
					'POST',
					'/api/actors',
					{ type: 'agent', name, ...body },
					{ Authorization: `Bearer ${key}` },
				),
			)
		const agentsNamed = (name: string) => db.select().from(actors).where(eq(actors.name, name))

		it('returns 403 to a viewer who names their workspace and writes no actor', async () => {
			const name = `Viewer minted ${randomUUID()}`

			await expectForbidden(await createAgent(name, viewerKey, { workspace_id: workspaceId }))

			expect(await agentsNamed(name)).toHaveLength(0)
		})

		it('keeps the 404 for a caller who is not a member of the named workspace', async () => {
			const stranger = await insertActor(db, { name: 'Stranger' })
			const name = `Stranger minted ${randomUUID()}`

			const res = await createAgent(name, stranger.apiKey, { workspace_id: workspaceId })

			expect(res.status).toBe(404)
			expect(await agentsNamed(name)).toHaveLength(0)
		})

		it('still lets a member create an agent in the workspace', async () => {
			const name = `Member minted ${randomUUID()}`

			const res = await createAgent(name, memberKey, { workspace_id: workspaceId })

			expect(res.status).toBe(201)
			expect(await agentsNamed(name)).toHaveLength(1)
		})
	})

	describe('member behaviour is unchanged', () => {
		it('lets a member regenerate their own key, with and without the header', async () => {
			const app = createApp()
			const first = await app.request(
				jsonRequest('POST', `/api/actors/${memberId}/api-keys`, {}, auth(memberKey)),
			)
			expect(first.status).toBe(200)
			const { api_key: newKey } = await first.json()

			const second = await app.request(
				jsonRequest(
					'POST',
					`/api/actors/${memberId}/api-keys`,
					{},
					{ Authorization: `Bearer ${newKey}` },
				),
			)
			expect(second.status).toBe(200)
		})

		it('lets a member and an agent with the member role create a conversation', async () => {
			const app = createApp()
			const agent = await insertActor(db, { name: 'Chat agent', type: 'agent' })
			await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })

			for (const key of [memberKey, agent.apiKey]) {
				const created = await app.request(
					jsonRequest(
						'POST',
						'/api/conversations',
						{ title: 'Hello', participant_actor_ids: [] },
						auth(key),
					),
				)
				expect(created.status).toBe(201)
			}
		})
	})
})
