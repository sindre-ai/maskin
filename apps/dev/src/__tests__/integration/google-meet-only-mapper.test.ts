import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { events, objects, relationships } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { synthesizeMeetOnlyEvent } from '../../lib/integrations/providers/google-meet/meet-only-event-mapper'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import {
	insertActor,
	insertObject,
	insertRelationship,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

describe('google-meet Meet-only mapper flip (bet 947e task 7753)', () => {
	let workspaceId: string
	let systemActorId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent', name: 'Google Meet System Actor' })
		systemActorId = agent.id
	})

	describe('synthesizeMeetOnlyEvent', () => {
		it('synthesises an event object with status=wrapped_up + a status_changed audit row', async () => {
			const meeting = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'meeting',
				title: 'Sebk / Prospect intro',
				status: 'done',
			})
			const result = await synthesizeMeetOnlyEvent(db, {
				workspaceId,
				systemActorId,
				meetingId: meeting.id,
				meetingTitle: meeting.title ?? null,
				conferenceRecordName: 'conferenceRecords/abc-123',
				participantsStructured: [
					{
						name: 'conferenceRecords/abc-123/participants/p1',
						signedInUser: { displayName: 'Alice' },
					},
					{
						name: 'conferenceRecords/abc-123/participants/p2',
						anonymousUser: { displayName: 'Bob' },
					},
				],
				participantsText: 'Alice, Bob',
			})
			expect(result).not.toBeNull()
			expect(result?.action).toBe('created')

			const [eventRow] = await db
				.select()
				.from(objects)
				.where(eq(objects.id, result?.eventId ?? ''))
				.limit(1)
			expect(eventRow?.type).toBe('event')
			expect(eventRow?.status).toBe('wrapped_up')
			const meta = (eventRow?.metadata ?? {}) as Record<string, unknown>
			expect(meta.google_meet_conference_record_name).toBe('conferenceRecords/abc-123')
			expect(meta.linked_meeting_id).toBe(meeting.id)
			expect(meta.no_platform_listing).toBe(true)
			expect((meta.participants_structured as unknown[]).length).toBe(2)

			const auditRows = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityType, 'event'),
						eq(events.entityId, result?.eventId ?? ''),
						eq(events.action, 'status_changed'),
					),
				)
			expect(auditRows).toHaveLength(1)
			const changes = (auditRows[0]?.data as { changes: { field: string; new: string }[] }).changes
			expect(changes).toEqual([{ field: 'status', old: 'pending', new: 'wrapped_up' }])

			const edges = await db
				.select()
				.from(relationships)
				.where(
					and(
						eq(relationships.sourceType, 'object'),
						eq(relationships.sourceId, meeting.id),
						eq(relationships.targetType, 'object'),
						eq(relationships.targetId, result?.eventId ?? ''),
					),
				)
			expect(edges).toHaveLength(1)
			expect(edges[0]?.type).toBe('relates_to')
		})

		it('is idempotent on google_meet_conference_record_name (Pub/Sub replay)', async () => {
			const meeting = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'meeting',
				title: 'Replay test',
				status: 'done',
			})
			const first = await synthesizeMeetOnlyEvent(db, {
				workspaceId,
				systemActorId,
				meetingId: meeting.id,
				meetingTitle: 'Replay test',
				conferenceRecordName: 'conferenceRecords/replay-1',
				participantsStructured: [{ name: 'p' }],
				participantsText: 'p',
			})
			const second = await synthesizeMeetOnlyEvent(db, {
				workspaceId,
				systemActorId,
				meetingId: meeting.id,
				meetingTitle: 'Replay test',
				conferenceRecordName: 'conferenceRecords/replay-1',
				participantsStructured: [{ name: 'p' }],
				participantsText: 'p',
			})
			expect(first?.action).toBe('created')
			expect(second?.action).toBe('existing')
			expect(second?.eventId).toBe(first?.eventId)

			const eventObjects = await db
				.select()
				.from(objects)
				.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'event')))
			expect(eventObjects).toHaveLength(1)

			const auditRows = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityType, 'event'),
						eq(events.entityId, first?.eventId ?? ''),
						eq(events.action, 'status_changed'),
					),
				)
			expect(auditRows).toHaveLength(1)
		})

		it('returns null when the meeting already has a linked event object', async () => {
			const meeting = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'meeting',
				title: 'Meet-hosted webinar',
				status: 'done',
			})
			const existingEvent = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'event',
				title: 'Luma webinar listing',
				status: 'scheduled',
			})
			await insertRelationship(db, getTestActorId(), {
				sourceType: 'object',
				sourceId: meeting.id,
				targetType: 'object',
				targetId: existingEvent.id,
				type: 'relates_to',
			})

			const result = await synthesizeMeetOnlyEvent(db, {
				workspaceId,
				systemActorId,
				meetingId: meeting.id,
				meetingTitle: meeting.title ?? null,
				conferenceRecordName: 'conferenceRecords/webinar-1',
				participantsStructured: [{ name: 'p' }],
				participantsText: 'p',
			})
			expect(result).toBeNull()

			const eventObjects = await db
				.select()
				.from(objects)
				.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'event')))
			expect(eventObjects).toHaveLength(1)
			expect(eventObjects[0]?.id).toBe(existingEvent.id)
		})

		it('detects an inbound linked event edge (event → meeting)', async () => {
			const meeting = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'meeting',
				title: 'Meet-hosted webinar (inbound edge)',
				status: 'done',
			})
			const existingEvent = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'event',
				title: 'Meetup listing',
				status: 'scheduled',
			})
			await insertRelationship(db, getTestActorId(), {
				sourceType: 'object',
				sourceId: existingEvent.id,
				targetType: 'object',
				targetId: meeting.id,
				type: 'has_meeting',
			})

			const result = await synthesizeMeetOnlyEvent(db, {
				workspaceId,
				systemActorId,
				meetingId: meeting.id,
				meetingTitle: meeting.title ?? null,
				conferenceRecordName: 'conferenceRecords/webinar-2',
				participantsStructured: [{ name: 'p' }],
				participantsText: 'p',
			})
			expect(result).toBeNull()
		})
	})

	describe('TriggerRunner integration', () => {
		it('fires a status_changed → wrapped_up trigger for the synthesised event', async () => {
			const targetAgent = await insertActor(db, { type: 'agent', name: 'Event Promoter (test)' })
			const meeting = await insertObject(db, workspaceId, getTestActorId(), {
				type: 'meeting',
				title: 'Meet-only smoke call',
				status: 'done',
			})
			// Mirror trigger 389b1d48's filter shape verbatim.
			const trigger = await insertTrigger(db, workspaceId, getTestActorId(), targetAgent.id, {
				type: 'event',
				config: {
					entity_type: 'event',
					action: 'status_changed',
					filter: { status: 'wrapped_up' },
				},
				enabled: true,
			})

			const result = await synthesizeMeetOnlyEvent(db, {
				workspaceId,
				systemActorId,
				meetingId: meeting.id,
				meetingTitle: meeting.title ?? null,
				conferenceRecordName: 'conferenceRecords/smoke-1',
				participantsStructured: [
					{ signedInUser: { displayName: 'Alice' } },
					{ anonymousUser: { displayName: 'Bob' } },
				],
				participantsText: 'Alice, Bob',
			})
			expect(result?.action).toBe('created')

			const [auditRow] = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityType, 'event'),
						eq(events.entityId, result?.eventId ?? ''),
						eq(events.action, 'status_changed'),
					),
				)
			expect(auditRow).toBeDefined()

			const bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
			const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
			const runner = new TriggerRunner(db, bridge, {
				createSession,
			} as unknown as SessionManager)
			await runner.start()
			try {
				bridge.emit('event', {
					workspace_id: workspaceId,
					entity_type: 'event',
					entity_id: result?.eventId,
					action: 'status_changed',
					actor_id: systemActorId,
					event_id: String(auditRow?.id),
				})
				const deadline = Date.now() + 3000
				while (createSession.mock.calls.length === 0 && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 50))
				}
			} finally {
				await runner.stop()
			}
			expect(createSession).toHaveBeenCalledTimes(1)
			const [, sessionArgs] = createSession.mock.calls[0] as [
				string,
				{ triggerId: string; actorId: string },
			]
			expect(sessionArgs.triggerId).toBe(trigger?.id)
			expect(sessionArgs.actorId).toBe(targetAgent.id)
		})
	})
})
