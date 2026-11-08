import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, readState, subscriptions, workspaceMembers } from '@maskin/db/schema'
import { sql } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

const { default: subscriptionsRoutes } = await import('../../routes/subscriptions')

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
		await next()
	})
	app.route('/api/subscriptions', subscriptionsRoutes)
	return app
}

type Aggregate = {
	entity_id: string
	unread_count: number
	mentioning_unread_count: number
	max_unread_attention: number | null
	latest_event_id: number
	latest_activity_at: string
}

/**
 * The unread feed aggregate as it was written before the rewrite: one LEFT JOIN of events per
 * subscription with the read high-water-mark as a per-row subquery and the mention test inside a
 * join OR. Kept here as the reference the new query must match row for row.
 */
async function legacyUnreadFeed(
	workspaceId: string,
	actorId: string,
	includeRecentlyRead: boolean,
): Promise<Aggregate[]> {
	const lastRead = sql`coalesce((select last_read_event_id from read_state where actor_id = ${actorId} and entity_type = s.entity_type and entity_id = s.entity_id), 0)`
	const window = includeRecentlyRead
		? sql`(e.id > ${lastRead} or e.created_at >= now() - interval '48 hours')`
		: sql`e.id > ${lastRead}`
	const rows = (await db.execute(sql`
		SELECT s.entity_id,
			coalesce(count(e.id) FILTER (WHERE e.id > ${lastRead}), 0)::int AS unread_count,
			coalesce(count(*) FILTER (WHERE e.id > ${lastRead}
				AND e.data->'mentions' @> jsonb_build_array(${actorId}::text)), 0)::int AS mentioning_unread_count,
			max((e.data->>'attention')::int) FILTER (WHERE e.id > ${lastRead}) AS max_unread_attention,
			max(e.id) AS latest_event_id,
			max(e.created_at) AS latest_activity_at
		FROM subscriptions s
		LEFT JOIN objects o ON s.entity_type = 'object' AND o.id = s.entity_id
		LEFT JOIN events e ON e.workspace_id = s.workspace_id
			AND e.entity_id = s.entity_id
			AND e.actor_id <> ${actorId}
			AND e.action = 'commented'
			AND ${window}
			AND (
				(e.entity_type = s.entity_type AND e.action = 'commented'
					AND e.data->'mentions' @> jsonb_build_array(${actorId}::text))
				OR (s.entity_type = 'object' AND e.entity_type = 'object' AND e.action = 'commented'
					AND o.type = 'onboarding_session')
			)
		WHERE s.workspace_id = ${workspaceId} AND s.actor_id = ${actorId}
		GROUP BY s.entity_type, s.entity_id
		HAVING count(e.id) > 0
		ORDER BY max(e.id) DESC
	`)) as unknown as Array<{
		entity_id: string
		unread_count: number
		mentioning_unread_count: number
		max_unread_attention: number | null
		latest_event_id: string | number
		latest_activity_at: Date | string
	}>
	// The old builder query returned a Date, which the handler serialised to an ISO string.
	return rows.map((r) => ({
		...r,
		latest_event_id: Number(r.latest_event_id),
		latest_activity_at: new Date(r.latest_activity_at).toISOString(),
	}))
}

describe('GET /api/subscriptions/unread matches the pre-rewrite query', () => {
	let workspaceId: string
	let aId: string
	let bId: string
	let cId: string

	async function comment(
		entityId: string,
		actorId: string,
		data: Record<string, unknown>,
		createdAt?: Date,
	): Promise<number> {
		const [row] = await db
			.insert(events)
			.values({
				workspaceId,
				actorId,
				action: 'commented',
				entityType: 'object',
				entityId,
				data: { content: 'x', ...data },
				...(createdAt ? { createdAt } : {}),
			})
			.returning({ id: events.id })
		return row.id
	}

	async function subscribe(entityId: string) {
		await db.insert(subscriptions).values({
			workspaceId,
			actorId: aId,
			entityType: 'object',
			entityId,
			source: 'commenter',
		})
	}

	async function markRead(entityId: string, upToEventId: number) {
		await db.insert(readState).values({
			workspaceId,
			actorId: aId,
			entityType: 'object',
			entityId,
			lastReadEventId: upToEventId,
		})
	}

	beforeEach(async () => {
		aId = getTestActorId()
		workspaceId = (await insertWorkspace(db, aId)).id
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
		const b = await insertActor(db, {
			name: 'Actor B',
			email: `b-${suffix}@test.com`,
			apiKey: `ank_b_${suffix}`,
		})
		const c = await insertActor(db, {
			name: 'Actor C',
			email: `c-${suffix}@test.com`,
			apiKey: `ank_c_${suffix}`,
		})
		bId = b.id
		cId = c.id
		await db.insert(workspaceMembers).values([
			{ workspaceId, actorId: bId, role: 'member' },
			{ workspaceId, actorId: cId, role: 'member' },
		])
	})

	it('returns the same rows and counts as the old query, with and without recently-read', async () => {
		const old = new Date(Date.now() - 72 * 60 * 60 * 1000)
		const mk = (title: string, type = 'task') =>
			insertObject(db, workspaceId, aId, { type, title, status: 'todo' })

		// Read halfway: two of three mentions are still unread.
		const half = await mk('half read')
		await subscribe(half.id)
		const h1 = await comment(half.id, bId, { mentions: [aId], attention: 2 })
		await comment(half.id, bId, { mentions: [aId], attention: 4 })
		await comment(half.id, bId, { mentions: [aId] })
		await markRead(half.id, h1)

		// Chatter and a mention of someone else never count.
		const chatter = await mk('chatter')
		await subscribe(chatter.id)
		await comment(chatter.id, bId, { mentions: [] })
		await comment(chatter.id, bId, { mentions: [cId], attention: 5 })
		await comment(chatter.id, bId, {})

		// A's own comment never counts, even when it mentions A.
		const own = await mk('own comment')
		await subscribe(own.id)
		await comment(own.id, aId, { mentions: [aId] })

		// Onboarding coach: a reply without a mention counts, a reply with one counts once.
		const onboarding = await mk('getting started', 'onboarding_session')
		await subscribe(onboarding.id)
		await comment(onboarding.id, bId, { attention: 3 })
		await comment(onboarding.id, bId, { mentions: [aId], attention: 1 })

		// Fully read, last mention older than the 48h window: only in the feed when
		// it is read recently, so it must be gone from both variants.
		const stale = await mk('stale read')
		await subscribe(stale.id)
		const s1 = await comment(stale.id, bId, { mentions: [aId] }, old)
		await markRead(stale.id, s1)

		// Fully read a moment ago: appears with zero unread when recently-read is on.
		const fresh = await mk('fresh read')
		await subscribe(fresh.id)
		const f1 = await comment(fresh.id, bId, { mentions: [aId] })
		await markRead(fresh.id, f1)

		// Unread and old: the window only widens the feed, it never hides unread.
		const oldUnread = await mk('old unread')
		await subscribe(oldUnread.id)
		await comment(oldUnread.id, bId, { mentions: [aId], attention: 5 }, old)

		// Mentions A but A does not follow it.
		const unfollowed = await mk('unfollowed')
		await comment(unfollowed.id, bId, { mentions: [aId] })

		const app = appAs(aId)
		for (const includeRecentlyRead of [false, true]) {
			const expected = await legacyUnreadFeed(workspaceId, aId, includeRecentlyRead)
			const res = await app.request(
				jsonGet(
					`/api/subscriptions/unread${includeRecentlyRead ? '?include_recently_read=true' : ''}`,
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { items: Aggregate[] }
			const actual = body.items.map((i) => ({
				entity_id: i.entity_id,
				unread_count: i.unread_count,
				mentioning_unread_count: i.mentioning_unread_count,
				max_unread_attention: i.max_unread_attention,
				latest_event_id: i.latest_event_id,
				latest_activity_at: i.latest_activity_at,
			}))

			// half read, onboarding coach and the old unread one; the fresh read one only when recent counts.
			expect(expected).toHaveLength(includeRecentlyRead ? 4 : 3)
			expect(actual).toEqual(expected)
			// Must be an ISO date, never the raw database text ("2026-01-01 00:00:00+00").
			for (const i of actual) expect(i.latest_activity_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
			expect(actual.some((i) => i.entity_id === unfollowed.id)).toBe(false)
			expect(actual.some((i) => i.entity_id === chatter.id)).toBe(false)
			expect(actual.some((i) => i.entity_id === own.id)).toBe(false)
			expect(actual.some((i) => i.entity_id === stale.id)).toBe(false)
			expect(actual.some((i) => i.entity_id === fresh.id)).toBe(includeRecentlyRead)
		}
	})

	it('answers the mention test from the partial index', async () => {
		const idx = (await db.execute(
			sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'events_comment_mentions_gin_idx'`,
		)) as unknown as Array<{ indexdef: string }>
		expect(idx).toHaveLength(1)
		expect(idx[0].indexdef).toContain('USING gin')
		expect(idx[0].indexdef).toContain("'commented'")
	})
})
