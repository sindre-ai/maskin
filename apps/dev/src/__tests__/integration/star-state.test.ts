import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, starState, workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, desc, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import type { SessionManager } from '../../services/session-manager'
import { buildCreateObjectBody, insertActor, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

// Integration surface for the D5 star_state backend. Covers the round-trip
// guarantees the mock-based unit tests can't: composite-PK idempotency on
// repeat POST, cross-actor + cross-workspace scoping of the payload's
// is_starred_by_me hydration, and the events row landing on every write with
// the load-bearing mutation_type: 'star' tag (which the D5 Won criterion's
// PostHog check reads).

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: SessionManager
	}
}

const { default: objectsRoutes } = await import('../../routes/objects')

const mockSessionManager = {
	createSession: async () => ({ id: 'noop' }),
	stopSession: async () => undefined,
	pauseSession: async () => undefined,
	resumeSession: async () => undefined,
	writeInput: async () => undefined,
	on: () => undefined,
	off: () => undefined,
} as unknown as SessionManager

function appAs(actorId: string) {
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
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', mockSessionManager)
		await next()
	})
	app.route('/api/objects', objectsRoutes)
	return app
}

describe('Star state — D5 backend', () => {
	let workspaceId: string
	let aId: string
	let bId: string

	beforeEach(async () => {
		aId = getTestActorId()
		const ws = await insertWorkspace(db, aId)
		workspaceId = ws.id

		const b = await insertActor(db, {
			name: 'Actor B',
			email: `b-star-${Date.now()}@test.com`,
			apiKey: `ank_b_star_${Date.now()}`,
		})
		bId = b.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: bId, role: 'member' })
	})

	describe('star / unstar round trip', () => {
		it('star sets is_starred_by_me true, unstar flips it back to false, both idempotent', async () => {
			const appA = appAs(aId)
			const headersA = { 'x-workspace-id': workspaceId }

			const createRes = await appA.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), headersA),
			)
			const obj = await createRes.json()

			// Detail baseline: not starred.
			const detail1 = await appA
				.request(jsonGet(`/api/objects/${obj.id}`, headersA))
				.then((r) => r.json())
			expect(detail1.is_starred_by_me).toBe(false)

			// Star it — response body carries the state so clients can drop
			// optimistic state on a mismatch.
			const starRes = await appA.request(
				jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, headersA),
			)
			expect(starRes.status).toBe(200)
			const starBody = await starRes.json()
			expect(starBody.is_starred_by_me).toBe(true)
			expect(typeof starBody.starred_at).toBe('string')

			// Idempotent: a repeat POST is a 200 that keeps the state (and the
			// composite PK is unchanged). It still records a fresh audit event —
			// each toggle attempt is user-visible activity worth logging.
			const starAgainRes = await appA.request(
				jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, headersA),
			)
			expect(starAgainRes.status).toBe(200)
			const starAgainBody = await starAgainRes.json()
			expect(starAgainBody.is_starred_by_me).toBe(true)

			// Detail now reflects the star.
			const detail2 = await appA
				.request(jsonGet(`/api/objects/${obj.id}`, headersA))
				.then((r) => r.json())
			expect(detail2.is_starred_by_me).toBe(true)

			// Unstar → deleted row, false state.
			const unstarRes = await appA.request(jsonDelete(`/api/objects/${obj.id}/star`, headersA))
			expect(unstarRes.status).toBe(200)
			const unstarBody = await unstarRes.json()
			expect(unstarBody.is_starred_by_me).toBe(false)

			// Idempotent unstar.
			const unstarAgainRes = await appA.request(jsonDelete(`/api/objects/${obj.id}/star`, headersA))
			expect(unstarAgainRes.status).toBe(200)

			const detail3 = await appA
				.request(jsonGet(`/api/objects/${obj.id}`, headersA))
				.then((r) => r.json())
			expect(detail3.is_starred_by_me).toBe(false)

			// star_state row is really gone after the delete (not soft-flagged).
			const remaining = await db
				.select({ actorId: starState.actorId })
				.from(starState)
				.where(
					and(
						eq(starState.actorId, aId),
						eq(starState.entityType, 'object'),
						eq(starState.entityId, obj.id),
					),
				)
			expect(remaining).toHaveLength(0)
		})

		it('every write emits an events row tagged mutation_type: "star" — load-bearing for the D5 PostHog check', async () => {
			const appA = appAs(aId)
			const headersA = { 'x-workspace-id': workspaceId }

			const obj = await appA
				.request(jsonRequest('POST', '/api/objects', buildCreateObjectBody(), headersA))
				.then((r) => r.json())

			await appA.request(jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, headersA))
			await appA.request(jsonDelete(`/api/objects/${obj.id}/star`, headersA))

			// Fetch every event on this object; the star/unstar audit rows must
			// carry mutation_type='star' — without this tag the D5 Won criterion
			// (PostHog cross-device check) has nothing to read and D5 lands
			// Inconclusive.
			const rows = await db
				.select({
					action: events.action,
					data: events.data,
					actorId: events.actorId,
					entityId: events.entityId,
				})
				.from(events)
				.where(and(eq(events.entityId, obj.id), eq(events.actorId, aId)))
				.orderBy(desc(events.id))

			const starRows = rows.filter((r) => r.action === 'starred' || r.action === 'unstarred')
			expect(starRows).toHaveLength(2)
			for (const row of starRows) {
				const data = row.data as { mutation_type?: string; is_starred?: boolean } | null
				expect(data?.mutation_type).toBe('star')
				expect(typeof data?.is_starred).toBe('boolean')
			}
			// Sanity: one true, one false — the toggle recorded both directions.
			const isStarredValues = starRows.map(
				(r) => (r.data as { is_starred?: boolean } | null)?.is_starred,
			)
			expect(new Set(isStarredValues)).toEqual(new Set([true, false]))
		})
	})

	describe('list-endpoint per-actor scoping', () => {
		it('two actors on the same object — one stars, the other still sees is_starred_by_me: false', async () => {
			const appA = appAs(aId)
			const appB = appAs(bId)
			const headersA = { 'x-workspace-id': workspaceId }
			const headersB = { 'x-workspace-id': workspaceId }

			// A creates the object; B has membership so both can list it.
			const obj = await appA
				.request(jsonRequest('POST', '/api/objects', buildCreateObjectBody(), headersA))
				.then((r) => r.json())

			// A stars.
			await appA.request(jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, headersA))

			// A's list surface: object appears with is_starred_by_me: true.
			const listA = (await appA
				.request(jsonGet('/api/objects', headersA))
				.then((r) => r.json())) as Array<{ id: string; is_starred_by_me?: boolean }>
			const listItemA = listA.find((o) => o.id === obj.id)
			expect(listItemA).toBeDefined()
			expect(listItemA?.is_starred_by_me).toBe(true)

			// B's list surface: same object, is_starred_by_me: false. Per-actor
			// scoping via the WHERE actor_id = $1 clause in getStarredObjectIds
			// is the whole point of the polymorphic table; a leak here would let
			// one actor see another's stars.
			const listB = (await appB
				.request(jsonGet('/api/objects', headersB))
				.then((r) => r.json())) as Array<{ id: string; is_starred_by_me?: boolean }>
			const listItemB = listB.find((o) => o.id === obj.id)
			expect(listItemB).toBeDefined()
			expect(listItemB?.is_starred_by_me).toBe(false)

			// Same guarantee on the detail endpoint.
			const detailB = await appB
				.request(jsonGet(`/api/objects/${obj.id}`, headersB))
				.then((r) => r.json())
			expect(detailB.is_starred_by_me).toBe(false)
		})
	})

	describe('cross-workspace guard', () => {
		it('returns 403 when the object is in a workspace the caller is not scoped to', async () => {
			// Create a second workspace with a different actor; A tries to star
			// its object using their own workspace header. authMiddleware in prod
			// verifies the caller's workspace membership before this handler runs;
			// this test targets the handler's OWN workspace-of-object check, which
			// must fire even if the caller has any membership at all.
			const otherActor = await insertActor(db, {
				name: 'Other author',
				email: `other-star-${Date.now()}@test.com`,
				apiKey: `ank_other_star_${Date.now()}`,
			})
			const otherWs = await insertWorkspace(db, otherActor.id)

			const appOther = appAs(otherActor.id)
			const otherObj = await appOther
				.request(
					jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
						'x-workspace-id': otherWs.id,
					}),
				)
				.then((r) => r.json())

			const appA = appAs(aId)
			const starRes = await appA.request(
				jsonRequest('POST', `/api/objects/${otherObj.id}/star`, undefined, {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(starRes.status).toBe(403)

			const unstarRes = await appA.request(
				jsonDelete(`/api/objects/${otherObj.id}/star`, {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(unstarRes.status).toBe(403)

			// The 403 must not persist a row. Belt-and-braces read against
			// star_state — the composite PK would swallow a duplicate on retry,
			// so this asserts the endpoint refused BEFORE the insert.
			const leaked = await db
				.select({ actorId: starState.actorId })
				.from(starState)
				.where(and(eq(starState.actorId, aId), eq(starState.entityId, otherObj.id)))
			expect(leaked).toHaveLength(0)
		})
	})

	describe('list mixes starred + unstarred on the same page correctly', () => {
		it('hydrates is_starred_by_me per-row so a starred and an unstarred object appear side by side', async () => {
			// One actor, two objects on one page. The list handler's secondary
			// query keyed on the page ids must set is_starred_by_me on the row
			// that has a star_state row and leave the other as false — same
			// aggregate query, per-row merge.
			const appA = appAs(aId)
			const headersA = { 'x-workspace-id': workspaceId }

			const obj1 = await appA
				.request(jsonRequest('POST', '/api/objects', buildCreateObjectBody(), headersA))
				.then((r) => r.json())
			const obj2 = await appA
				.request(jsonRequest('POST', '/api/objects', buildCreateObjectBody(), headersA))
				.then((r) => r.json())

			await appA.request(jsonRequest('POST', `/api/objects/${obj1.id}/star`, undefined, headersA))

			const list = (await appA
				.request(jsonGet('/api/objects', headersA))
				.then((r) => r.json())) as Array<{ id: string; is_starred_by_me?: boolean }>

			const listItem1 = list.find((o) => o.id === obj1.id)
			const listItem2 = list.find((o) => o.id === obj2.id)
			expect(listItem1?.is_starred_by_me).toBe(true)
			expect(listItem2?.is_starred_by_me).toBe(false)
		})
	})
})
