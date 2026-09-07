import { events, orphanThreadDetections } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrphanThreadDetector } from '../../services/orphan-thread-detector'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const capturePosthogEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capturePosthogEvent(...args),
}))

async function insertRootCommentAt(opts: {
	workspaceId: string
	actorId: string
	entityId: string
	mentions: string[]
	content: string
	createdAt: Date
	metadata?: Record<string, unknown>
	decision?: Record<string, unknown>
}) {
	const rows = await db
		.insert(events)
		.values({
			workspaceId: opts.workspaceId,
			actorId: opts.actorId,
			action: 'commented',
			entityType: 'object',
			entityId: opts.entityId,
			data: {
				content: opts.content,
				mentions: opts.mentions,
				...(opts.metadata ? { metadata: opts.metadata } : {}),
				...(opts.decision ? { decision: opts.decision } : {}),
			},
			createdAt: opts.createdAt,
		})
		.returning({ id: events.id })
	return rows[0].id
}

async function insertReply(opts: {
	workspaceId: string
	actorId: string
	entityId: string
	parentEventId: number
	content?: string
	createdAt?: Date
}) {
	await db.insert(events).values({
		workspaceId: opts.workspaceId,
		actorId: opts.actorId,
		action: 'commented',
		entityType: 'object',
		entityId: opts.entityId,
		data: {
			content: opts.content ?? 'reply',
			parentEventId: opts.parentEventId,
		},
		createdAt: opts.createdAt ?? new Date(),
	})
}

describe('OrphanThreadDetector — integration', () => {
	beforeEach(() => {
		capturePosthogEvent.mockClear()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('fires and writes a ledger row for an un-replied @-mention older than 24h', async () => {
		const actor = getTestActorId()
		const ws = await insertWorkspace(db, actor)
		const object = await insertObject(db, ws.id, actor)
		const agent = await insertActor(db, { type: 'agent', name: 'Agent A' })

		const rootAt = new Date(Date.now() - 26 * 60 * 60 * 1000)
		const rootId = await insertRootCommentAt({
			workspaceId: ws.id,
			actorId: actor,
			entityId: object.id,
			mentions: [agent.id],
			content: 'Are we shipping this?',
			createdAt: rootAt,
		})

		const detector = new OrphanThreadDetector(db)
		await detector.tick()

		const ledger = await db
			.select()
			.from(orphanThreadDetections)
			.where(eq(orphanThreadDetections.rootCommentEventId, rootId))
		expect(ledger).toHaveLength(1)
		expect(ledger[0].expectedReplyActorId).toBe(agent.id)
		expect(ledger[0].threadKind).toBe('question')
		expect(Number(ledger[0].hoursWithoutReply)).toBeGreaterThanOrEqual(26)

		expect(capturePosthogEvent).toHaveBeenCalledTimes(1)
		const [event, distinctId, props] = capturePosthogEvent.mock.calls[0]
		expect(event).toBe('orphan_thread_detected')
		expect(distinctId).toBe(agent.id)
		expect(props).toMatchObject({
			workspace_id: ws.id,
			object_id: object.id,
			root_comment_event_id: rootId,
			expected_reply_actor_id: agent.id,
			thread_kind: 'question',
		})
	})

	it('does not double-fire on a repeat tick (ledger UNIQUE guards)', async () => {
		const actor = getTestActorId()
		const ws = await insertWorkspace(db, actor)
		const object = await insertObject(db, ws.id, actor)
		const agent = await insertActor(db, { type: 'agent', name: 'Agent B' })

		await insertRootCommentAt({
			workspaceId: ws.id,
			actorId: actor,
			entityId: object.id,
			mentions: [agent.id],
			content: 'ping',
			createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
		})

		const detector = new OrphanThreadDetector(db)
		await detector.tick()
		await detector.tick()

		const ledger = await db.select().from(orphanThreadDetections)
		expect(ledger).toHaveLength(1)
		expect(capturePosthogEvent).toHaveBeenCalledTimes(1)
	})

	it('does not fire when the mentioned agent has replied', async () => {
		const actor = getTestActorId()
		const ws = await insertWorkspace(db, actor)
		const object = await insertObject(db, ws.id, actor)
		const agent = await insertActor(db, { type: 'agent', name: 'Agent C' })

		const rootId = await insertRootCommentAt({
			workspaceId: ws.id,
			actorId: actor,
			entityId: object.id,
			mentions: [agent.id],
			content: 'thoughts?',
			createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
		})
		await insertReply({
			workspaceId: ws.id,
			actorId: agent.id,
			entityId: object.id,
			parentEventId: rootId,
		})

		const detector = new OrphanThreadDetector(db)
		await detector.tick()

		expect(capturePosthogEvent).not.toHaveBeenCalled()
		const ledger = await db.select().from(orphanThreadDetections)
		expect(ledger).toHaveLength(0)
	})

	it('accepts any human reply when the mention is human', async () => {
		const actor = getTestActorId()
		const ws = await insertWorkspace(db, actor)
		const object = await insertObject(db, ws.id, actor)
		const mentionedHuman = await insertActor(db, { type: 'human', name: 'Founder A' })
		const otherHuman = await insertActor(db, { type: 'human', name: 'Founder B' })

		const rootId = await insertRootCommentAt({
			workspaceId: ws.id,
			actorId: actor,
			entityId: object.id,
			mentions: [mentionedHuman.id],
			content: 'need a call',
			createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
		})
		await insertReply({
			workspaceId: ws.id,
			actorId: otherHuman.id,
			entityId: object.id,
			parentEventId: rootId,
		})

		const detector = new OrphanThreadDetector(db)
		await detector.tick()

		expect(capturePosthogEvent).not.toHaveBeenCalled()
	})

	it('classifies a comment carrying a decision block as decision_required', async () => {
		const actor = getTestActorId()
		const ws = await insertWorkspace(db, actor)
		const object = await insertObject(db, ws.id, actor)
		const agent = await insertActor(db, { type: 'agent', name: 'Agent D' })

		await insertRootCommentAt({
			workspaceId: ws.id,
			actorId: actor,
			entityId: object.id,
			mentions: [agent.id],
			content: 'pick one',
			createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
			decision: {
				title: 'Ship the retry backoff?',
				summary: '3 sessions stalled last night. The patch is written and tested.',
				ask: 'This changes what every running session does, so I will not ship it alone.',
				options: [
					{ label: 'Ship', recommended: true, consequences: ['Goes out tonight', 'No rollback'] },
					{ label: 'Hold', consequences: ['Nothing ships', 'Stalls keep happening'] },
				],
			},
		})

		const detector = new OrphanThreadDetector(db)
		await detector.tick()

		const ledger = await db.select().from(orphanThreadDetections)
		expect(ledger).toHaveLength(1)
		expect(ledger[0].threadKind).toBe('decision_required')
	})

	// `metadata.chips` was the pre-`decision` way to ask, and stored rows still
	// carry it. It is not a decision any more, so the ledger must record the
	// thread as the plain question it reads as — otherwise the escalation signal
	// keeps firing on a mechanism nothing renders.
	it('classifies a legacy metadata.chips comment as a question, not a decision', async () => {
		const actor = getTestActorId()
		const ws = await insertWorkspace(db, actor)
		const object = await insertObject(db, ws.id, actor)
		const agent = await insertActor(db, { type: 'agent', name: 'Agent Legacy' })

		await insertRootCommentAt({
			workspaceId: ws.id,
			actorId: actor,
			entityId: object.id,
			mentions: [agent.id],
			content: 'Which one should we take?',
			createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
			metadata: { chips: ['ship', 'wait', 'kill'] },
		})

		const detector = new OrphanThreadDetector(db)
		await detector.tick()

		const ledger = await db.select().from(orphanThreadDetections)
		expect(ledger).toHaveLength(1)
		expect(ledger[0].threadKind).toBe('question')
	})

	// A decision block that does not satisfy the schema is not a decision. This
	// is the shape a bare `typeof x === 'object'` check used to accept, which
	// made the detector disagree with the For You feed about the same row.
	it('classifies a malformed decision block as a question, not a decision', async () => {
		const actor = getTestActorId()
		const ws = await insertWorkspace(db, actor)
		const object = await insertObject(db, ws.id, actor)
		const agent = await insertActor(db, { type: 'agent', name: 'Agent Malformed' })

		await insertRootCommentAt({
			workspaceId: ws.id,
			actorId: actor,
			entityId: object.id,
			mentions: [agent.id],
			content: 'Which one should we take?',
			createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
			decision: {} as never,
		})

		const detector = new OrphanThreadDetector(db)
		await detector.tick()

		const ledger = await db.select().from(orphanThreadDetections)
		expect(ledger).toHaveLength(1)
		expect(ledger[0].threadKind).toBe('question')
	})

	it('ignores threads younger than the reply deadline', async () => {
		const actor = getTestActorId()
		const ws = await insertWorkspace(db, actor)
		const object = await insertObject(db, ws.id, actor)
		const agent = await insertActor(db, { type: 'agent', name: 'Agent E' })

		await insertRootCommentAt({
			workspaceId: ws.id,
			actorId: actor,
			entityId: object.id,
			mentions: [agent.id],
			content: 'still fresh',
			createdAt: new Date(Date.now() - 60 * 60 * 1000), // 1h old
		})

		const detector = new OrphanThreadDetector(db)
		await detector.tick()

		expect(capturePosthogEvent).not.toHaveBeenCalled()
	})

	it('ignores replies to a different object even if the parent event id collides', async () => {
		const actor = getTestActorId()
		const ws = await insertWorkspace(db, actor)
		const objectA = await insertObject(db, ws.id, actor)
		const objectB = await insertObject(db, ws.id, actor)
		const agent = await insertActor(db, { type: 'agent', name: 'Agent F' })

		const rootId = await insertRootCommentAt({
			workspaceId: ws.id,
			actorId: actor,
			entityId: objectA.id,
			mentions: [agent.id],
			content: 'reply here',
			createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
		})
		// A reply that references the same parentEventId but sits on a
		// different object must not satisfy the root — the entity guard is
		// what stops cross-object noise.
		await insertReply({
			workspaceId: ws.id,
			actorId: agent.id,
			entityId: objectB.id,
			parentEventId: rootId,
		})

		const detector = new OrphanThreadDetector(db)
		await detector.tick()

		expect(capturePosthogEvent).toHaveBeenCalledTimes(1)
	})
})
