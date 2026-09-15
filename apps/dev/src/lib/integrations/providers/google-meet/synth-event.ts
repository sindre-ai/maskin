import type { Database } from '@maskin/db'
import { events, integrations, objects, relationships } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { IntegrationConfig } from '../../../types'

/**
 * Meet-only mapper flip.
 *
 * On artefact-complete for a Meet-only call (a meeting with no linked event
 * object — i.e. no Meetup/Luma listing wired via a relates_to / attends /
 * informs edge), synthesize a minimal `event` object at status `wrapped_up`
 * so the workspace's `event.status_changed → wrapped_up` consumer triggers
 * (**389b1d48** Capture attendees, **925ef751** Post-event follow-up) fire
 * the same way they do for a Meetup/Luma-listed event.
 *
 * Idempotent on `metadata.google_meet_conference_record_name`: replay of the
 * same Pub/Sub delivery produces no duplicate event object and no duplicate
 * status_changed emission. The mapper writes only for genuinely-Meet-only
 * calls — meetings already linked to an event object short-circuit silently.
 */

interface Participant {
	name?: string
	signedInUser?: { displayName?: string; user?: string }
	anonymousUser?: { displayName?: string }
	phoneUser?: { displayName?: string }
}

interface SynthesizeInput {
	workspaceId: string
	meetingId: string
	conferenceRecordName: string
	participants: Participant[]
	meetingTitle: string | null
	meetingStartTime?: string
}

interface SynthesizeResult {
	created: boolean
	eventId?: string
	reason?:
		| 'already_synthesized'
		| 'meeting_has_linked_event'
		| 'no_system_actor'
		| 'no_workspace_actor_fallback'
}

/**
 * Resolve the workspace's system actor (the actor that owns the google-meet
 * integration row). Every write below is scoped to that actor so `created_by`
 * / `actor_id` foreign keys resolve.
 */
async function resolveSystemActorId(
	db: Database,
	workspaceId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ config: integrations.config })
		.from(integrations)
		.where(
			and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'google-meet')),
		)
		.limit(1)
	const cfg = (row?.config as IntegrationConfig | null) ?? null
	const actorId = cfg?.system_actor_id
	return typeof actorId === 'string' && actorId.length > 0 ? actorId : null
}

/**
 * True if the meeting already has an edge to any `event` object — that's the
 * Meetup/Luma-listed case, and existing behaviour already fires 389b1d48 via
 * the linked event's own status transition. We must not synthesize another.
 */
async function meetingHasLinkedEvent(
	db: Database,
	meetingId: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: relationships.id })
		.from(relationships)
		.innerJoin(objects, eq(objects.id, relationships.targetId))
		.where(
			and(
				eq(relationships.sourceType, 'object'),
				eq(relationships.sourceId, meetingId),
				eq(relationships.targetType, 'object'),
				eq(objects.type, 'event'),
			),
		)
		.limit(1)
	return rows.length > 0
}

/**
 * Idempotency probe. If a synthesized event for this conferenceRecordName
 * already exists in the workspace, replay is a no-op.
 */
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

function participantDisplayName(p: Participant): string | null {
	return (
		p.signedInUser?.displayName ??
		p.anonymousUser?.displayName ??
		p.phoneUser?.displayName ??
		null
	)
}

function deriveEventTitle(meetingTitle: string | null, startedAt?: string): string {
	if (meetingTitle && meetingTitle.trim().length > 0) {
		return `${meetingTitle.trim()} (Meet call)`
	}
	if (startedAt) return `Meet call — ${startedAt}`
	return 'Meet call'
}

/**
 * Do it. Returns { created: true, eventId } on the happy path, or
 * { created: false, reason } on any short-circuit. Never throws — a mapper
 * failure must not abort the surrounding transcript write.
 */
export async function synthesizeMeetOnlyWrappedEvent(
	db: Database,
	input: SynthesizeInput,
): Promise<SynthesizeResult> {
	const { workspaceId, meetingId, conferenceRecordName, participants, meetingTitle, meetingStartTime } =
		input

	const existingId = await findExistingSynthesizedEvent(db, workspaceId, conferenceRecordName)
	if (existingId) {
		return { created: false, eventId: existingId, reason: 'already_synthesized' }
	}

	if (await meetingHasLinkedEvent(db, meetingId)) {
		return { created: false, reason: 'meeting_has_linked_event' }
	}

	const actorId = await resolveSystemActorId(db, workspaceId)
	if (!actorId) {
		logger.warn('Meet-only mapper flip skipped: no system_actor_id on google-meet integration', {
			workspaceId,
			meetingId,
			conferenceRecordName,
		})
		return { created: false, reason: 'no_system_actor' }
	}

	const attendeeCount = participants.length
	const displayNames = participants
		.map(participantDisplayName)
		.filter((n): n is string => typeof n === 'string' && n.length > 0)

	const eventMetadata = {
		google_meet_conference_record_name: conferenceRecordName,
		meet_synthesized: true,
		source: 'google_meet_mapper',
		attendee_count: attendeeCount,
		attendee_display_names: displayNames,
		linked_meeting_id: meetingId,
	}

	// Two-step insert so the emitted event carries a `status_changed`
	// transition (live → wrapped_up) that the workspace's `event.status_changed
	// → wrapped_up` triggers filter on. Consumer triggers look for status
	// transitions, not object creations — an insert directly at wrapped_up
	// would fire the `created` event, which 389b1d48 does NOT match.
	//
	// The status_changed event log row below matches the shape objects.ts's
	// PATCH handler writes (see routes/objects.ts: `data: { changes }`, where
	// each field carries `{ old, new }`). trigger-runner.ts resolves the
	// object via a hydrated `getObjectContext()` that reads `current` from
	// the objects table and reverse-patches `previous` from the diff — so
	// `to_status`/`filter.status` checks read `current.status = wrapped_up`.
	let createdEventId: string | undefined
	try {
		await db.transaction(async (tx) => {
			const [inserted] = await tx
				.insert(objects)
				.values({
					workspaceId,
					type: 'event',
					status: 'wrapped_up',
					title: deriveEventTitle(meetingTitle, meetingStartTime),
					metadata: eventMetadata,
					createdBy: actorId,
				})
				.returning({ id: objects.id })
			if (!inserted) throw new Error('event object insert returned no row')
			createdEventId = inserted.id

			await tx.insert(events).values({
				workspaceId,
				actorId,
				action: 'status_changed',
				entityType: 'event',
				entityId: inserted.id,
				data: {
					changes: {
						status: { old: 'live', new: 'wrapped_up' },
					},
					source: 'google_meet_mapper',
					synthesized: true,
					google_meet_conference_record_name: conferenceRecordName,
				},
			})

			await tx.insert(relationships).values({
				sourceType: 'object',
				sourceId: meetingId,
				targetType: 'object',
				targetId: inserted.id,
				type: 'relates_to',
				createdBy: actorId,
			})
		})
	} catch (err) {
		// Race with a sibling delivery that also fired the mapper: fall back to
		// the idempotency probe and return the winner without surfacing an error.
		const winner = await findExistingSynthesizedEvent(db, workspaceId, conferenceRecordName)
		if (winner) {
			return { created: false, eventId: winner, reason: 'already_synthesized' }
		}
		throw err
	}

	logger.info('Meet-only mapper flip synthesized wrapped_up event', {
		workspaceId,
		meetingId,
		conferenceRecordName,
		eventId: createdEventId,
		attendeeCount,
	})

	return { created: true, eventId: createdEventId }
}
