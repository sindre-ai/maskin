import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { logger } from '../../../logger'
import {
	type CreateMeetSpaceInput,
	callCalendarEventsInsertWithMeet,
	callMeetSpacesCreate,
} from './api'
import { MeetToolError } from './errors'
import {
	defaultCalendarRequestId,
	defaultSpaceIdempotencyKey,
	lookupCachedSpace,
	recordSpaceIdempotency,
} from './idempotency'
import { resolveMeetToken } from './token'

/**
 * Google Meet — write-path MCP server (bet 947e · task 824f).
 *
 * Two tools:
 *   - `google_meet__create_meet_backed_event` — GCal `events.insert` with
 *     `conferenceDataVersion=1` + a `conferenceData.createRequest`. Native
 *     replay-safe via `requestId` (default: deterministic hash of
 *     `actor_id + summary + start.date_time`).
 *   - `google_meet__create_space` — Meet v2 `spaces.create` for pre-configured
 *     moderation. Meet accepts no client-side idempotency key, so dedup lives
 *     on a Maskin-side ledger (see idempotency.ts + migration 0070).
 *
 * Both tools return the normalised error envelope on failure — Google's raw
 * JSON never reaches the LLM.
 */

export interface MeetMcpContext {
	db: Database
	workspaceId: string
	/** The actor whose API key drove the MCP call. */
	actorId: string
}

function jsonResult(value: unknown, opts: { isError?: boolean } = {}) {
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(value) }],
		isError: opts.isError,
	}
}

function toErrorResult(err: unknown, ctx: MeetMcpContext, tool: string) {
	if (err instanceof MeetToolError) {
		logger.info('Meet MCP tool returned normalised error', {
			tool,
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
			code: err.code,
			providerStatus: err.providerStatus,
		})
		return jsonResult(err.toEnvelope(), { isError: true })
	}
	logger.error('Meet MCP tool crashed', {
		tool,
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		error: err instanceof Error ? err.message : String(err),
	})
	return jsonResult(
		{
			error: {
				code: 'PROVIDER_ERROR',
				message: err instanceof Error ? err.message : 'Unknown error',
				hint: 'Google Meet tool crashed unexpectedly — retry once, then surface to a human.',
			},
		},
		{ isError: true },
	)
}

// ── Tool schemas ─────────────────────────────────────────────────────────────

const timeShape = z.object({
	date_time: z
		.string()
		.min(1)
		.describe('ISO-8601 timestamp, e.g. 2026-09-11T15:00:00-07:00.'),
	time_zone: z
		.string()
		.min(1)
		.describe('IANA time zone name, e.g. America/Los_Angeles.'),
})

const createMeetBackedEventInput = {
	summary: z
		.string()
		.min(1)
		.describe('Calendar event title — becomes the Meet call\'s display title.'),
	start: timeShape.describe('Event start time.'),
	end: timeShape.describe('Event end time.'),
	attendees: z
		.array(
			z.object({
				email: z.string().email(),
				optional: z.boolean().optional(),
			}),
		)
		.optional()
		.describe('Attendees to invite.'),
	description: z.string().optional().describe('Free-text description on the calendar event.'),
	calendar_id: z
		.string()
		.optional()
		.describe(
			'Google Calendar id to insert on. Defaults to the resolved actor\'s `primary` calendar.',
		),
	actor_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			'Actor whose Google OAuth token creates the event. Defaults to the calling actor.',
		),
	meeting_object_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			'Linked Maskin meeting object id — its `metadata.google_meet_space_name` is set so Task 3\'s webhook can back-fill transcript / recording artefacts to the same object.',
		),
	request_id: z
		.string()
		.optional()
		.describe(
			'`conferenceData.createRequest.requestId` — the caller\'s idempotency key. Defaults to sha256(actor_id + summary + start.date_time) so retries within the same actor+summary+start replay the original event.',
		),
}

const meetSpaceConfigShape = z.object({
	access_type: z
		.enum(['OPEN', 'TRUSTED', 'RESTRICTED'])
		.optional()
		.describe('Who can join without knocking. Default (Google-side): TRUSTED.'),
	entry_point_access: z
		.enum(['ALL', 'CREATOR_APP_ONLY'])
		.optional()
		.describe('Whether the Meet URL is joinable from any client or only the creator app.'),
	moderation: z
		.enum(['ON', 'OFF'])
		.optional()
		.describe('Host-only mute / present / chat controls.'),
	moderation_restrictions: z
		.object({
			chat_restriction: z.enum(['HOSTS_ONLY', 'NO_RESTRICTION']).optional(),
			present_restriction: z.enum(['HOSTS_ONLY', 'NO_RESTRICTION']).optional(),
			default_join_as_viewer_type: z.enum(['ON', 'OFF']).optional(),
		})
		.optional(),
	recording: z
		.object({ auto_start: z.boolean().optional() })
		.optional()
		.describe(
			'Google requires a host in-call to actually trigger recording; auto_start only marks the space as recording-capable.',
		),
	transcription: z
		.object({ auto_start: z.boolean().optional() })
		.optional(),
	attendance_report: z
		.object({ generate: z.boolean().optional() })
		.optional(),
})

const createSpaceInput = {
	purpose: z
		.string()
		.min(1)
		.describe(
			'Free-text describing what the space is for — used to derive the default idempotency key so retries within the same day + actor + purpose dedupe automatically.',
		),
	actor_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			'Actor whose Google OAuth token creates the space. Defaults to the calling actor.',
		),
	idempotency_key: z
		.string()
		.optional()
		.describe(
			'Explicit idempotency key. Default: sha256(actor_id + purpose_normalised + YYYY-MM-DD). Same key on a subsequent call returns the cached space rather than provisioning a new one.',
		),
	config: meetSpaceConfigShape
		.optional()
		.describe('Pre-configured moderation / recording / transcription settings.'),
	attach_to_calendar_event_id: z
		.string()
		.optional()
		.describe(
			'Reserved for the follow-on `events.patch` path — not consumed at this task.',
		),
}

// ── Server assembly ─────────────────────────────────────────────────────────

export function createGoogleMeetMcpServer(ctx: MeetMcpContext): McpServer {
	const server = new McpServer({ name: 'maskin-google-meet', version: '0.1.0' })

	server.registerTool(
		'google_meet__create_meet_backed_event',
		{
			description:
				'Create a Google Calendar event backed by a fresh Google Meet space in a single call. Uses `conferenceData.createRequest` with `conferenceDataVersion=1` — the correct native path (closes bug ac295f51). Idempotent by `request_id`: retries with the same key return the original event + Meet URI, no duplicate space. Returns `{ event, meet_uri, meet_space_name }`; on failure returns a normalised error envelope with one of the codes listed in the task body.',
			inputSchema: createMeetBackedEventInput,
		},
		async (args) => {
			try {
				const token = await resolveMeetToken({
					db: ctx.db,
					workspaceId: ctx.workspaceId,
					callerActorId: ctx.actorId,
					explicitActorId: args.actor_id,
					meetingObjectId: args.meeting_object_id,
				})

				const requestId =
					args.request_id ??
					defaultCalendarRequestId(token.resolvedActorId, args.summary, args.start.date_time)

				const { event, meetUri, meetSpaceName } = await callCalendarEventsInsertWithMeet({
					accessToken: token.accessToken,
					calendarId: args.calendar_id,
					summary: args.summary,
					start: args.start,
					end: args.end,
					attendees: args.attendees,
					description: args.description,
					requestId,
					opContext:
						'Calendar rejected the Meet-backed event insert — verify the resolved actor owns the target calendar.',
				})

				if (args.meeting_object_id && meetSpaceName) {
					await setMeetingSpaceName(
						ctx.db,
						ctx.workspaceId,
						args.meeting_object_id,
						meetSpaceName,
					)
				}

				logger.info('google_meet__create_meet_backed_event succeeded', {
					workspaceId: ctx.workspaceId,
					actorId: ctx.actorId,
					resolvedActorId: token.resolvedActorId,
					eventId: event.id,
					meetSpaceName,
					meetingObjectId: args.meeting_object_id,
				})

				return jsonResult({
					event,
					meet_uri: meetUri,
					meet_space_name: meetSpaceName,
				})
			} catch (err) {
				return toErrorResult(err, ctx, 'google_meet__create_meet_backed_event')
			}
		},
	)

	server.registerTool(
		'google_meet__create_space',
		{
			description:
				'Provision a Google Meet space with pre-configured moderation / recording / transcription / attendance-report settings. Dedup is Maskin-side (Meet v2 accepts no client-side idempotency key): a second call with the same `idempotency_key` — or the default sha256(actor_id + purpose + UTC date) — returns the cached space rather than provisioning a new one. Returns `{ space_name, meeting_code, meeting_uri, config }`; on failure returns a normalised error envelope with one of the codes listed in the task body.',
			inputSchema: createSpaceInput,
		},
		async (args) => {
			try {
				const token = await resolveMeetToken({
					db: ctx.db,
					workspaceId: ctx.workspaceId,
					callerActorId: ctx.actorId,
					explicitActorId: args.actor_id,
				})

				const idempotencyKey =
					args.idempotency_key ??
					defaultSpaceIdempotencyKey(token.resolvedActorId, args.purpose)

				const cached = await lookupCachedSpace(ctx.db, ctx.workspaceId, idempotencyKey)
				if (cached) {
					logger.info('google_meet__create_space idempotency hit', {
						workspaceId: ctx.workspaceId,
						actorId: ctx.actorId,
						resolvedActorId: token.resolvedActorId,
						spaceName: cached.spaceName,
					})
					return jsonResult({
						space_name: cached.spaceName,
						meeting_code: extractMeetingCode(cached.spaceName),
						meeting_uri: `https://meet.google.com/${extractMeetingCode(cached.spaceName)}`,
						config: args.config ?? null,
						cached: true,
					})
				}

				const providerConfig = mapConfigForProvider(args.config)
				const created = await callMeetSpacesCreate({
					accessToken: token.accessToken,
					config: providerConfig,
					opContext:
						'Meet spaces.create failed — verify the resolved actor has meetings.space.created and is on a Workspace tier that permits API-provisioned spaces.',
				})

				const stored = await recordSpaceIdempotency({
					db: ctx.db,
					workspaceId: ctx.workspaceId,
					idempotencyKey,
					spaceName: created.name,
					actorId: token.resolvedActorId,
				})

				logger.info('google_meet__create_space succeeded', {
					workspaceId: ctx.workspaceId,
					actorId: ctx.actorId,
					resolvedActorId: token.resolvedActorId,
					spaceName: stored.spaceName,
					wonRace: stored.spaceName === created.name,
				})

				return jsonResult({
					space_name: stored.spaceName,
					meeting_code: created.meetingCode ?? extractMeetingCode(stored.spaceName),
					meeting_uri:
						created.meetingUri ??
						`https://meet.google.com/${created.meetingCode ?? extractMeetingCode(stored.spaceName)}`,
					config: created.config ?? providerConfig ?? null,
					cached: false,
				})
			} catch (err) {
				return toErrorResult(err, ctx, 'google_meet__create_space')
			}
		},
	)

	return server
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Write `metadata.google_meet_space_name` on the linked meeting object.
 * Uses jsonb_set so a concurrent Task-3 webhook writing sibling artefact
 * fields (transcript_document_id, recording_drive_file_id) is not clobbered.
 *
 * Best-effort: logged on failure but never fails the outer tool call — the
 * space is already provisioned upstream, and the webhook fallback can
 * back-fill this field on first artefact delivery.
 */
async function setMeetingSpaceName(
	db: Database,
	workspaceId: string,
	meetingObjectId: string,
	spaceName: string,
): Promise<void> {
	try {
		await db
			.update(objects)
			.set({
				metadata: sql`jsonb_set(
					COALESCE(${objects.metadata}, '{}'::jsonb),
					'{google_meet_space_name}',
					to_jsonb(${spaceName}::text),
					true
				)`,
				updatedAt: new Date(),
			})
			.where(and(eq(objects.id, meetingObjectId), eq(objects.workspaceId, workspaceId)))
	} catch (err) {
		logger.warn('Failed to set meeting.metadata.google_meet_space_name', {
			workspaceId,
			meetingObjectId,
			spaceName,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/** Extract the human-readable meeting code (e.g. `abc-defg-hij`) from a `spaces/xxx` resource path. */
function extractMeetingCode(spaceName: string): string {
	const slash = spaceName.lastIndexOf('/')
	return slash >= 0 ? spaceName.slice(slash + 1) : spaceName
}

/** Convert the snake-cased tool input to the camelCase shape Google's v2 API expects. */
function mapConfigForProvider(
	input: z.infer<typeof meetSpaceConfigShape> | undefined,
): CreateMeetSpaceInput['config'] {
	if (!input) return undefined
	const out: NonNullable<CreateMeetSpaceInput['config']> = {}
	if (input.access_type) out.accessType = input.access_type
	if (input.entry_point_access) out.entryPointAccess = input.entry_point_access
	if (input.moderation) out.moderation = input.moderation
	if (input.moderation_restrictions) {
		out.moderationRestrictions = {}
		const r = input.moderation_restrictions
		if (r.chat_restriction) out.moderationRestrictions.chatRestriction = r.chat_restriction
		if (r.present_restriction) out.moderationRestrictions.presentRestriction = r.present_restriction
		if (r.default_join_as_viewer_type)
			out.moderationRestrictions.defaultJoinAsViewerType = r.default_join_as_viewer_type
	}
	if (input.recording?.auto_start !== undefined) {
		out.artifactConfig = out.artifactConfig ?? {}
		out.artifactConfig.recordingConfig = {
			autoRecordingGeneration: input.recording.auto_start ? 'ON' : 'OFF',
		}
	}
	if (input.transcription?.auto_start !== undefined) {
		out.artifactConfig = out.artifactConfig ?? {}
		out.artifactConfig.transcriptionConfig = {
			autoTranscriptionGeneration: input.transcription.auto_start ? 'ON' : 'OFF',
		}
	}
	if (input.attendance_report?.generate !== undefined) {
		out.attendanceReportGenerationType = input.attendance_report.generate
			? 'GENERATE_REPORT'
			: 'DO_NOT_GENERATE'
	}
	return out
}
