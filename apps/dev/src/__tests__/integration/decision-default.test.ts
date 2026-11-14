// A decision card can name a default for when nobody answers. At the deadline the agent that
// posted the card is woken once, with the default named. A card that could send, spend or delete
// is refused a default. Off unless the workspace has the decision-default flag.

import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { forYouWithdrawals } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordEventReturning } from '../../lib/events/record-event'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { DecisionDefaultWake } from '../../services/decision-default-wake'
import { SessionNotAdmittedError } from '../../services/self-start-limits'
import { ensureWorkspaceMember, insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { startSessionMock } = vi.hoisted(() => ({
	startSessionMock: vi.fn(
		async (_input: {
			actionPrompt?: string
			actorId?: string
			config?: Record<string, unknown>
			initiatedFromObjectId: string | null
		}) => ({ sessionId: 'session-1', state: 'queued', createdAt: new Date() }),
	),
}))

vi.mock('../../services/session-lifecycle', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/session-lifecycle')>()),
	startSession: startSessionMock,
}))

const { default: eventsRoutes } = await import('../../routes/events')

const MINUTE = 60_000

describe('default on silence', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string
	let previousFeatures: string | undefined

	function setFlag(on: boolean) {
		process.env.FF_WORKSPACE_FEATURES = on ? `${workspaceId}:decision-default` : ''
		_resetFeatureFlagConfig()
	}

	beforeEach(async () => {
		startSessionMock.mockReset()
		startSessionMock.mockResolvedValue({
			sessionId: 'session-1',
			state: 'queued',
			createdAt: new Date(),
		})
		previousFeatures = process.env.FF_WORKSPACE_FEATURES
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		agentId = (await insertActor(db, { type: 'agent', name: 'Events Lead' })).id
		await ensureWorkspaceMember(db, workspaceId, agentId)
		setFlag(true)
	})

	afterEach(() => {
		if (previousFeatures === undefined) Reflect.deleteProperty(process.env, 'FF_WORKSPACE_FEATURES')
		else process.env.FF_WORKSPACE_FEATURES = previousFeatures
		_resetFeatureFlagConfig()
	})

	const options = (extra: Record<string, unknown> = {}) => [
		{
			label: 'Use the short title',
			recommended: true,
			default_on_silence: true,
			consequences: ['Registration page goes live today', 'Title can still be changed'],
			...extra,
		},
		{ label: 'Hold', consequences: ['Nothing changes', 'Registration waits'] },
	]

	const baseCard = (overrides: Record<string, unknown> = {}) => ({
		title: 'Which webinar title should we use?',
		summary: 'The page is built and waits on a title. Two titles are drafted.',
		options: options(),
		expires_at: new Date(Date.now() + 60 * MINUTE).toISOString(),
		...overrides,
	})

	function appAs(actorId: string, actorType: string) {
		const app = new OpenAPIHono<{
			Variables: { db: Database; actorId: string; actorType: string }
		}>()
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', actorId)
			c.set('actorType', actorType)
			c.set('notifyBridge' as never, {} as never)
			c.set('sessionManager' as never, { createSession: async () => undefined } as never)
			await next()
		})
		app.route('/api/events', eventsRoutes)
		return app
	}

	const postCard = (objectId: string, decision: Record<string, unknown>) =>
		appAs(agentId, 'agent').request(
			jsonRequest(
				'POST',
				'/api/events',
				{ entity_id: objectId, content: 'Need a call.', mentions: [humanId], decision },
				{ 'X-Workspace-Id': workspaceId },
			),
		)

	const task = () => insertObject(db, workspaceId, humanId, { type: 'task', status: 'in_progress' })

	// A card as it sits in the table, with a deadline that can already be in the past (the API
	// would refuse that), posted at an earlier time.
	const storedCard = (objectId: string, expiresAt: Date, overrides: Record<string, unknown> = {}) =>
		recordEventReturning(db, {
			workspaceId,
			actorId: agentId,
			action: 'commented',
			entityType: 'object',
			entityId: objectId,
			data: {
				content: 'Need a call.',
				mentions: [humanId],
				decision: baseCard({ expires_at: expiresAt.toISOString(), ...overrides }),
			},
		})

	const wakeAt = (minutesAfterNow: number) =>
		new DecisionDefaultWake(db, { now: () => new Date(Date.now() + minutesAfterNow * MINUTE) })

	describe('posting a card', () => {
		it('accepts a default on a reversible option with a deadline', async () => {
			const res = await postCard((await task()).id, baseCard())
			expect(res.status).toBe(201)
		})

		it('refuses a default with no deadline', async () => {
			const res = await postCard((await task()).id, baseCard({ expires_at: undefined }))
			expect(res.status).toBe(400)
			expect(JSON.stringify(await res.json())).toContain('needs expires_at')
		})

		it('refuses a default on a card whose only other option is destructive', async () => {
			const res = await postCard(
				(await task()).id,
				baseCard({
					options: [
						{
							label: 'Hold',
							recommended: true,
							default_on_silence: true,
							consequences: ['Nothing is sent', 'The list waits'],
						},
						{
							label: 'Send to all',
							destructive: true,
							consequences: ['400 people get the email', 'It cannot be recalled'],
						},
					],
				}),
			)
			expect(res.status).toBe(400)
			expect(JSON.stringify(await res.json())).toContain('sends, spends or deletes')
		})

		it('refuses a default on the destructive option itself', async () => {
			const res = await postCard(
				(await task()).id,
				baseCard({ options: options({ destructive: true }) }),
			)
			expect(res.status).toBe(400)
		})

		it('refuses a default on a card with a draft', async () => {
			const draftTask = await insertObject(db, workspaceId, agentId, {
				type: 'task',
				status: 'backlog',
				content: 'Hi Ada,\n\nThursday works.',
				metadata: { kind: 'email', to: 'ada@example.com', subject: 'Thursday' },
			})
			const res = await postCard(
				(await task()).id,
				baseCard({ draft: { object_id: draftTask.id, label: 'Email to Ada' } }),
			)
			expect(res.status).toBe(400)
		})

		it('refuses a default when the workspace does not have the flag', async () => {
			setFlag(false)
			const res = await postCard((await task()).id, baseCard())
			expect(res.status).toBe(400)
			expect(JSON.stringify(await res.json())).toContain('not switched on')
		})
	})

	describe('at the deadline', () => {
		it('wakes the asking agent once, with the default named', async () => {
			const obj = await task()
			await storedCard(obj.id, new Date(Date.now() + 10 * MINUTE))

			const scan = wakeAt(15)
			await scan.tick()
			await scan.tick()

			expect(startSessionMock).toHaveBeenCalledTimes(1)
			const input = startSessionMock.mock.calls[0]?.[0]
			expect(input?.actorId).toBe(agentId)
			expect(input?.initiatedFromObjectId).toBe(obj.id)
			expect(input?.actionPrompt).toContain('No answer, default is: Use the short title')
			expect(input?.config).toMatchObject({ start_reason: 'driver_wake' })
		})

		it('does not wake before the deadline', async () => {
			await storedCard((await task()).id, new Date(Date.now() + 90 * MINUTE))
			await wakeAt(15).tick()
			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('does not wake for a card that ran out more than an hour ago', async () => {
			await storedCard((await task()).id, new Date(Date.now() + 10 * MINUTE))
			await wakeAt(120).tick()
			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('does not wake when a person tapped an option', async () => {
			const obj = await task()
			const card = await storedCard(obj.id, new Date(Date.now() + 10 * MINUTE))
			await recordEventReturning(db, {
				workspaceId,
				actorId: humanId,
				action: 'commented',
				entityType: 'object',
				entityId: obj.id,
				data: { content: 'Hold', parentEventId: Number(card.id) },
			})
			await wakeAt(15).tick()
			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('does not wake when the object has closed', async () => {
			const obj = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'done' })
			await storedCard(obj.id, new Date(Date.now() + 10 * MINUTE))
			await wakeAt(15).tick()
			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('does nothing when the workspace does not have the flag', async () => {
			await storedCard((await task()).id, new Date(Date.now() + 10 * MINUTE))
			setFlag(false)
			await wakeAt(15).tick()
			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('ignores a card with no default', async () => {
			await storedCard((await task()).id, new Date(Date.now() + 10 * MINUTE), {
				options: [
					{ label: 'A', recommended: true, consequences: ['Ships today', 'Costs a day'] },
					{ label: 'B', consequences: ['Ships Friday', 'Costs nothing'] },
				],
			})
			await wakeAt(15).tick()
			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('tries again next tick when the session could not start, and not when it was refused', async () => {
			const obj = await task()
			const card = await storedCard(obj.id, new Date(Date.now() + 10 * MINUTE))
			const scan = wakeAt(15)

			startSessionMock.mockRejectedValueOnce(new Error('runner down'))
			await scan.tick()
			expect(
				await db
					.select()
					.from(forYouWithdrawals)
					.where(eq(forYouWithdrawals.sourceCommentId, Number(card.id))),
			).toHaveLength(0)

			startSessionMock.mockRejectedValueOnce(
				new SessionNotAdmittedError(
					'agent_daily_budget',
					'blocked',
					'driver_wake',
					null,
					'over budget',
				),
			)
			await scan.tick()
			await scan.tick()
			expect(startSessionMock).toHaveBeenCalledTimes(2)
		})
	})
})
