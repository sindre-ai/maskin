import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { files } from '@maskin/db/schema'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import {
	buildFile,
	insertActor,
	insertObject,
	insertRelationship,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: loopsRoutes } = await import('../../routes/loops')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

function makeApp(actorId: string) {
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
	app.route('/api/loops', loopsRoutes)
	return app
}

type NextSteps = {
	asks: Array<{
		triggerId: string
		triggerName: string | null
		agent: { id: string; name: string | null } | null
		pendingCount: number
	}>
	items: Array<{ id: string; type: string; title: string | null; status: string }>
}

type Briefings = {
	briefings: Array<{
		id: string
		name: string
		mimeType: string
		updatedAt: string
		sourceId: string
		sourceTitle: string | null
	}>
}

describe('Flow page reads: next steps and briefings (real Postgres)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	const addToLoop = (loopId: string, memberId: string) =>
		insertRelationship(db, actorId, {
			sourceType: 'object',
			sourceId: loopId,
			targetType: 'object',
			targetId: memberId,
			type: 'in_loop',
		})

	const read = async <T>(path: string, ws = workspaceId) => {
		const res = await makeApp(actorId).request(jsonGet(path, { 'x-workspace-id': ws }))
		expect(res.status).toBe(200)
		return (await res.json()) as T
	}

	describe('GET /api/loops/:id/next-steps', () => {
		it('lists asks first (most waiting, then spine order), then open members newest first', async () => {
			const relay = await insertActor(db, { name: 'Relay', type: 'agent' })
			const quill = await insertActor(db, { name: 'Quill', type: 'agent' })
			const quiet = await insertTrigger(db, workspaceId, actorId, relay.id, { name: 'Quiet step' })
			const one = await insertTrigger(db, workspaceId, actorId, relay.id, { name: 'One waiting' })
			const two = await insertTrigger(db, workspaceId, actorId, quill.id, { name: 'Two waiting' })
			const loop = await insertObject(db, workspaceId, actorId, {
				type: 'loop',
				status: 'learning',
				title: 'Flow',
				// Spine order: quiet, one, two. Two has more waiting so it leads.
				metadata: { trigger_ids: [quiet.id, one.id, two.id] },
			})
			await insertSession(db, workspaceId, relay.id, actorId, {
				triggerId: one.id,
				status: 'waiting_for_input',
			})
			for (let i = 0; i < 2; i++) {
				await insertSession(db, workspaceId, quill.id, actorId, {
					triggerId: two.id,
					status: 'waiting_for_input',
				})
			}
			// A finished session never counts as an ask.
			await insertSession(db, workspaceId, relay.id, actorId, {
				triggerId: quiet.id,
				status: 'completed',
			})

			const older = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'in_progress',
				title: 'Older open',
				updatedAt: new Date('2026-11-01T10:00:00Z'),
			})
			const newer = await insertObject(db, workspaceId, actorId, {
				type: 'bet',
				status: 'active',
				title: 'Newer open',
				updatedAt: new Date('2026-11-05T10:00:00Z'),
			})
			const done = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'done',
				title: 'Already done',
			})
			for (const member of [older, newer, done]) await addToLoop(loop.id, member.id)

			const body = await read<NextSteps>(`/api/loops/${loop.id}/next-steps`)
			expect(body.asks.map((a) => [a.triggerName, a.pendingCount])).toEqual([
				['Two waiting', 2],
				['One waiting', 1],
			])
			expect(body.asks[0]?.agent?.name).toBe('Quill')
			expect(body.items.map((i) => i.title)).toEqual(['Newer open', 'Older open'])
			expect(body.items[0]).toMatchObject({ id: newer.id, type: 'bet', status: 'active' })
		})

		it('caps the open members at 10', async () => {
			const loop = await insertObject(db, workspaceId, actorId, {
				type: 'loop',
				status: 'learning',
			})
			for (let i = 0; i < 12; i++) {
				const member = await insertObject(db, workspaceId, actorId, {
					type: 'task',
					status: 'todo',
					updatedAt: new Date(Date.UTC(2026, 10, 1, i)),
				})
				await addToLoop(loop.id, member.id)
			}
			const body = await read<NextSteps>(`/api/loops/${loop.id}/next-steps`)
			expect(body.items).toHaveLength(10)
		})

		it("uses the flow's own closed rules, and counts a member without the rule field as open", async () => {
			const loop = await insertObject(db, workspaceId, actorId, {
				type: 'loop',
				status: 'learning',
				metadata: {
					closed_statuses: { task: ['parked'] },
					closed_when: { insight: ['loop_stage=live'] },
				},
			})
			const parkedTask = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'parked',
				title: 'Closed by the flow',
			})
			// 'done' is closed by default, but this flow overrides the task set.
			const doneTask = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'done',
				title: 'Done but open here',
			})
			const liveInsight = await insertObject(db, workspaceId, actorId, {
				type: 'insight',
				status: 'new',
				title: 'Live stage',
				metadata: { loop_stage: 'live' },
			})
			const plainInsight = await insertObject(db, workspaceId, actorId, {
				type: 'insight',
				status: 'new',
				title: 'No stage field',
				metadata: null,
			})
			for (const m of [parkedTask, doneTask, liveInsight, plainInsight]) {
				await addToLoop(loop.id, m.id)
			}
			const body = await read<NextSteps>(`/api/loops/${loop.id}/next-steps`)
			expect(body.items.map((i) => i.title).sort()).toEqual([
				'Done but open here',
				'No stage field',
			])
		})

		it('returns empty lists, not an error, for a flow with nothing to do', async () => {
			const loop = await insertObject(db, workspaceId, actorId, { type: 'loop', status: 'draft' })
			expect(await read<NextSteps>(`/api/loops/${loop.id}/next-steps`)).toEqual({
				asks: [],
				items: [],
			})
		})

		it("never shows another workspace's flow or members", async () => {
			const other = await insertWorkspace(db, actorId)
			const relay = await insertActor(db, { name: 'Relay', type: 'agent' })
			const trig = await insertTrigger(db, other.id, actorId, relay.id)
			const foreign = await insertObject(db, other.id, actorId, {
				type: 'loop',
				status: 'learning',
				metadata: { trigger_ids: [trig.id] },
			})
			await insertSession(db, other.id, relay.id, actorId, {
				triggerId: trig.id,
				status: 'waiting_for_input',
			})
			const foreignMember = await insertObject(db, other.id, actorId, { type: 'task' })
			await addToLoop(foreign.id, foreignMember.id)

			// Asked through the other workspace's header: the flow does not exist here.
			expect(await read<NextSteps>(`/api/loops/${foreign.id}/next-steps`)).toEqual({
				asks: [],
				items: [],
			})

			// A member from another workspace linked into a flow here stays out.
			const loop = await insertObject(db, workspaceId, actorId, {
				type: 'loop',
				status: 'learning',
			})
			await addToLoop(loop.id, foreignMember.id)
			expect((await read<NextSteps>(`/api/loops/${loop.id}/next-steps`)).items).toEqual([])
		})
	})

	describe('GET /api/loops/:id/briefings', () => {
		const addFile = async (ws: string, overrides: Record<string, unknown> = {}) => {
			const [row] = await db
				.insert(files)
				.values(
					buildFile({
						workspaceId: ws,
						createdBy: actorId,
						kind: 'briefing',
						mimeType: 'text/html',
						...overrides,
					}) as typeof files.$inferInsert,
				)
				.returning()
			return row as NonNullable<typeof row>
		}
		const attach = (objectId: string, fileId: string) =>
			insertRelationship(db, actorId, {
				sourceType: 'object',
				sourceId: objectId,
				targetType: 'file',
				targetId: fileId,
				type: 'attached',
			})

		it('lists briefing pages attached to the flow or a member, newest first, each once', async () => {
			const loop = await insertObject(db, workspaceId, actorId, {
				type: 'loop',
				status: 'learning',
				title: 'Weekly review',
			})
			const member = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				title: 'Cycle 4',
			})
			await addToLoop(loop.id, member.id)

			const ownPage = await addFile(workspaceId, {
				name: 'flow.html',
				updatedAt: new Date('2026-11-03T09:00:00Z'),
			})
			const memberPage = await addFile(workspaceId, {
				name: 'cycle.html',
				updatedAt: new Date('2026-11-06T09:00:00Z'),
			})
			const bothPage = await addFile(workspaceId, {
				name: 'both.html',
				updatedAt: new Date('2026-11-04T09:00:00Z'),
			})
			await attach(loop.id, ownPage.id)
			await attach(member.id, memberPage.id)
			await attach(member.id, bothPage.id)
			await attach(loop.id, bothPage.id)

			const body = await read<Briefings>(`/api/loops/${loop.id}/briefings`)
			expect(body.briefings.map((b) => b.name)).toEqual(['cycle.html', 'both.html', 'flow.html'])
			expect(body.briefings[0]).toMatchObject({
				id: memberPage.id,
				mimeType: 'text/html',
				sourceId: member.id,
				sourceTitle: 'Cycle 4',
				updatedAt: '2026-11-06T09:00:00.000Z',
			})
			// Attached to both: the flow is the source, and the page shows once.
			expect(body.briefings[1]).toMatchObject({ id: bothPage.id, sourceId: loop.id })
		})

		it('leaves out other kinds of file, other flows, and other workspaces', async () => {
			const loop = await insertObject(db, workspaceId, actorId, {
				type: 'loop',
				status: 'learning',
			})
			const otherLoop = await insertObject(db, workspaceId, actorId, {
				type: 'loop',
				status: 'learning',
			})
			const notMember = await insertObject(db, workspaceId, actorId, { type: 'task' })
			await addToLoop(otherLoop.id, notMember.id)

			const note = await addFile(workspaceId, { name: 'note.html', kind: null })
			const otherFlowsPage = await addFile(workspaceId, { name: 'other.html' })
			const stranger = await addFile(workspaceId, { name: 'stranger.html' })
			await attach(loop.id, note.id)
			await attach(otherLoop.id, otherFlowsPage.id)
			await attach(notMember.id, stranger.id)

			const other = await insertWorkspace(db, actorId)
			const foreignLoop = await insertObject(db, other.id, actorId, {
				type: 'loop',
				status: 'learning',
			})
			const foreignPage = await addFile(other.id, { name: 'foreign.html' })
			await attach(foreignLoop.id, foreignPage.id)
			// A page from another workspace attached into this flow stays out too.
			await attach(loop.id, foreignPage.id)

			expect(await read<Briefings>(`/api/loops/${loop.id}/briefings`)).toEqual({ briefings: [] })
			// The other workspace's flow is empty when asked from this one.
			expect(await read<Briefings>(`/api/loops/${foreignLoop.id}/briefings`)).toEqual({
				briefings: [],
			})
		})

		it('returns an empty list for a flow with none and for an unknown id', async () => {
			const loop = await insertObject(db, workspaceId, actorId, { type: 'loop', status: 'draft' })
			expect(await read<Briefings>(`/api/loops/${loop.id}/briefings`)).toEqual({ briefings: [] })
			expect(
				await read<Briefings>('/api/loops/00000000-0000-4000-8000-000000000000/briefings'),
			).toEqual({ briefings: [] })
		})
	})
})
