import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { authMiddleware } from '@maskin/auth'
import { files, notifications, voiceSessions, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, mapStatusToCode } from '../../lib/errors'
import { getWorkspaceRole, isWorkspaceMember, isWorkspaceWriter } from '../../lib/workspace-auth'
import {
	buildCreateGraphBody,
	buildCreateNotificationBody,
	buildCreateObjectBody,
	buildCreateRelationshipBody,
	buildFile,
	insertActor,
	insertNotification,
	insertObject,
	insertWorkspace,
} from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')
const { default: relationshipsRoutes } = await import('../../routes/relationships')
const { default: graphRoutes } = await import('../../routes/graph')
const { default: filesRoutes } = await import('../../routes/files')
const { default: fileCommentsRoutes } = await import('../../routes/file-comments')
const { default: fileProposalsRoutes } = await import('../../routes/file-proposals')
const { default: eventsRoutes } = await import('../../routes/events')
const { default: importsRoutes } = await import('../../routes/imports')
const { default: voiceSessionsRoutes } = await import('../../routes/voice-sessions')
const { default: notificationsRoutes } = await import('../../routes/notifications')

// Real authMiddleware (the role comes from its membership lookup) in front of the
// real routes, so a viewer API key goes through the same path as in production.
function createApp() {
	const app = new OpenAPIHono()
	app.use('*', authMiddleware(db, { cacheTtlMs: 0 }))
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		const sessionManager = { stopSession: async () => {}, createSession: async () => ({}) }
		c.set('sessionManager' as never, sessionManager as never)
		// A viewer is turned away before any route touches storage.
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
	app.route('/api/objects', objectsRoutes as never)
	app.route('/api/relationships', relationshipsRoutes as never)
	app.route('/api/graph', graphRoutes as never)
	app.route('/api/files', filesRoutes as never)
	app.route('/api/files', fileCommentsRoutes as never)
	app.route('/api/files', fileProposalsRoutes as never)
	app.route('/api/events', eventsRoutes as never)
	app.route('/api/imports', importsRoutes as never)
	app.route('/api/voice-sessions', voiceSessionsRoutes as never)
	app.route('/api/notifications', notificationsRoutes as never)
	return app
}

describe('Viewer role is read-only', () => {
	let workspaceId: string
	let viewerKey: string
	let viewerId: string
	let memberKey: string
	let ownerKey: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		ownerKey = 'ank_testintegration'

		const viewer = await insertActor(db, { name: 'Viewer' })
		viewerId = viewer.id
		viewerKey = viewer.apiKey
		await db.insert(workspaceMembers).values({ workspaceId, actorId: viewer.id, role: 'viewer' })

		const member = await insertActor(db, { name: 'Member' })
		memberKey = member.apiKey
		await db.insert(workspaceMembers).values({ workspaceId, actorId: member.id, role: 'member' })
	})

	const auth = (key: string) => ({ Authorization: `Bearer ${key}`, 'x-workspace-id': workspaceId })

	it('returns 200 to a viewer on a read route', async () => {
		const res = await createApp().request(jsonGet('/api/objects', auth(viewerKey)))
		expect(res.status).toBe(200)
	})

	it('returns 403 to a viewer and 201 to a member on POST /api/objects', async () => {
		const app = createApp()
		const body = buildCreateObjectBody()

		const asViewer = await app.request(jsonRequest('POST', '/api/objects', body, auth(viewerKey)))
		expect(asViewer.status).toBe(403)
		expect((await asViewer.json()).error.code).toBe('FORBIDDEN')

		const asMember = await app.request(jsonRequest('POST', '/api/objects', body, auth(memberKey)))
		expect(asMember.status).toBe(201)

		const asOwner = await app.request(
			jsonRequest('POST', '/api/objects', buildCreateObjectBody(), auth(ownerKey)),
		)
		expect(asOwner.status).toBe(201)
	})

	it('returns 403 to a viewer on by-ID writes, even without the workspace header', async () => {
		const app = createApp()
		const obj = await insertObject(db, workspaceId, getTestActorId())
		const bearerOnly = { Authorization: `Bearer ${viewerKey}` }

		const patch = await app.request(
			jsonRequest('PATCH', `/api/objects/${obj.id}`, { title: 'renamed' }, bearerOnly),
		)
		expect(patch.status).toBe(403)

		const del = await app.request(jsonDelete(`/api/objects/${obj.id}`, bearerOnly))
		expect(del.status).toBe(403)

		// Reads by ID stay open to the viewer.
		const get = await app.request(jsonGet(`/api/objects/${obj.id}`, bearerOnly))
		expect(get.status).toBe(200)
	})

	it('returns 403 to a viewer on relationship and graph writes', async () => {
		const app = createApp()

		const rel = await app.request(
			jsonRequest('POST', '/api/relationships', buildCreateRelationshipBody(), auth(viewerKey)),
		)
		expect(rel.status).toBe(403)

		const graph = await app.request(
			jsonRequest('POST', '/api/graph', buildCreateGraphBody(), auth(viewerKey)),
		)
		expect(graph.status).toBe(403)
	})

	it('returns 403 to a viewer on file writes and 200 on file reads', async () => {
		const app = createApp()
		const [file] = await db
			.insert(files)
			.values(buildFile({ workspaceId, createdBy: getTestActorId() }) as never)
			.returning()
		const bearerOnly = { Authorization: `Bearer ${viewerKey}` }

		const create = await app.request(
			jsonRequest(
				'POST',
				'/api/files',
				{ name: 'notes.md', mime_type: 'text/markdown', content: '# notes' },
				auth(viewerKey),
			),
		)
		expect(create.status).toBe(403)

		// By-ID writes, even without the workspace header.
		const patch = await app.request(
			jsonRequest('PATCH', `/api/files/${file?.id}`, { name: 'renamed.md' }, bearerOnly),
		)
		expect(patch.status).toBe(403)
		const del = await app.request(jsonDelete(`/api/files/${file?.id}`, bearerOnly))
		expect(del.status).toBe(403)

		const list = await app.request(jsonGet('/api/files', auth(viewerKey)))
		expect(list.status).toBe(200)
	})

	it('returns 403 to a viewer on file comment writes and 200 on reads', async () => {
		const app = createApp()
		const [file] = await db
			.insert(files)
			.values(buildFile({ workspaceId, createdBy: getTestActorId() }) as never)
			.returning()
		const bearerOnly = { Authorization: `Bearer ${viewerKey}` }
		const base = `/api/files/${file?.id}/comments`

		const create = await app.request(
			jsonRequest(
				'POST',
				base,
				{ body: 'looks off', positionDoc: { x: 0.25, y: 0.5 } },
				bearerOnly,
			),
		)
		expect(create.status).toBe(403)

		const update = await app.request(
			jsonRequest('PATCH', `${base}/${randomUUID()}`, { resolved: true }, bearerOnly),
		)
		expect(update.status).toBe(403)

		const round = await app.request(
			jsonRequest(
				'POST',
				`${base}/rounds`,
				{ roundId: randomUUID(), targetObjectId: randomUUID(), commentIds: [randomUUID()] },
				bearerOnly,
			),
		)
		expect(round.status).toBe(403)

		const read = await app.request(jsonGet(base, bearerOnly))
		expect(read.status).toBe(200)
	})

	it('returns 403 to a viewer on submitting a file proposal', async () => {
		const app = createApp()
		const [file] = await db
			.insert(files)
			.values(buildFile({ workspaceId, createdBy: getTestActorId() }) as never)
			.returning()
		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/files/${file?.id}/proposals`,
				{ changes: [{ old_text: 'a', new_text: 'b' }] },
				{ Authorization: `Bearer ${viewerKey}` },
			),
		)
		expect(res.status).toBe(403)
	})

	it('returns 403 to a viewer on POST /api/events and 200 on event history', async () => {
		const app = createApp()
		const obj = await insertObject(db, workspaceId, getTestActorId())

		const comment = await app.request(
			jsonRequest('POST', '/api/events', { entity_id: obj.id, content: 'hello' }, auth(viewerKey)),
		)
		expect(comment.status).toBe(403)

		const history = await app.request(jsonGet('/api/events/history', auth(viewerKey)))
		expect(history.status).toBe(200)
	})

	it('returns 403 to a viewer on import writes and 200 on import reads', async () => {
		const app = createApp()

		const form = new FormData()
		form.append('file', new File(['title\nOne'], 'objects.csv', { type: 'text/csv' }))
		const upload = await app.request(
			new Request('http://localhost/api/imports', {
				method: 'POST',
				headers: auth(viewerKey),
				body: form,
			}),
		)
		expect(upload.status).toBe(403)

		// By-ID import writes are scoped by the workspace header.
		const mapping = await app.request(
			jsonRequest(
				'PATCH',
				`/api/imports/${randomUUID()}/mapping`,
				{
					mapping: {
						typeMappings: [
							{
								objectType: 'insight',
								columns: [{ sourceColumn: 'title', targetField: 'title' }],
							},
						],
					},
				},
				auth(viewerKey),
			),
		)
		expect(mapping.status).toBe(403)
		const confirm = await app.request(
			jsonRequest('POST', `/api/imports/${randomUUID()}/confirm`, undefined, auth(viewerKey)),
		)
		expect(confirm.status).toBe(403)

		const list = await app.request(jsonGet('/api/imports', auth(viewerKey)))
		expect(list.status).toBe(200)
	})

	it('lets a member write once a viewer is promoted', async () => {
		const app = createApp()
		await db
			.update(workspaceMembers)
			.set({ role: 'member' })
			.where(
				and(eq(workspaceMembers.actorId, viewerId), eq(workspaceMembers.workspaceId, workspaceId)),
			)

		const res = await app.request(
			jsonRequest('POST', '/api/objects', buildCreateObjectBody(), auth(viewerKey)),
		)
		expect(res.status).toBe(201)
	})

	describe('voice calls', () => {
		const addAgent = async () => {
			const agent = await insertActor(db, { type: 'agent', name: 'Chief of Staff', email: null })
			await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
			return agent
		}

		it('returns 403 to a viewer who tries to start a call', async () => {
			const agent = await addAgent()
			const res = await createApp().request(
				jsonRequest('POST', '/api/voice-sessions', { agent_actor_id: agent.id }, auth(viewerKey)),
			)
			expect(res.status).toBe(403)
			const rows = await db
				.select()
				.from(voiceSessions)
				.where(eq(voiceSessions.humanActorId, viewerId))
			expect(rows).toHaveLength(0)
		})

		it('returns 403 to a member demoted to viewer after the call was reserved', async () => {
			const agent = await addAgent()
			const [session] = await db
				.insert(voiceSessions)
				.values({
					workspaceId,
					agentActorId: agent.id,
					humanActorId: viewerId,
					status: 'pending',
					model: 'gpt-realtime',
					timeoutAt: new Date(Date.now() + 15 * 60_000),
				})
				.returning()
			const res = await createApp().request(
				jsonRequest(
					'POST',
					`/api/voice-sessions/${session?.id}/offer`,
					{ sdp: 'v=0' },
					auth(viewerKey),
				),
			)
			expect(res.status).toBe(403)
		})

		it('lets a viewer hang up their own call, so a demotion mid-call cannot strand it', async () => {
			const agent = await addAgent()
			const [session] = await db
				.insert(voiceSessions)
				.values({
					workspaceId,
					agentActorId: agent.id,
					humanActorId: viewerId,
					status: 'active',
					vendorSessionId: 'vs_test',
					model: 'gpt-realtime',
					timeoutAt: new Date(Date.now() + 15 * 60_000),
				})
				.returning()
			const res = await createApp().request(
				jsonRequest(
					'POST',
					`/api/voice-sessions/${session?.id}/hangup`,
					{ reason: 'user_hangup' },
					auth(viewerKey),
				),
			)
			expect(res.status).toBe(200)
		})
	})

	describe('notifications', () => {
		it('returns 403 to a viewer and 201 to a member on POST /api/notifications', async () => {
			const app = createApp()
			const body = buildCreateNotificationBody({ source_actor_id: getTestActorId() })

			const asViewer = await app.request(
				jsonRequest('POST', '/api/notifications', body, auth(viewerKey)),
			)
			expect(asViewer.status).toBe(403)
			expect((await asViewer.json()).error.code).toBe('FORBIDDEN')

			const asMember = await app.request(
				jsonRequest('POST', '/api/notifications', body, auth(memberKey)),
			)
			expect(asMember.status).toBe(201)
		})

		it('returns 403 to a viewer on edit of a notification that is not theirs, 200 to a member', async () => {
			const app = createApp()
			const other = await insertNotification(db, workspaceId, getTestActorId(), {
				targetActorId: getTestActorId(),
			})
			const bearerOnly = { Authorization: `Bearer ${viewerKey}` }

			const asViewer = await app.request(
				jsonRequest('PATCH', `/api/notifications/${other?.id}`, { status: 'seen' }, bearerOnly),
			)
			expect(asViewer.status).toBe(403)

			const asMember = await app.request(
				jsonRequest(
					'PATCH',
					`/api/notifications/${other?.id}`,
					{ status: 'seen' },
					auth(memberKey),
				),
			)
			expect(asMember.status).toBe(200)
			expect((await asMember.json()).status).toBe('seen')
		})

		it('returns 403 to a viewer on delete of a notification that is not theirs, 200 to a member', async () => {
			const app = createApp()
			const other = await insertNotification(db, workspaceId, getTestActorId(), {
				targetActorId: getTestActorId(),
			})
			// A notification with no target is nobody's own.
			const untargeted = await insertNotification(db, workspaceId, getTestActorId())
			const bearerOnly = { Authorization: `Bearer ${viewerKey}` }

			for (const n of [other, untargeted]) {
				const res = await app.request(jsonDelete(`/api/notifications/${n?.id}`, bearerOnly))
				expect(res.status).toBe(403)
			}

			const asMember = await app.request(
				jsonDelete(`/api/notifications/${other?.id}`, auth(memberKey)),
			)
			expect(asMember.status).toBe(200)
		})

		it('lets a viewer mark their own notification read and delete it', async () => {
			const app = createApp()
			const own = await insertNotification(db, workspaceId, getTestActorId(), {
				targetActorId: viewerId,
			})
			const bearerOnly = { Authorization: `Bearer ${viewerKey}` }

			const read = await app.request(
				jsonRequest('PATCH', `/api/notifications/${own?.id}`, { status: 'seen' }, bearerOnly),
			)
			expect(read.status).toBe(200)
			expect((await read.json()).status).toBe('seen')

			const del = await app.request(jsonDelete(`/api/notifications/${own?.id}`, bearerOnly))
			expect(del.status).toBe(200)
		})

		it('returns 403 to a viewer who writes metadata on their own notification', async () => {
			const app = createApp()
			const own = await insertNotification(db, workspaceId, getTestActorId(), {
				targetActorId: viewerId,
			})
			const bearerOnly = { Authorization: `Bearer ${viewerKey}` }

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/notifications/${own?.id}`,
					{ status: 'resolved', metadata: { response: 'forged' } },
					bearerOnly,
				),
			)
			expect(res.status).toBe(403)

			const [row] = await db
				.select()
				.from(notifications)
				.where(eq(notifications.id, own?.id as string))
			expect(row?.status).toBe('pending')
			expect(row?.metadata).toBeNull()
		})

		it('keeps a non-member on 404 for edit and delete', async () => {
			const app = createApp()
			const other = await insertNotification(db, workspaceId, getTestActorId())
			const stranger = await insertActor(db, { name: 'Stranger' })
			const headers = { Authorization: `Bearer ${stranger.apiKey}` }

			const patch = await app.request(
				jsonRequest('PATCH', `/api/notifications/${other?.id}`, { status: 'seen' }, headers),
			)
			expect(patch.status).toBe(404)
			const del = await app.request(jsonDelete(`/api/notifications/${other?.id}`, headers))
			expect(del.status).toBe(404)
		})
	})

	describe('workspace-auth helpers', () => {
		it('getWorkspaceRole returns the role, or null for a non-member', async () => {
			expect(await getWorkspaceRole(db, viewerId, workspaceId)).toBe('viewer')
			expect(await getWorkspaceRole(db, getTestActorId(), workspaceId)).toBe('owner')
			const stranger = await insertActor(db, { name: 'Stranger' })
			expect(await getWorkspaceRole(db, stranger.id, workspaceId)).toBeNull()
		})

		it('isWorkspaceWriter: true for writers, false for non-members, throws for viewers', async () => {
			const stranger = await insertActor(db, { name: 'Stranger' })

			expect(await isWorkspaceWriter(db, getTestActorId(), workspaceId)).toBe(true)
			expect(await isWorkspaceWriter(db, stranger.id, workspaceId)).toBe(false)
			await expect(isWorkspaceWriter(db, viewerId, workspaceId)).rejects.toMatchObject({
				status: 403,
			})
			// isWorkspaceMember is unchanged: a viewer is still a member for reads.
			expect(await isWorkspaceMember(db, viewerId, workspaceId)).toBe(true)
		})
	})
})
