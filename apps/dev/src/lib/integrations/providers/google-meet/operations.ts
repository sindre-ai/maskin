import type { Database } from '@maskin/db'
import { logger } from '../../../logger'
import type { CalendarEventResponse, CreateSpaceResponse, GoogleMeetClient } from './client'
import { createDefaultGoogleMeetClient } from './client'
import { MeetError, isMeetError } from './errors'
import {
	defaultEventRequestId,
	defaultIdempotencyKey,
	readIdempotency,
	recordIdempotency,
} from './idempotency'
import { getGoogleMeetAccessToken } from './token'

/**
 * Business logic for the two write-path MCP tools. Kept separate from the
 * MCP tool registration so unit tests can drive these directly (no zod
 * boilerplate, no MCP transport) and future non-MCP callers (a webhook
 * back-channel, a re-provisioning admin route) can reuse the same functions.
 */

export interface OperationsContext {
	db: Database
	workspaceId: string
	/** The MCP caller's actor — the last fallback in the token-resolution ladder. */
	callerActorId: string
	/** Optional injection point for tests. Defaults to the real fetch-backed client. */
	client?: GoogleMeetClient
}

export interface CreateSpaceInput {
	actor_id?: string
	purpose: string
	attach_to_calendar_event_id?: string
	access_type?: 'ACCESS_TYPE_UNSPECIFIED' | 'OPEN' | 'TRUSTED' | 'RESTRICTED'
	entry_point_access?: 'ENTRY_POINT_ACCESS_UNSPECIFIED' | 'ALL' | 'CREATOR_APP_ONLY'
	moderation?: 'MODERATION_UNSPECIFIED' | 'ON' | 'OFF'
	recording?: { auto_start?: boolean }
	transcription?: { auto_start?: boolean }
	attendance_report?: { generate?: boolean }
	idempotency_key?: string
}

export interface CreateSpaceOutput {
	space_name: string
	meeting_code: string
	meeting_uri: string
	config: unknown
	calendar_event_id?: string
	idempotent_replay: boolean
}

/**
 * `google_meet__create_space` implementation.
 *
 *   1. Resolve the acting actor (explicit `actor_id` → caller fallback).
 *      Meet is workspace-scoped so this doesn't change which row we read
 *      today, but keeps the ladder consistent with the read-path tools and
 *      ready for the day the bet flips to multi-host.
 *   2. Compute the idempotency key (caller-supplied OR
 *      sha256(actor_id + purpose_normalised + YYYY-MM-DD)).
 *   3. If a cached space already exists for (workspace, key) → replay it,
 *      skip Meet API entirely.
 *   4. Otherwise: fetch a Google access token, call Meet's spaces.create with
 *      the requested moderation config, record (workspace, key, space) in
 *      the ledger. On race, the loser reads back the winner's row.
 */
export async function createSpace(
	ctx: OperationsContext,
	input: CreateSpaceInput,
): Promise<CreateSpaceOutput> {
	const actorId = input.actor_id ?? ctx.callerActorId
	const idempotencyKey =
		input.idempotency_key ?? defaultIdempotencyKey({ actorId, purpose: input.purpose })

	const cached = await readIdempotency(ctx.db, {
		workspaceId: ctx.workspaceId,
		idempotencyKey,
	})
	if (cached) {
		logger.info('google_meet__create_space idempotent replay', {
			workspaceId: ctx.workspaceId,
			actorId,
			idempotencyKey,
			spaceName: cached.spaceName,
		})
		return {
			space_name: cached.spaceName,
			meeting_code: cached.meetingCode,
			meeting_uri: cached.meetingUri,
			// The stored ledger row does not carry the SpaceConfig back — an agent
			// replaying an existing space asked us to reuse it, not re-read
			// Google's current config. Callers that need live config call the
			// read-path tool from Task 3.
			config: null,
			idempotent_replay: true,
		}
	}

	const { accessToken } = await getGoogleMeetAccessToken(ctx.db, ctx.workspaceId, actorId)
	const client = ctx.client ?? createDefaultGoogleMeetClient()

	const body = buildCreateSpaceBody(input)
	let space: CreateSpaceResponse
	try {
		space = await client.createSpace(accessToken, body)
	} catch (err) {
		// classifyGoogleError already returned a MeetError; re-throw so the
		// tool layer surfaces the envelope. Anything else (e.g. a bug in the
		// client) escalates to a plain Error so the transport shows the
		// stack.
		throw err
	}

	// Race-safe record. If another concurrent caller landed the same
	// (workspace, key) between our read and here, they will win the insert
	// and we replay their row. Note: this DOES leave the space we just
	// created dangling in Meet — orphan spaces are cheap (no billing, no
	// notifications) so we accept the leak rather than call spaces.delete on
	// the loser's provisional space (which would race the winner's replay).
	const recorded = await recordIdempotency(ctx.db, {
		workspaceId: ctx.workspaceId,
		idempotencyKey,
		spaceName: space.name,
		meetingCode: space.meetingCode,
		meetingUri: space.meetingUri,
	})

	if (!recorded.inserted) {
		logger.warn(
			'google_meet__create_space lost idempotency race; replaying winner and leaking our provisional space',
			{
				workspaceId: ctx.workspaceId,
				actorId,
				idempotencyKey,
				ourSpaceName: space.name,
				winnerSpaceName: recorded.row.spaceName,
			},
		)
		return {
			space_name: recorded.row.spaceName,
			meeting_code: recorded.row.meetingCode,
			meeting_uri: recorded.row.meetingUri,
			config: null,
			idempotent_replay: true,
		}
	}

	logger.info('google_meet__create_space provisioned', {
		workspaceId: ctx.workspaceId,
		actorId,
		idempotencyKey,
		spaceName: space.name,
	})
	return {
		space_name: space.name,
		meeting_code: space.meetingCode,
		meeting_uri: space.meetingUri,
		config: space.config ?? null,
		idempotent_replay: false,
	}
}

function buildCreateSpaceBody(input: CreateSpaceInput): unknown {
	// Meet API v2 spaces.create takes a `Space` resource with a `config`
	// sub-object for moderation / access flags. Only include keys the caller
	// set — omitted fields fall through to Meet's defaults, which is what
	// the task's "if unset, use Meet defaults" contract asks for.
	const config: Record<string, unknown> = {}
	if (input.access_type) config.accessType = input.access_type
	if (input.entry_point_access) config.entryPointAccess = input.entry_point_access
	if (input.moderation) {
		config.moderation = input.moderation
	}
	if (input.recording?.auto_start !== undefined) {
		config.artifactConfig = {
			...(typeof config.artifactConfig === 'object' && config.artifactConfig
				? (config.artifactConfig as Record<string, unknown>)
				: {}),
			recordingConfig: {
				autoRecordingGeneration: input.recording.auto_start ? 'ON' : 'OFF',
			},
		}
	}
	if (input.transcription?.auto_start !== undefined) {
		config.artifactConfig = {
			...(typeof config.artifactConfig === 'object' && config.artifactConfig
				? (config.artifactConfig as Record<string, unknown>)
				: {}),
			transcriptionConfig: {
				autoTranscriptionGeneration: input.transcription.auto_start ? 'ON' : 'OFF',
			},
		}
	}
	if (input.attendance_report?.generate !== undefined) {
		config.attendanceReportGenerationType = input.attendance_report.generate
			? 'GENERATE_REPORT'
			: 'DO_NOT_GENERATE'
	}
	return Object.keys(config).length > 0 ? { config } : {}
}

// ── create_meet_backed_event ────────────────────────────────────────────────

export interface CreateMeetBackedEventInput {
	actor_id?: string
	calendar_id?: string
	summary: string
	start: { date_time: string; time_zone?: string }
	end: { date_time: string; time_zone?: string }
	attendees?: Array<{ email: string; optional?: boolean }>
	description?: string
	request_id?: string
	send_updates?: 'all' | 'externalOnly' | 'none'
	/**
	 * Optional Maskin meeting-object id. If present, the write-path tool
	 * writes back `metadata.google_meet_space_name` on it via
	 * `metadataWriter` so Task 3's webhook can back-fill artefacts to the
	 * same object when the call happens. Injected so this file has no
	 * hard dependency on the Maskin API client.
	 */
	linked_meeting_object_id?: string
}

export interface CreateMeetBackedEventOutput {
	event: CalendarEventResponse
	meet_uri: string
	meet_space_name: string
	request_id: string
	linked_meeting_object_id?: string
	linked_meeting_metadata_written: boolean
}

/**
 * Optional writeback hook. When the caller supplies `linked_meeting_object_id`,
 * we invoke this to set `metadata.google_meet_space_name` on the linked
 * meeting object so Task 3's webhook can join artefacts back. Split as an
 * injected function so this module stays free of a hard dependency on the
 * Maskin API client — the MCP route wires the real writer.
 */
export type MeetingMetadataWriter = (params: {
	db: Database
	workspaceId: string
	meetingObjectId: string
	spaceName: string
}) => Promise<void>

export interface CreateMeetBackedEventContext extends OperationsContext {
	metadataWriter?: MeetingMetadataWriter
}

export async function createMeetBackedEvent(
	ctx: CreateMeetBackedEventContext,
	input: CreateMeetBackedEventInput,
): Promise<CreateMeetBackedEventOutput> {
	const actorId = input.actor_id ?? ctx.callerActorId
	const requestId =
		input.request_id ??
		defaultEventRequestId({
			actorId,
			summary: input.summary,
			startDateTime: input.start.date_time,
		})

	const { accessToken } = await getGoogleMeetAccessToken(ctx.db, ctx.workspaceId, actorId)
	const client = ctx.client ?? createDefaultGoogleMeetClient()

	// Google's calendar.events.insert with conferenceData.createRequest.requestId
	// is the native replay-safe path — same requestId + same day = same event
	// + same Meet space. No Maskin ledger needed for this path (unlike
	// create_space, which has no native idempotency).
	const body = buildEventBody(input, requestId)
	const event = await client.insertCalendarEvent(accessToken, {
		calendarId: input.calendar_id ?? 'primary',
		sendUpdates: input.send_updates,
		body,
	})

	const meetUri = extractMeetUri(event)
	const meetSpaceName = extractMeetSpaceName(event)

	if (!meetUri || !meetSpaceName) {
		// GCal returned the event but no conferenceData — bug ac295f51 mode.
		// The tool's guarantee is that a Meet-backed event has both fields
		// populated; surfacing this as PROVIDER_ERROR (with a hint pointing at
		// the bug's cause) is the honest outcome instead of returning a
		// half-formed result the agent will retry against.
		throw new MeetError({
			code: 'PROVIDER_ERROR',
			message:
				'Google returned the calendar event but no Meet conference was attached. Verify the calendar account has Meet available and the actor has the meetings.space.created scope.',
			provider_status: 200,
			hint: 'This is the ac295f51 failure mode — the tool sets conferenceDataVersion=1 explicitly, so a missing hangoutLink usually means the calendar tier does not support Meet.',
		})
	}

	let metadataWritten = false
	if (input.linked_meeting_object_id && ctx.metadataWriter) {
		try {
			await ctx.metadataWriter({
				db: ctx.db,
				workspaceId: ctx.workspaceId,
				meetingObjectId: input.linked_meeting_object_id,
				spaceName: meetSpaceName,
			})
			metadataWritten = true
		} catch (err) {
			// The event is created either way — surface the writeback failure
			// as a logged warning, not a thrown error. Downstream agents can
			// still set the metadata by other means, and blowing up the tool
			// call would falsely tell the caller Meet provisioning failed.
			logger.warn('google_meet__create_meet_backed_event metadata writeback failed', {
				workspaceId: ctx.workspaceId,
				actorId,
				meetingObjectId: input.linked_meeting_object_id,
				meetSpaceName,
				error: isMeetError(err) ? err.message : String(err),
			})
		}
	}

	logger.info('google_meet__create_meet_backed_event provisioned', {
		workspaceId: ctx.workspaceId,
		actorId,
		requestId,
		eventId: event.id,
		meetSpaceName,
	})

	const output: CreateMeetBackedEventOutput = {
		event,
		meet_uri: meetUri,
		meet_space_name: meetSpaceName,
		request_id: requestId,
		linked_meeting_metadata_written: metadataWritten,
	}
	if (input.linked_meeting_object_id) output.linked_meeting_object_id = input.linked_meeting_object_id
	return output
}

function buildEventBody(input: CreateMeetBackedEventInput, requestId: string): unknown {
	const body: Record<string, unknown> = {
		summary: input.summary,
		start: startEndPayload(input.start),
		end: startEndPayload(input.end),
		conferenceData: {
			createRequest: {
				requestId,
				conferenceSolutionKey: { type: 'hangoutsMeet' },
			},
		},
	}
	if (input.description) body.description = input.description
	if (input.attendees && input.attendees.length > 0) {
		body.attendees = input.attendees.map((a) => ({
			email: a.email,
			...(a.optional !== undefined ? { optional: a.optional } : {}),
		}))
	}
	return body
}

function startEndPayload(dt: { date_time: string; time_zone?: string }): Record<string, unknown> {
	const out: Record<string, unknown> = { dateTime: dt.date_time }
	if (dt.time_zone) out.timeZone = dt.time_zone
	return out
}

function extractMeetUri(event: CalendarEventResponse): string | null {
	if (typeof event.hangoutLink === 'string' && event.hangoutLink.length > 0) return event.hangoutLink
	const ep = event.conferenceData?.entryPoints?.find(
		(e) => e.entryPointType === 'video' && typeof e.uri === 'string',
	)
	return ep?.uri ?? null
}

/**
 * Meet space name in the `spaces/{space_id}` form. Calendar responses carry
 * a `conferenceId` (short display id, e.g. `abc-defg-hij`), not the full
 * resource name. Convert to `spaces/{conferenceId}` so downstream callers
 * (Task 3's webhook fan-out, in particular) can key by the same shape
 * `spaces.create` returns.
 */
function extractMeetSpaceName(event: CalendarEventResponse): string | null {
	const conferenceId = event.conferenceData?.conferenceId
	if (typeof conferenceId === 'string' && conferenceId.length > 0) {
		return `spaces/${conferenceId}`
	}
	return null
}
