import {
	events,
	messages,
	notifications,
	sessions,
	voiceSessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { capturePosthogEvent } from '../../lib/analytics/posthog'
import voiceSessionsRoutes from '../../routes/voice-sessions'
import { dropVoiceCallState, voiceCallState } from '../../services/voice-call-state'
import { type ReceiptDraft, postReceiptLine } from '../../services/voice-receipt'
import {
	endVoiceSession,
	recordVoiceToolCall,
	recordVoiceTurn,
} from '../../services/voice-session-lifecycle'
import { insertActor, insertConversation, insertObject, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/analytics/posthog')>()),
	capturePosthogEvent: vi.fn(async () => {}),
}))

// importing the route wires the closing-receipt hook, as in production
void voiceSessionsRoutes

async function seedCall(conversationId?: string) {
	const humanId = getTestActorId()
	const agent = await insertActor(db, {
		type: 'agent',
		name: 'Chief of Staff',
		email: null,
		metadata: { voice_enabled: true },
	})
	const ws = await insertWorkspace(db, humanId)
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
		.onConflictDoNothing()
	const [session] = await db
		.insert(voiceSessions)
		.values({
			workspaceId: ws.id,
			agentActorId: agent.id,
			humanActorId: humanId,
			status: 'active',
			vendorSessionId: 'vs_test',
			model: 'gpt-realtime',
			startedAt: new Date(Date.now() - 125_000),
			timeoutAt: new Date(Date.now() + 15 * 60_000),
			conversationId: conversationId ?? null,
		})
		.returning()
	if (!session) throw new Error('voice session insert failed')
	return { session, agent, ws, humanId }
}

const draft = (over: Partial<ReceiptDraft> = {}): ReceiptDraft => ({
	event: 'created_task',
	objectId: null,
	objectType: 'task',
	objectTitle: 'Reply to Anna',
	template: 'Created task {title}',
	...over,
})

type Seeded = Awaited<ReturnType<typeof seedCall>>
const line = (
	seeded: Seeded,
	over: Partial<Parameters<typeof postReceiptLine>[0]> & { draft?: ReceiptDraft } = {},
) =>
	postReceiptLine({
		db,
		session: seeded.session,
		agentName: 'Chief of Staff',
		tool: 'create_objects',
		draft: draft(),
		outcome: 'ran',
		nowMs: Date.now(),
		webAppBaseUrl: 'https://app.test',
		...over,
	})

const reload = async (id: string) =>
	(await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0]
const chatOf = async (id: string) => {
	const conversationId = (await reload(id))?.conversationId
	if (!conversationId) return []
	return db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(messages.id)
}
// biome-ignore lint/suspicious/noExplicitAny: the test reads loosely shaped message JSON
const metaOf = (m: { metadata: unknown } | undefined) => (m?.metadata ?? {}) as Record<string, any>
const endedEvent = (id: string) =>
	vi
		.mocked(capturePosthogEvent)
		.mock.calls.find(
			([event, , props]) => event === 'voice_session_ended' && props?.voice_session_id === id,
		)?.[2]

beforeEach(() => {
	vi.mocked(capturePosthogEvent).mockClear()
})

describe('call receipt against real Postgres', () => {
	it('a call that runs one write and ends normally leaves the line and one closing receipt naming it', async () => {
		const seeded = await seedCall()
		const object = await insertObject(db, seeded.ws.id, seeded.humanId, { title: 'Reply to Anna' })
		voiceCallState(seeded.session.id).startCards = [
			{ objectId: object.id, notificationId: null, source: 'curated', rank: 1 },
		]
		await line(seeded, { draft: draft({ objectId: object.id }), cardId: object.id })
		await recordVoiceTurn(db, seeded.session.id, { userAudioMs: 1000, agentAudioMs: 1000 })
		await recordVoiceToolCall(db, seeded.session.id)

		await endVoiceSession(db, { id: seeded.session.id, reason: 'user_hangup' })

		const [perWrite, summary, ...rest] = await chatOf(seeded.session.id)
		expect(rest).toEqual([])
		expect(metaOf(perWrite)).toMatchObject({
			source: 'voice',
			voice_session_id: seeded.session.id,
			kind: 'receipt',
			event: 'created_task',
			object_id: object.id,
			text: 'Created task "Reply to Anna"',
			outcome: 'ran',
		})
		expect(Number.isInteger(metaOf(perWrite).t)).toBe(true)
		expect(perWrite?.content).toBe(
			`Created task [Reply to Anna](https://app.test/${seeded.ws.id}/objects/${object.id})`,
		)
		expect(metaOf(summary)).toMatchObject({
			source: 'voice',
			voice_session_id: seeded.session.id,
			kind: 'receipt_summary',
			decided: [],
			created: [{ type: 'task', title: 'Reply to Anna', object_id: object.id }],
			next: [],
			not_done: [],
			numbers: {
				rank_1_card_at_start: object.id,
				first_card_named: 'none',
				cards_cleared: 1,
				end_reason: 'user_hangup',
			},
		})
		expect(metaOf(summary).duration_seconds).toBeGreaterThanOrEqual(124)
		expect(summary?.content).toContain('Call receipt')
		expect(summary?.content).toContain('Created task')
		expect(endedEvent(seeded.session.id)).toMatchObject({
			cards_cleared: 1,
			writes_done: 1,
			writes_held: 0,
			receipt_posted: true,
		})
	})

	it('a call that holds a send and then drops says the send was not done', async () => {
		const seeded = await seedCall()
		await recordVoiceTurn(db, seeded.session.id, { userAudioMs: 1000, agentAudioMs: 1000 })
		voiceCallState(seeded.session.id).pendingHold = () => ({
			tool: 'gmail_send_email',
			summary: 'Send this email',
			yesCount: 0,
		})

		await endVoiceSession(db, { id: seeded.session.id, reason: 'network_error' })

		const [summary, ...rest] = await chatOf(seeded.session.id)
		expect(rest).toEqual([])
		expect(metaOf(summary).not_done).toEqual([
			'Not done: Send this email. The call ended before your yes was used.',
		])
		expect(summary?.content).toContain(
			'Not done: Send this email. The call ended before your yes was used.',
		)
		expect(metaOf(summary).numbers.end_reason).toBe('network_error')
		expect(endedEvent(seeded.session.id)).toMatchObject({ writes_held: 1, writes_done: 0 })
	})

	it('a failed write appears with its reason, and a restart that lost the pending hold leaves that line out', async () => {
		const seeded = await seedCall()
		await line(seeded, { outcome: 'failed', reason: 'status is not allowed' })
		await recordVoiceToolCall(db, seeded.session.id)
		// no call state at all: as if the server restarted mid-call
		dropVoiceCallState(seeded.session.id)

		await endVoiceSession(db, { id: seeded.session.id, reason: 'server_stop' })

		const rows = await chatOf(seeded.session.id)
		expect(metaOf(rows[0])).toMatchObject({
			outcome: 'failed',
			text: 'Created task "Reply to Anna": failed (status is not allowed)',
		})
		const summary = rows[1]
		expect(summary?.content).toContain('Failed:')
		expect(summary?.content).toContain('status is not allowed')
		expect(metaOf(summary).not_done).toEqual([])
		expect(metaOf(summary).numbers).toMatchObject({
			rank_1_card_at_start: 'unknown',
			first_card_named: 'unknown',
			end_reason: 'server_stop',
		})
	})

	it('a call ended from the hangup route gets exactly one closing receipt, however often it is hung up', async () => {
		const seeded = await seedCall()
		await line(seeded)
		await recordVoiceToolCall(db, seeded.session.id)
		const app = createIntegrationApp({ path: '/api/voice-sessions', module: voiceSessionsRoutes })
		const hangup = () =>
			app.request(`/api/voice-sessions/${seeded.session.id}/hangup`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'network_error' }),
			})

		expect((await hangup()).status).toBe(200)
		expect((await hangup()).status).toBe(200)

		const summaries = (await chatOf(seeded.session.id)).filter(
			(m) => metaOf(m).kind === 'receipt_summary',
		)
		expect(summaries).toHaveLength(1)
		expect(metaOf(summaries[0]).numbers.end_reason).toBe('network_error')
		expect(summaries[0]?.content).toContain('socket drop')
	})

	it('reads the yes count and read-back of each send, one needing two yeses', async () => {
		const seeded = await seedCall()
		await line(seeded, {
			tool: 'gmail_send_email',
			draft: draft({ event: 'other', template: 'Ran gmail send email' }),
			send: { yesCount: 1, readBackMatches: true },
		})
		await line(seeded, {
			tool: 'gmail_send_email',
			draft: draft({ event: 'other', template: 'Ran gmail send email' }),
			send: { yesCount: 2, readBackMatches: true },
		})
		await recordVoiceToolCall(db, seeded.session.id)

		await endVoiceSession(db, { id: seeded.session.id, reason: 'user_hangup' })

		const summary = (await chatOf(seeded.session.id)).at(-1)
		expect(metaOf(summary).numbers.sends).toEqual([
			{ tool: 'gmail_send_email', outcome: 'ran', read_back_matches: true, yes_count: 1 },
			{ tool: 'gmail_send_email', outcome: 'ran', read_back_matches: true, yes_count: 2 },
		])
		expect(summary?.content).toContain('Send 1: read-back matched, 1 yes.')
		expect(summary?.content).toContain('Send 2: read-back matched, 2 yeses.')
		expect(endedEvent(seeded.session.id)).toMatchObject({ writes_held: 2 })
	})

	it('caps a long receipt at 25 lines and about 2,000 characters and ends with "and N more"', async () => {
		const seeded = await seedCall()
		for (let i = 0; i < 40; i++) {
			await line(seeded, {
				draft: draft({ objectTitle: `Task number ${i} with a fairly long title to fill space` }),
			})
		}
		await recordVoiceToolCall(db, seeded.session.id)

		await endVoiceSession(db, { id: seeded.session.id, reason: 'user_hangup' })

		const summary = (await chatOf(seeded.session.id)).at(-1)
		const lines = (summary?.content ?? '').split('\n')
		expect(lines.length).toBeLessThanOrEqual(25)
		expect(summary?.content.length).toBeLessThanOrEqual(2_000)
		expect(lines.some((l) => /^and \d+ more$/.test(l))).toBe(true)
		// The numbers are still complete: all 40 writes are in the saved lines.
		expect(metaOf(summary).created).toHaveLength(40)
	})

	it('a call that never got going leaves no chat and no receipt', async () => {
		const seeded = await seedCall()
		await endVoiceSession(db, { id: seeded.session.id, reason: 'idle_timeout' })
		expect((await reload(seeded.session.id))?.conversationId).toBeNull()
		expect(endedEvent(seeded.session.id)).toMatchObject({ receipt_posted: false })
	})

	it('wakes no agent, sends no push and adds no comment, even in the chat of an object', async () => {
		const humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId)
		const object = await insertObject(db, ws.id, humanId, { title: 'Reply to Anna' })
		const chat = await insertConversation(db, ws.id, humanId, {
			subjectType: 'object',
			subjectId: object.id,
		})
		const agent = await insertActor(db, { type: 'agent', name: 'Chief of Staff', email: null })
		const [row] = await db
			.insert(voiceSessions)
			.values({
				workspaceId: ws.id,
				agentActorId: agent.id,
				humanActorId: humanId,
				status: 'active',
				conversationId: chat?.id,
				startedAt: new Date(Date.now() - 30_000),
				timeoutAt: new Date(Date.now() + 900_000),
			})
			.returning()
		if (!row) throw new Error('insert failed')
		const seeded = { session: row, agent, ws, humanId }
		await line(seeded, { draft: draft({ objectId: object.id }) })
		await recordVoiceToolCall(db, row.id)

		await endVoiceSession(db, { id: row.id, reason: 'user_hangup' })

		expect(await chatOf(row.id)).toHaveLength(2)
		expect(await db.select().from(sessions).where(eq(sessions.workspaceId, ws.id))).toHaveLength(0)
		expect(
			await db.select().from(notifications).where(eq(notifications.workspaceId, ws.id)),
		).toHaveLength(0)
		const commented = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, object.id), eq(events.action, 'commented')))
		expect(commented).toHaveLength(0)
		// The audit event for the message carries ids only, never the receipt text.
		const posted = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, chat?.id ?? ''), eq(events.action, 'message_posted')))
		expect(posted.length).toBeGreaterThan(0)
		for (const e of posted) expect(JSON.stringify(e.data)).not.toContain('Reply to Anna')
	})

	it('holds no card, draft or transcript text in the ended event or the receipt numbers', async () => {
		const seeded = await seedCall()
		const object = await insertObject(db, seeded.ws.id, seeded.humanId, {
			title: 'Confidential pricing draft',
		})
		voiceCallState(seeded.session.id).startCards = [
			{ objectId: object.id, notificationId: null, source: 'curated', rank: 1 },
		]
		await line(seeded, {
			tool: 'gmail_send_email',
			draft: draft({
				event: 'other',
				objectId: object.id,
				objectTitle: 'Confidential pricing draft',
				template: 'Ran gmail send email on {title}',
			}),
			send: { yesCount: 1, readBackMatches: true },
			cardId: object.id,
		})
		await recordVoiceToolCall(db, seeded.session.id)

		await endVoiceSession(db, { id: seeded.session.id, reason: 'user_hangup' })

		const summary = (await chatOf(seeded.session.id)).at(-1)
		expect(JSON.stringify(metaOf(summary).numbers)).not.toContain('Confidential')
		expect(JSON.stringify(endedEvent(seeded.session.id))).not.toContain('Confidential')
	})
})
