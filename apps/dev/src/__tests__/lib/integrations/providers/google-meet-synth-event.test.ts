import { beforeEach, describe, expect, it } from 'vitest'
import { synthesizeMeetOnlyWrappedEvent } from '../../../../lib/integrations/providers/google-meet/synth-event'
import { createTestContext } from '../../../setup'

const WORKSPACE_ID = 'ws-meet-only'
const MEETING_ID = 'meeting-mo-1'
const CONF_REC = 'conferenceRecords/meet-only-abc'
const SYSTEM_ACTOR = 'actor-system-1'

function baseInput(overrides: Partial<Parameters<typeof synthesizeMeetOnlyWrappedEvent>[1]> = {}) {
	return {
		workspaceId: WORKSPACE_ID,
		meetingId: MEETING_ID,
		conferenceRecordName: CONF_REC,
		participants: [
			{ name: 'p1', signedInUser: { displayName: 'Alice' } },
			{ name: 'p2', signedInUser: { displayName: 'Bob' } },
		],
		meetingTitle: 'Weekly Sync',
		meetingStartTime: '2026-09-14T10:00:00Z',
		...overrides,
	}
}

describe('synthesizeMeetOnlyWrappedEvent', () => {
	let ctx: ReturnType<typeof createTestContext>

	beforeEach(() => {
		ctx = createTestContext()
	})

	it('short-circuits idempotently when a synthesized event already exists', async () => {
		// First select = findExistingSynthesizedEvent → returns an existing row.
		ctx.mockResults.selectQueue = [[{ id: 'evt-existing' }]]

		const res = await synthesizeMeetOnlyWrappedEvent(ctx.db, baseInput())
		expect(res).toEqual({
			created: false,
			eventId: 'evt-existing',
			reason: 'already_synthesized',
		})
		// No inserts on the idempotent path.
		expect(ctx.calls.inserts).toHaveLength(0)
	})

	it('short-circuits when the meeting already has a linked event object', async () => {
		ctx.mockResults.selectQueue = [
			[], // findExistingSynthesizedEvent → none
			[{ id: 'rel-1' }], // meetingHasLinkedEvent → linked event exists
		]

		const res = await synthesizeMeetOnlyWrappedEvent(ctx.db, baseInput())
		expect(res).toEqual({
			created: false,
			reason: 'meeting_has_linked_event',
		})
		expect(ctx.calls.inserts).toHaveLength(0)
	})

	it('short-circuits when the workspace has no system actor id on the integration row', async () => {
		ctx.mockResults.selectQueue = [
			[], // findExistingSynthesizedEvent → none
			[], // meetingHasLinkedEvent → no linked event
			[{ config: {} }], // resolveSystemActorId → integration has no system_actor_id
		]

		const res = await synthesizeMeetOnlyWrappedEvent(ctx.db, baseInput())
		expect(res).toEqual({ created: false, reason: 'no_system_actor' })
		expect(ctx.calls.inserts).toHaveLength(0)
	})

	it('inserts a wrapped_up event object, emits status_changed, and links it to the meeting', async () => {
		ctx.mockResults.selectQueue = [
			[], // findExistingSynthesizedEvent → none
			[], // meetingHasLinkedEvent → no linked event
			[{ config: { system_actor_id: SYSTEM_ACTOR } }], // resolveSystemActorId
		]
		// Object insert returns the new event id; the events + relationships
		// inserts don't use .returning() so their mockResults.insert value is
		// irrelevant (the chain resolves to [] which is fine — the code
		// doesn't read the returned rows).
		ctx.mockResults.insertQueue = [[{ id: 'new-event-1' }]]

		const res = await synthesizeMeetOnlyWrappedEvent(ctx.db, baseInput())
		expect(res.created).toBe(true)
		expect(res.eventId).toBe('new-event-1')

		// Assert the three inserts were made in the right shape.
		expect(ctx.calls.inserts).toHaveLength(3)

		const objectInsert = ctx.calls.inserts[0] as Record<string, unknown>
		expect(objectInsert.workspaceId).toBe(WORKSPACE_ID)
		expect(objectInsert.type).toBe('event')
		expect(objectInsert.status).toBe('wrapped_up')
		expect(objectInsert.createdBy).toBe(SYSTEM_ACTOR)
		expect(objectInsert.title).toBe('Weekly Sync (Meet call)')
		const objectMetadata = objectInsert.metadata as Record<string, unknown>
		expect(objectMetadata.google_meet_conference_record_name).toBe(CONF_REC)
		expect(objectMetadata.meet_synthesized).toBe(true)
		expect(objectMetadata.attendee_count).toBe(2)
		expect(objectMetadata.attendee_display_names).toEqual(['Alice', 'Bob'])
		expect(objectMetadata.linked_meeting_id).toBe(MEETING_ID)

		const eventInsert = ctx.calls.inserts[1] as Record<string, unknown>
		expect(eventInsert.workspaceId).toBe(WORKSPACE_ID)
		expect(eventInsert.actorId).toBe(SYSTEM_ACTOR)
		expect(eventInsert.action).toBe('status_changed')
		expect(eventInsert.entityType).toBe('event')
		expect(eventInsert.entityId).toBe('new-event-1')
		const eventData = eventInsert.data as Record<string, unknown>
		const changes = eventData.changes as Record<string, unknown>
		expect(changes.status).toEqual({ old: 'live', new: 'wrapped_up' })
		expect(eventData.synthesized).toBe(true)
		expect(eventData.google_meet_conference_record_name).toBe(CONF_REC)

		const relInsert = ctx.calls.inserts[2] as Record<string, unknown>
		expect(relInsert.sourceType).toBe('object')
		expect(relInsert.sourceId).toBe(MEETING_ID)
		expect(relInsert.targetType).toBe('object')
		expect(relInsert.targetId).toBe('new-event-1')
		expect(relInsert.type).toBe('relates_to')
		expect(relInsert.createdBy).toBe(SYSTEM_ACTOR)
	})

	it('falls back to a synthetic title when the meeting has no title', async () => {
		ctx.mockResults.selectQueue = [
			[], // findExistingSynthesizedEvent
			[], // meetingHasLinkedEvent
			[{ config: { system_actor_id: SYSTEM_ACTOR } }],
		]
		ctx.mockResults.insertQueue = [[{ id: 'new-event-2' }]]

		await synthesizeMeetOnlyWrappedEvent(
			ctx.db,
			baseInput({ meetingTitle: null, meetingStartTime: '2026-09-14T10:00:00Z' }),
		)
		const objectInsert = ctx.calls.inserts[0] as Record<string, unknown>
		expect(objectInsert.title).toBe('Meet call — 2026-09-14T10:00:00Z')
	})

	it('handles anonymous + phone participants in the display-name list', async () => {
		ctx.mockResults.selectQueue = [[], [], [{ config: { system_actor_id: SYSTEM_ACTOR } }]]
		ctx.mockResults.insertQueue = [[{ id: 'new-event-3' }]]

		await synthesizeMeetOnlyWrappedEvent(
			ctx.db,
			baseInput({
				participants: [
					{ signedInUser: { displayName: 'Alice' } },
					{ anonymousUser: { displayName: 'Guest' } },
					{ phoneUser: { displayName: '+45 …' } },
					{}, // no display name — filtered out
				],
			}),
		)
		const objectInsert = ctx.calls.inserts[0] as Record<string, unknown>
		const objectMetadata = objectInsert.metadata as Record<string, unknown>
		expect(objectMetadata.attendee_count).toBe(4)
		expect(objectMetadata.attendee_display_names).toEqual(['Alice', 'Guest', '+45 …'])
	})

	it('recovers when the transactional insert races another delivery and the winner exists', async () => {
		ctx.mockResults.selectQueue = [
			[], // findExistingSynthesizedEvent
			[], // meetingHasLinkedEvent
			[{ config: { system_actor_id: SYSTEM_ACTOR } }],
			[{ id: 'race-winner-evt' }], // second findExistingSynthesizedEvent (recovery probe)
		]
		// Insert throws (simulating race — unique-idempotency clash upstream)
		ctx.mockResults.insertErrorQueue = [new Error('race')]

		const res = await synthesizeMeetOnlyWrappedEvent(ctx.db, baseInput())
		expect(res).toEqual({
			created: false,
			eventId: 'race-winner-evt',
			reason: 'already_synthesized',
		})
	})
})
