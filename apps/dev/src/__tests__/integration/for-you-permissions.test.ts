import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaceMembers } from '@maskin/db/schema'
import { FOR_YOU_KIND } from '@maskin/shared'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertNotification, insertObject, insertWorkspace } from '../factories'
import { jsonDelete, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

const { default: notificationsRoutes } = await import('../../routes/notifications')

function appAs(actorId: string, actorType: 'human' | 'agent') {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		await next()
	})
	app.route('/api/notifications', notificationsRoutes)
	return app
}

const forYouMetadata = { kind: FOR_YOU_KIND, rank: 1, headline: 'Decide the pricing' }

describe('For You curation permissions', () => {
	let workspaceId: string
	let ownerId: string
	let memberId: string
	let cosId: string
	let otherAgentId: string
	let headers: Record<string, string>

	function createBody(overrides: Record<string, unknown> = {}) {
		return {
			type: 'needs_input',
			title: 'Pricing',
			source_actor_id: cosId,
			target_actor_id: ownerId,
			metadata: forYouMetadata,
			...overrides,
		}
	}

	function mkActor(type: 'human' | 'agent', name: string) {
		const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`
		return insertActor(db, {
			type,
			name,
			email: type === 'human' ? `${tag}@test.dev` : null,
			apiKey: `ank_${tag}`,
		})
	}

	beforeEach(async () => {
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
		headers = { 'x-workspace-id': workspaceId }
		cosId = (await mkActor('agent', 'Chief of Staff')).id
		otherAgentId = (await mkActor('agent', 'Developer')).id
		memberId = (await mkActor('human', 'Member')).id
		for (const actorId of [cosId, otherAgentId, memberId]) {
			await db.insert(workspaceMembers).values({ workspaceId, actorId, role: 'member' })
		}
	})

	describe('create', () => {
		it('lets the Chief of Staff create an item for a human member', async () => {
			const res = await appAs(cosId, 'agent').request(
				jsonRequest('POST', '/api/notifications', createBody(), headers),
			)
			expect(res.status).toBe(201)
		})

		it('refuses another agent', async () => {
			const res = await appAs(otherAgentId, 'agent').request(
				jsonRequest('POST', '/api/notifications', createBody(), headers),
			)
			expect(res.status).toBe(403)
		})

		it('refuses a human member', async () => {
			const res = await appAs(memberId, 'human').request(
				jsonRequest('POST', '/api/notifications', createBody(), headers),
			)
			expect(res.status).toBe(403)
		})

		it('still lets anyone create an ordinary notification', async () => {
			const res = await appAs(otherAgentId, 'agent').request(
				jsonRequest('POST', '/api/notifications', createBody({ metadata: undefined }), headers),
			)
			expect(res.status).toBe(201)
		})

		it('rejects a target that is not in the workspace', async () => {
			const outsider = await mkActor('human', 'Outsider')
			const res = await appAs(cosId, 'agent').request(
				jsonRequest(
					'POST',
					'/api/notifications',
					createBody({ target_actor_id: outsider.id }),
					headers,
				),
			)
			expect(res.status).toBe(400)
		})

		it('rejects an agent as the target', async () => {
			const res = await appAs(cosId, 'agent').request(
				jsonRequest(
					'POST',
					'/api/notifications',
					createBody({ target_actor_id: otherAgentId }),
					headers,
				),
			)
			expect(res.status).toBe(400)
		})

		it('rejects an object from another workspace', async () => {
			const otherWs = await insertWorkspace(db, ownerId)
			const foreign = await insertObject(db, otherWs.id, ownerId)
			const res = await appAs(cosId, 'agent').request(
				jsonRequest('POST', '/api/notifications', createBody({ object_id: foreign.id }), headers),
			)
			expect(res.status).toBe(404)
		})

		it('accepts an object from this workspace', async () => {
			const own = await insertObject(db, workspaceId, ownerId)
			const res = await appAs(cosId, 'agent').request(
				jsonRequest('POST', '/api/notifications', createBody({ object_id: own.id }), headers),
			)
			expect(res.status).toBe(201)
		})
	})

	describe('edit, resolve and delete', () => {
		let itemId: string

		beforeEach(async () => {
			itemId = (
				await insertNotification(db, workspaceId, cosId, {
					targetActorId: ownerId,
					metadata: forYouMetadata,
				})
			).id
		})

		it('refuses another agent editing, resolving or deleting', async () => {
			const app = appAs(otherAgentId, 'agent')
			const edit = await app.request(
				jsonRequest('PATCH', `/api/notifications/${itemId}`, {
					metadata: { ...forYouMetadata, rank: 99 },
				}),
			)
			const resolve = await app.request(
				jsonRequest('PATCH', `/api/notifications/${itemId}`, { status: 'resolved' }),
			)
			const del = await app.request(jsonDelete(`/api/notifications/${itemId}`))
			expect([edit.status, resolve.status, del.status]).toEqual([403, 403, 403])
		})

		it("refuses a member touching another member's item", async () => {
			const app = appAs(memberId, 'human')
			const resolve = await app.request(
				jsonRequest('PATCH', `/api/notifications/${itemId}`, { status: 'resolved' }),
			)
			const del = await app.request(jsonDelete(`/api/notifications/${itemId}`))
			expect([resolve.status, del.status]).toEqual([403, 403])
		})

		it("refuses a member responding to another member's item", async () => {
			const res = await appAs(memberId, 'human').request(
				jsonRequest('POST', `/api/notifications/${itemId}/respond`, { response: 'ok' }, headers),
			)
			expect(res.status).toBe(403)
		})

		it('refuses turning an ordinary notification into a For You item', async () => {
			const plain = await insertNotification(db, workspaceId, cosId, { targetActorId: memberId })
			const res = await appAs(memberId, 'human').request(
				jsonRequest('PATCH', `/api/notifications/${plain.id}`, { metadata: forYouMetadata }),
			)
			expect(res.status).toBe(403)
		})

		it('lets the person dismiss their own item', async () => {
			const res = await appAs(ownerId, 'human').request(
				jsonRequest('PATCH', `/api/notifications/${itemId}`, { status: 'resolved' }),
			)
			expect(res.status).toBe(200)
			expect((await res.json()).status).toBe('resolved')
		})

		it('lets the person delete their own item', async () => {
			const res = await appAs(ownerId, 'human').request(jsonDelete(`/api/notifications/${itemId}`))
			expect(res.status).toBe(200)
		})

		it('refuses the person rewriting their own item metadata', async () => {
			const res = await appAs(ownerId, 'human').request(
				jsonRequest('PATCH', `/api/notifications/${itemId}`, {
					metadata: { ...forYouMetadata, rank: 0 },
				}),
			)
			expect(res.status).toBe(403)
		})

		it('lets the Chief of Staff re-rank and delete', async () => {
			const app = appAs(cosId, 'agent')
			const edit = await app.request(
				jsonRequest('PATCH', `/api/notifications/${itemId}`, {
					metadata: { ...forYouMetadata, rank: 3 },
				}),
			)
			const del = await app.request(jsonDelete(`/api/notifications/${itemId}`))
			expect([edit.status, del.status]).toEqual([200, 200])
		})
	})
})
