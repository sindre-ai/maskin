import type { Database } from '@maskin/db'
import { events, objects, relationships } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { logger } from '../../../logger'

/**
 * Delivers the Sebk-locked 2026-09-13 scope-add (bet 947e, decision 548410 →
 * reply 562182): Meet-only calls (no linked Meetup/Luma event) auto-fire the
 * Event Promoter's Capture attendees trigger (short-id 389b1d48) via a mapper
 * flip in Task 3's webhook fan-out.
 *
 * Trigger 389b1d48's filter is `entity_type=event, status_changed → wrapped_up`
 * (see Task 6 audit comment 548343). Meet-only calls have no linked event
 * object today, so today they are silent by design. This mapper synthesises an
 * event-shaped signal that matches the trigger's exact contract — do NOT
 * migrate 389b1d48's filter (bet body: "Match the exact contract 389b1d48
 * reads").
 *
 * Shape decision — synthesise a new type='event' object rather than flipping an
 * existing event's status: Meet-only calls have no linked event to flip, so (a)
 * is the only path that fires the trigger. The idempotency key
 * (`metadata.google_meet_conference_record_name`) mirrors what fanOutMeetEvent
 * already uses for meeting writes, so a Pub/Sub replay of the same messageId
 * lands as a no-op.
 *
 * Two-step object lifecycle is load-bearing: the trigger runner
 * (services/trigger-runner.ts:1589) only fires status_changed on a PATCH-shaped
 * transition, not on a fresh INSERT. So we insert with status='pending',
 * UPDATE to 'wrapped_up', and manually insert the status_changed audit event
 * that the PgNotifyBridge picks up — same shape objects.ts uses on PATCH.
 */

export interface SynthesizeMeetOnlyEventArgs {
	workspaceId: string
	systemActorId: string
	meetingId: string
	meetingTitle: string | null
	conferenceRecordName: string
	participantsStructured: unknown[]
	participantsText: string
}

export interface SynthesizeMeetOnlyEventResult {
	eventId: string
	action: 'created' | 'existing'
}

/** Initial status for the synthesised event, flipped to 'wrapped_up' below. */
const INITIAL_EVENT_STATUS = 'pending'
/** Terminal status that trigger 389b1d48's filter matches on. */
const TERMINAL_EVENT_STATUS = 'wrapped_up'

/**
 * Returns true when the meeting is linked to any existing type='event' object.
 * Meet-hosted webinars with a Meetup/Luma listing already have that event
 * object, and the Skjald/Luma lifecycle owns its status transitions — we must
 * NOT synthesise a second event for them.
 */
async function meetingHasLinkedEvent(
	db: Database,
	workspaceId: string,
	meetingId: string,
): Promise<boolean> {
	// Cover both directions: some workspace flows edge meeting→event
	// (relates_to / about), others event→meeting.
	const outgoing = await db
		.select({ id: relationships.id })
		.from(relationships)
		.innerJoin(
			objects,
			and(eq(objects.id, relationships.targetId), eq(objects.workspaceId, workspaceId)),
		)
		.where(
			and(
				eq(relationships.sourceType, 'object'),
				eq(relationships.sourceId, meetingId),
				eq(relationships.targetType, 'object'),
				eq(objects.type, 'event'),
			),
		)
		.limit(1)
	if (outgoing[0]) return true
	const incoming = await db
		.select({ id: relationships.id })
		.from(relationships)
		.innerJoin(
			objects,
			and(eq(objects.id, relationships.sourceId), eq(objects.workspaceId, workspaceId)),
		)
		.where(
			and(
				eq(relationships.targetType, 'object'),
				eq(relationships.targetId, meetingId),
				eq(relationships.sourceType, 'object'),
				eq(objects.type, 'event'),
			),
		)
		.limit(1)
	return Boolean(incoming[0])
}

/** Look up an already-synthesised event for this conference record — the replay guard. */
async function findExistingSynthesizedEvent(
	db: Database,
	workspaceId: string,
	conferenceRecordName: string,
): Promise<string | null> {
	const rows = await db
		.select({ id: objects.id })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'event'),
				sql`${objects.metadata}->>'google_meet_conference_record_name' = ${conferenceRecordName}`,
			),
		)
		.limit(1)
	return rows[0]?.id ?? null
}

/**
 * Synthesise an event object for a Meet-only call so trigger 389b1d48 fires.
 * No-op (returns {eventId, action:'existing'}) when the meeting already has a
 * linked event object, or when we've synthesised one on a prior delivery.
 * Idempotent — safe for Pub/Sub replay of the same messageId.
 */
export async function synthesizeMeetOnlyEvent(
	db: Database,
	args: SynthesizeMeetOnlyEventArgs,
): Promise<SynthesizeMeetOnlyEventResult | null> {
	const {
		workspaceId,
		systemActorId,
		meetingId,
		meetingTitle,
		conferenceRecordName,
		participantsStructured,
		participantsText,
	} = args

	// Replay guard first — cheap read, keeps a Pub/Sub retry from double-firing 389b1d48.
	const existingByRecord = await findExistingSynthesizedEvent(db, workspaceId, conferenceRecordName)
	if (existingByRecord) {
		return { eventId: existingByRecord, action: 'existing' }
	}

	// Meet-only test: skip when a linked event object already exists in either
	// direction. Meet-hosted webinars linked to Meetup/Luma events are handled
	// by the platform-post lifecycle; we must not create a parallel event.
	if (await meetingHasLinkedEvent(db, workspaceId, meetingId)) {
		logger.info('Meet-only mapper: meeting has existing linked event, skipping synthesised event', {
			workspaceId,
			meetingId,
			conferenceRecordName,
		})
		return null
	}

	const title = meetingTitle && meetingTitle.trim().length > 0 ? meetingTitle : 'Google Meet call'
	const metadata = {
		google_meet_conference_record_name: conferenceRecordName,
		linked_meeting_id: meetingId,
		participants_structured: participantsStructured,
		participants: participantsText,
		source: 'google-meet-mapper',
		no_platform_listing: true,
	}

	// Step 1 — insert the object with initial status. `created` audit event is
	// deliberately NOT recorded: only the status transition below drives
	// trigger 389b1d48, and adding a 'created' row would burn a NOTIFY frame
	// for a state consumers never subscribe to.
	const [created] = await db
		.insert(objects)
		.values({
			workspaceId,
			type: 'event',
			title,
			status: INITIAL_EVENT_STATUS,
			metadata,
			createdBy: systemActorId,
		})
		.returning({ id: objects.id })
	if (!created) throw new Error('Meet-only mapper: object insert returned no row')
	const eventId = created.id

	// Step 2 — flip to the terminal status and emit the status_changed audit
	// row. Trigger runner reads current.status via getObjectContext() after the
	// NOTIFY fires, so both writes must land before the notification does — we
	// therefore UPDATE then INSERT rather than the reverse.
	await db
		.update(objects)
		.set({ status: TERMINAL_EVENT_STATUS, updatedAt: new Date() })
		.where(eq(objects.id, eventId))

	await db.insert(events).values({
		workspaceId,
		actorId: systemActorId,
		action: 'status_changed',
		entityType: 'event',
		entityId: eventId,
		data: {
			changes: [{ field: 'status', old: INITIAL_EVENT_STATUS, new: TERMINAL_EVENT_STATUS }],
		},
	})

	// Step 3 — record a relates_to edge (source=meeting, target=event) so the
	// graph reads correctly and downstream consumers can walk from the meeting
	// to its capture event.
	await db.insert(relationships).values({
		sourceType: 'object',
		sourceId: meetingId,
		targetType: 'object',
		targetId: eventId,
		type: 'relates_to',
		createdBy: systemActorId,
	})

	logger.info('Meet-only mapper: synthesised event for Capture attendees trigger', {
		workspaceId,
		meetingId,
		eventId,
		conferenceRecordName,
		participantCount: participantsStructured.length,
	})
	return { eventId, action: 'created' }
}
