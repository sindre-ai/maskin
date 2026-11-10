import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; notifyBridge: PgNotifyBridge }
}

const { default: eventsRoutes } = await import('../../routes/events')

function appAs(actorId: string) {
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('notifyBridge', { on: () => {}, off: () => {} } as unknown as PgNotifyBridge)
		await next()
	})
	app.route('/api/events', eventsRoutes)
	return app
}

// The stream holds the connection open with a heartbeat, so read until it goes quiet, then cancel.
async function readReplayIds(body: ReadableStream<Uint8Array>, idleMs = 1500): Promise<number[]> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let text = ''
	try {
		for (;;) {
			let timer: ReturnType<typeof setTimeout> | undefined
			const idle = new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), idleMs)
			})
			const chunk = await Promise.race([reader.read(), idle])
			if (timer) clearTimeout(timer)
			if (chunk === null || chunk.done) break
			text += decoder.decode(chunk.value, { stream: true })
		}
	} finally {
		await reader.cancel().catch(() => {})
	}
	return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
}

describe('GET /api/events reconnect replay', () => {
	it('replays this workspace after the cursor, oldest first, capped at 100', async () => {
		const actorId = getTestActorId()
		const wsA = (await insertWorkspace(db, actorId)).id
		const wsB = (await insertWorkspace(db, actorId)).id
		const row = (workspaceId: string) => ({
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'object',
			entityId: crypto.randomUUID(),
			data: {},
		})

		// Interleave the two workspaces so the ids of A are not contiguous.
		const aIds: number[] = []
		for (let i = 0; i < 105; i++) {
			const [a] = await db.insert(events).values(row(wsA)).returning({ id: events.id })
			aIds.push(a.id)
			await db.insert(events).values(row(wsB))
		}

		const app = appAs(actorId)
		const replay = async (cursor: number) => {
			const res = await app.request(
				jsonGet('/api/events', { 'x-workspace-id': wsA, 'Last-Event-ID': String(cursor) }),
			)
			expect(res.status).toBe(200)
			return readReplayIds(res.body as ReadableStream<Uint8Array>)
		}

		// From before the first event: the first 100 of A, in order, none of B's.
		expect(await replay(aIds[0] - 1)).toEqual(aIds.slice(0, 100))
		// From the middle: everything after the cursor, nothing at or before it.
		expect(await replay(aIds[102])).toEqual(aIds.slice(103))
		// From the end: nothing to replay.
		expect(await replay(aIds[104])).toEqual([])
	}, 30_000)
})
