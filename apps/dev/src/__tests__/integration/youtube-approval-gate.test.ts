import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrations, youtubeActionAudit, youtubePendingActions } from '@maskin/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { TokenManager } from '../../lib/integrations/oauth/token-manager'
import {
	YOUTUBE_ACTION_TTL_MS,
	countUnapprovedYoutubeExecutions,
	createPendingAction,
	expireYoutubeActions,
} from '../../lib/youtube/actions'
import { hashYoutubePayload } from '../../lib/youtube/hash'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

// The write client is mocked so nothing reaches Google. The real executor runs around it.
vi.mock('../../lib/youtube/google-write-client', () => ({
	googleWriteClient: { execute: vi.fn() },
}))
// There is no registered youtube provider on this branch yet; the executor only needs the name.
vi.mock('../../lib/integrations/registry', async (importOriginal) => {
	const original = await importOriginal<typeof import('../../lib/integrations/registry')>()
	return {
		...original,
		getProvider: (name: string) => (name === 'youtube' ? {} : original.getProvider(name)),
	}
})

// Captured events are recorded, not sent.
vi.mock('../../lib/analytics/posthog', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/analytics/posthog')>()),
	capturePosthogEvent: vi.fn(),
}))

const { capturePosthogEvent } = await import('../../lib/analytics/posthog')
const { googleWriteClient } = await import('../../lib/youtube/google-write-client')
const { executeApprovedYoutubeAction } = await import('../../lib/youtube/executor')
const { default: forYouRoutes } = await import('../../routes/for-you')
const { default: eventsRoutes } = await import('../../routes/events')
const { default: youtubeActionsRoutes } = await import('../../routes/youtube-actions')

const execute = vi.mocked(googleWriteClient.execute)

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

function appAs(actorId: string, actorType = 'human') {
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
		c.set('notifyBridge' as never, {} as never)
		c.set('sessionManager' as never, { createSession: async () => undefined } as never)
		await next()
	})
	app.route('/api/for-you', forYouRoutes)
	app.route('/api/events', eventsRoutes)
	app.route('/api/youtube/actions', youtubeActionsRoutes)
	return app
}

const COMMENT = {
	snippet: {
		videoId: 'vid123',
		topLevelComment: { snippet: { textOriginal: 'Thanks for watching!' } },
	},
}

describe('YouTube approval gate', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string
	let integrationId: string
	let cardObjectId: string

	beforeEach(async () => {
		execute.mockReset()
		execute.mockResolvedValue({ ok: true, code: 'ok' })
		vi.spyOn(TokenManager.prototype, 'getValidToken').mockResolvedValue('token')
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		agentId = (
			await insertActor(db, {
				type: 'agent',
				name: 'Video agent',
				email: null,
				apiKey: `ank_yt_${Date.now()}_${Math.random()}`,
			})
		).id
		const [integration] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: 'youtube',
				status: 'active',
				credentials: 'x',
				createdBy: humanId,
			})
			.returning()
		integrationId = (integration as { id: string }).id
		cardObjectId = (await insertObject(db, workspaceId, humanId, { type: 'task', status: 'todo' }))
			.id
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	const propose = (over: Partial<Parameters<typeof createPendingAction>[1]> = {}) =>
		createPendingAction(db, {
			workspaceId,
			integrationId,
			kind: 'post_comment',
			payload: COMMENT,
			targetVideoId: 'vid123',
			channelLabel: 'Maskin channel',
			requestedByActor: agentId,
			cardEntityId: cardObjectId,
			approverIds: [humanId],
			...over,
		})

	const rowOf = async (id: string) =>
		(await db.select().from(youtubePendingActions).where(eq(youtubePendingActions.id, id)))[0]
	const auditOf = async (id: string) =>
		(
			await db
				.select()
				.from(youtubeActionAudit)
				.where(eq(youtubeActionAudit.pendingActionId, id))
				.orderBy(youtubeActionAudit.createdAt)
		).map((r) => r.decision)

	async function forYou() {
		const res = await appAs(humanId).request(
			jsonGet('/api/for-you', { 'X-Workspace-Id': workspaceId }),
		)
		const body = (await res.json()) as {
			items: Array<{
				entity_id: string
				latest_mention?: {
					event_id: number
					content: string
					decision: { draft?: { body?: string }; title: string } | null
				}
			}>
		}
		return body.items
	}

	function tap(id: number, content: string, as = humanId, type = 'human') {
		return appAs(as, type).request(
			jsonRequest(
				'POST',
				'/api/events',
				{ entity_id: cardObjectId, content, parent_event_id: id },
				{ 'X-Workspace-Id': workspaceId },
			),
		)
	}

	function decide(
		id: string,
		body: Record<string, unknown>,
		as = humanId,
		type = 'human',
		headers: Record<string, string> = {},
	) {
		return appAs(as, type).request(
			jsonRequest('POST', `/api/youtube/actions/${id}/decision`, body, {
				'X-Workspace-Id': workspaceId,
				...headers,
			}),
		)
	}

	describe('asking for a change', () => {
		it('stores the request, returns its id and never calls Google', async () => {
			const created = await propose()
			expect(created.status).toBe('pending')
			const row = await rowOf(created.id)
			expect(row?.payload).toEqual(COMMENT)
			expect(row?.payloadHash).toBe(hashYoutubePayload(COMMENT))
			expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now() + YOUTUBE_ACTION_TTL_MS - 60_000)
			expect(execute).not.toHaveBeenCalled()
		})

		it('refuses a connection that is not a YouTube one in this workspace', async () => {
			const [other] = await db
				.insert(integrations)
				.values({
					workspaceId,
					provider: 'slack',
					status: 'active',
					credentials: 'x',
					createdBy: humanId,
				})
				.returning()
			await expect(propose({ integrationId: (other as { id: string }).id })).rejects.toThrow(
				'No YouTube connection',
			)
		})
	})

	describe('the card', () => {
		it('shows the stored request, and the agent note apart and labelled', async () => {
			const created = await propose({ agentNote: 'This is a great reply, trust me.' })
			const [item] = await forYou()
			expect(item?.latest_mention?.event_id).toBe(created.cardEventId)
			const draft = item?.latest_mention?.decision?.draft?.body ?? ''
			expect(draft).toContain('Thanks for watching!')
			expect(draft).toContain('https://www.youtube.com/watch?v=vid123')
			expect(draft).toContain('Maskin channel')
			expect(draft).not.toContain('trust me')
			expect(item?.latest_mention?.content).toContain("Agent's note")
			expect(item?.latest_mention?.content).toContain('trust me')
		})

		it('is drawn from the stored row, not from the text on the card event', async () => {
			const created = await propose()
			await db
				.update(events)
				.set({
					data: {
						content: 'Harmless',
						mentions: [humanId],
						youtube_action_id: created.id,
						decision: {
							title: 'Like a video?',
							summary: 'Just a like.',
							options: [
								{ label: 'Approve', consequences: ['a', 'b'] },
								{ label: 'Reject', consequences: ['c', 'd'], recommended: true },
							],
							draft: { body: 'a harmless like' },
						},
					},
				})
				.where(eq(events.id, created.cardEventId))
			const [item] = await forYou()
			expect(item?.latest_mention?.decision?.title).toBe('Approve this YouTube change?')
			expect(item?.latest_mention?.decision?.draft?.body).toContain('Thanks for watching!')
			expect(item?.latest_mention?.decision?.draft?.body).not.toContain('harmless like')
		})

		it('keeps two cards on the same object, one per held action', async () => {
			await propose()
			await propose({ payload: { ...COMMENT, snippet: { ...COMMENT.snippet, videoId: 'other' } } })
			expect(await forYou()).toHaveLength(2)
		})

		it('leaves the list once the action is decided', async () => {
			const created = await propose()
			expect((await tap(created.cardEventId, 'Reject')).status).toBe(201)
			expect(await forYou()).toEqual([])
		})

		it('cannot be posted through the comments route', async () => {
			const res = await appAs(agentId, 'agent').request(
				jsonRequest(
					'POST',
					'/api/events',
					{
						entity_id: cardObjectId,
						content: 'hi',
						youtube_action_id: 'x',
						metadata: { youtube_action_id: 'x' },
					},
					{ 'X-Workspace-Id': workspaceId },
				),
			)
			expect(res.status).toBe(201)
			const [posted] = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, cardObjectId), eq(events.actorId, agentId)))
				.orderBy(desc(events.id))
				.limit(1)
			expect((posted?.data as Record<string, unknown>).youtube_action_id).toBeUndefined()
		})
	})

	describe('approving with a tap', () => {
		it('runs the approved change once, clears the payload and audits each step', async () => {
			const created = await propose()
			const res = await tap(created.cardEventId, 'Approve')
			expect(res.status).toBe(201)
			await vi.waitFor(async () => expect((await rowOf(created.id))?.status).toBe('executed'))
			const row = await rowOf(created.id)
			expect(row?.approvedBy).toBe(humanId)
			expect(row?.payload).toBeNull()
			expect(row?.resultCode).toBe('ok')
			expect(execute).toHaveBeenCalledTimes(1)
			expect(execute.mock.calls[0]?.[0]).toMatchObject({ kind: 'post_comment', payload: COMMENT })
			expect(await auditOf(created.id)).toEqual(['approved', 'executed'])
			expect(await countUnapprovedYoutubeExecutions(db, workspaceId)).toBe(0)
		})

		it('ignores the same reply from an agent', async () => {
			const created = await propose()
			expect((await tap(created.cardEventId, 'Approve', agentId, 'agent')).status).toBe(201)
			expect((await rowOf(created.id))?.status).toBe('pending')
			expect(execute).not.toHaveBeenCalled()
		})

		it('ignores the same reply from a person working through MCP', async () => {
			const created = await propose()
			const res = await appAs(humanId).request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: cardObjectId, content: 'Approve', parent_event_id: created.cardEventId },
					{ 'X-Workspace-Id': workspaceId, 'x-client-source': 'mcp' },
				),
			)
			expect(res.status).toBe(201)
			expect((await rowOf(created.id))?.status).toBe('pending')
		})

		it('rejects without running anything and clears the payload', async () => {
			const created = await propose()
			expect((await tap(created.cardEventId, 'Reject')).status).toBe(201)
			const row = await rowOf(created.id)
			expect(row?.status).toBe('rejected')
			expect(row?.payload).toBeNull()
			expect(execute).not.toHaveBeenCalled()
			expect(await auditOf(created.id)).toEqual(['rejected'])
		})

		it('refuses an approval once the stored request no longer matches its hash', async () => {
			const created = await propose()
			await db
				.update(youtubePendingActions)
				.set({ payload: { ...COMMENT, snippet: { videoId: 'evil' } } })
				.where(eq(youtubePendingActions.id, created.id))
			const res = await tap(created.cardEventId, 'Approve')
			expect(res.status).toBe(409)
			const row = await rowOf(created.id)
			expect(row?.status).toBe('failed')
			expect(row?.resultCode).toBe('payload_changed')
			expect(execute).not.toHaveBeenCalled()
			expect(await auditOf(created.id)).toEqual(['refused'])
		})

		it('says so, and keeps the audit, when the action has expired', async () => {
			const created = await propose()
			await db
				.update(youtubePendingActions)
				.set({ expiresAt: new Date(Date.now() - 1000) })
				.where(eq(youtubePendingActions.id, created.id))
			const res = await tap(created.cardEventId, 'Approve')
			expect(res.status).toBe(409)
			expect((await rowOf(created.id))?.status).toBe('expired')
			expect(await auditOf(created.id)).toEqual(['expired'])
			expect(execute).not.toHaveBeenCalled()
		})
	})

	describe('the approval endpoint', () => {
		it('refuses an agent and records the refusal', async () => {
			const created = await propose()
			const res = await decide(
				created.id,
				{ decision: 'approve', payload_hash: hashYoutubePayload(COMMENT) },
				agentId,
				'agent',
			)
			expect(res.status).toBe(403)
			expect((await rowOf(created.id))?.status).toBe('pending')
			expect(await auditOf(created.id)).toEqual(['refused'])
		})

		it('refuses a person working through MCP', async () => {
			const created = await propose()
			const res = await decide(
				created.id,
				{ decision: 'approve', payload_hash: hashYoutubePayload(COMMENT) },
				humanId,
				'human',
				{ 'x-client-source': 'mcp' },
			)
			expect(res.status).toBe(403)
			expect((await rowOf(created.id))?.status).toBe('pending')
		})

		it('refuses a changed payload hash and an approval with no hash', async () => {
			const created = await propose()
			expect((await decide(created.id, { decision: 'approve' })).status).toBe(400)
			const changed = await decide(created.id, {
				decision: 'approve',
				payload_hash: 'a'.repeat(64),
			})
			expect(changed.status).toBe(409)
			expect((await rowOf(created.id))?.status).toBe('pending')
			expect(execute).not.toHaveBeenCalled()
		})

		it('approves with the right hash and reports where it stands', async () => {
			const created = await propose()
			const res = await decide(created.id, {
				decision: 'approve',
				payload_hash: hashYoutubePayload(COMMENT),
			})
			expect(res.status).toBe(200)
			await vi.waitFor(async () => expect((await rowOf(created.id))?.status).toBe('executed'))
			const status = await appAs(humanId).request(
				jsonGet(`/api/youtube/actions/${created.id}`, { 'X-Workspace-Id': workspaceId }),
			)
			const body = (await status.json()) as Record<string, unknown>
			expect(body).toMatchObject({ id: created.id, status: 'executed', result_code: 'ok' })
			expect(JSON.stringify(body)).not.toContain('Thanks for watching')
		})

		it('does not show an action of another workspace', async () => {
			const created = await propose()
			const otherWorkspace = (await insertWorkspace(db, humanId)).id
			const res = await appAs(humanId).request(
				jsonGet(`/api/youtube/actions/${created.id}`, { 'X-Workspace-Id': otherWorkspace }),
			)
			expect(res.status).toBe(404)
		})
	})

	describe('running once', () => {
		it('runs an action once when five people approve at the same time', async () => {
			const created = await propose()
			const hash = hashYoutubePayload(COMMENT)
			const results = await Promise.all(
				Array.from({ length: 5 }, () =>
					decide(created.id, { decision: 'approve', payload_hash: hash }),
				),
			)
			expect(results.filter((r) => r.status === 200)).toHaveLength(1)
			expect(results.filter((r) => r.status === 409)).toHaveLength(4)
			await vi.waitFor(async () => expect((await rowOf(created.id))?.status).toBe('executed'))
			// Direct runs racing the one that was started also find nothing to claim.
			await Promise.all(
				Array.from({ length: 5 }, () => executeApprovedYoutubeAction(db, created.id)),
			)
			expect(execute).toHaveBeenCalledTimes(1)
			expect(await auditOf(created.id)).toEqual(['approved', 'executed'])
		})

		it('does not run an action that expired after it was approved', async () => {
			const created = await propose()
			await decide(created.id, { decision: 'reject' })
			expect(await executeApprovedYoutubeAction(db, created.id)).toEqual({ ran: false })

			const second = await propose()
			await db
				.update(youtubePendingActions)
				.set({
					status: 'approved',
					approvedBy: humanId,
					approvedPayloadHash: hashYoutubePayload(COMMENT),
					expiresAt: new Date(Date.now() - 1000),
				})
				.where(eq(youtubePendingActions.id, second.id))
			expect(await executeApprovedYoutubeAction(db, second.id)).toEqual({ ran: false })
			expect(execute).not.toHaveBeenCalled()
		})

		it('fails, and does not call Google, when the request changed after approval', async () => {
			const created = await propose()
			await db
				.update(youtubePendingActions)
				.set({
					status: 'approved',
					approvedBy: humanId,
					approvedPayloadHash: hashYoutubePayload(COMMENT),
					payload: { snippet: { videoId: 'evil' } },
				})
				.where(eq(youtubePendingActions.id, created.id))
			expect(await executeApprovedYoutubeAction(db, created.id)).toEqual({
				ran: true,
				status: 'failed',
				resultCode: 'payload_changed',
			})
			expect(execute).not.toHaveBeenCalled()
		})

		it('ends as failed with only a code when Google refuses', async () => {
			execute.mockResolvedValue({ ok: false, code: 'http_403' })
			const created = await propose()
			await decide(created.id, { decision: 'approve', payload_hash: hashYoutubePayload(COMMENT) })
			await vi.waitFor(async () => expect((await rowOf(created.id))?.status).toBe('failed'))
			const row = await rowOf(created.id)
			expect(row?.resultCode).toBe('http_403')
			expect(row?.payload).toBeNull()
			expect(await auditOf(created.id)).toEqual(['approved', 'failed'])
		})
	})

	describe('the success event', () => {
		it('is sent once for each approval, rejection and expiry, with ids and categories only', async () => {
			vi.mocked(capturePosthogEvent).mockReset()
			vi.mocked(capturePosthogEvent).mockResolvedValue('skipped')
			const approved = await propose({ agentNote: 'secret note' })
			const rejected = await propose()
			const expired = await propose()
			await decide(approved.id, {
				decision: 'approve',
				payload_hash: hashYoutubePayload(COMMENT),
			})
			await decide(rejected.id, { decision: 'reject' })
			await db
				.update(youtubePendingActions)
				.set({ expiresAt: new Date(Date.now() - 1000) })
				.where(eq(youtubePendingActions.id, expired.id))
			await expireYoutubeActions(db)

			await vi.waitFor(() => {
				const decided = vi
					.mocked(capturePosthogEvent)
					.mock.calls.filter(([name]) => name === 'youtube_action_decided')
				expect(
					decided.map(([, , props]) => (props as { decision: string }).decision).sort(),
				).toEqual(['approved', 'expired', 'rejected'])
				expect(decided.map(([, id]) => id)).toContain(humanId)
				expect(decided.map(([, id]) => id)).toContain(workspaceId)
				for (const [, , props] of decided) {
					expect(props).toMatchObject({
						workspace_id: workspaceId,
						kind: 'post_comment',
						hours_to_decide: 0,
					})
					expect(JSON.stringify(props)).not.toContain('secret note')
					expect(JSON.stringify(props)).not.toContain('Thanks for watching')
				}
			})
		})
	})

	describe('the audit', () => {
		it('counts an executed action with no approval row, and only that', async () => {
			const created = await propose()
			await db.insert(youtubeActionAudit).values({
				workspaceId,
				pendingActionId: created.id,
				integrationId,
				kind: 'post_comment',
				decision: 'executed',
			})
			expect(await countUnapprovedYoutubeExecutions(db, workspaceId)).toBe(1)
			await db.insert(youtubeActionAudit).values({
				workspaceId,
				pendingActionId: created.id,
				integrationId,
				kind: 'post_comment',
				decision: 'approved',
				actorId: humanId,
			})
			expect(await countUnapprovedYoutubeExecutions(db, workspaceId)).toBe(0)
		})

		it('holds ids and codes only, never the request or the note', async () => {
			const created = await propose({ agentNote: 'secret note' })
			await decide(created.id, { decision: 'approve', payload_hash: hashYoutubePayload(COMMENT) })
			await vi.waitFor(async () => expect((await rowOf(created.id))?.status).toBe('executed'))
			const rows = await db
				.select()
				.from(youtubeActionAudit)
				.where(eq(youtubeActionAudit.pendingActionId, created.id))
			const text = JSON.stringify(rows)
			expect(text).not.toContain('Thanks for watching')
			expect(text).not.toContain('secret note')
		})
	})
})
