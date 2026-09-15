import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { logger } from '../../../logger'
import { MeetToolError, isMeetError } from './errors'
import {
	type CreateMeetBackedEventInput,
	type CreateSpaceInput,
	type MeetingMetadataWriter,
	type OperationsContext,
	createMeetBackedEvent,
	createSpace,
} from './operations'
import {
	getConferenceRecord,
	getTranscriptEntries,
	listConferenceRecords,
	listParticipants,
	listRecordings,
} from './read-operations'

/**
 * In-process MCP server for the Google Meet integration, served over Streamable
 * HTTP at `/api/integrations/google-meet/mcp` (mounted in app-factory.ts).
 * Sibling of the LinkedIn / Slack MCP surfaces — hence the `maskin-google-meet`
 * server name, matching `maskin-linkedin` / `maskin-slack`.
 *
 * Two slices landed on this file in parallel on the bet and both are kept:
 *
 *  - read path (Task 3) — `registerReadTools`, five `google_meet__*` read tools
 *    (list/get conference records, list participants, transcript entries,
 *    list recordings).
 *  - write path (Task 4) — `registerGoogleMeetWriteTools`, two tools
 *    (`google_meet__create_space`, `google_meet__create_meet_backed_event`).
 *
 * Both are additive and share the token resolver in ./token.ts (write) /
 * ./read-operations.ts (read) and the error taxonomy in ./errors.ts. The
 * factory registers both on one server instance.
 *
 * Context: the two slices declared separate context interfaces
 * (`MeetMcpContext` with an optional `actorId`; `GoogleMeetMcpContext` with a
 * required `callerActorId`). They are unified here on `MeetMcpContext` — the
 * shape the HTTP route already passes — and the write-path register call
 * adapts `actorId` → `callerActorId`. The operation modules each declare their
 * own local context interface, so neither needed a change.
 */
export interface MeetMcpContext {
	db: Database
	workspaceId: string
	/**
	 * MCP caller's actor id. Optional for the read tools (they fall through to
	 * the workspace's single google-meet row when absent); required in practice
	 * because the write tools resolve the caller's Meet token from it and the
	 * route always supplies it.
	 */
	actorId?: string
}

/**
 * Build the MCP server that the HTTP route uses. Kept as a factory (rather
 * than a module-level singleton) so per-request state — the caller's
 * workspace id + actor id — is bound at construction time and can't leak
 * across concurrent requests through a shared closure.
 */
export function createGoogleMeetMcpServer(ctx: MeetMcpContext): McpServer {
	const server = new McpServer(
		{ name: 'maskin-google-meet', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	)
	registerReadTools(server, ctx)
	registerGoogleMeetWriteTools(server, {
		db: ctx.db,
		workspaceId: ctx.workspaceId,
		callerActorId: ctx.actorId ?? '',
	})
	return server
}

function jsonResult(payload: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

function toolError(operation: string, err: unknown) {
	if (err instanceof MeetToolError) {
		logger.info('Google Meet MCP tool returned a normalized error', {
			operation,
			code: err.envelope.error.code,
		})
		return {
			isError: true as const,
			content: [{ type: 'text' as const, text: JSON.stringify(err.envelope) }],
		}
	}
	logger.error('Google Meet MCP tool unexpected error', {
		operation,
		error: err instanceof Error ? err.message : String(err),
	})
	return {
		isError: true as const,
		content: [
			{
				type: 'text' as const,
				text: JSON.stringify({
					error: { code: 'PROVIDER_ERROR', message: 'Unexpected upstream error.' },
				}),
			},
		],
	}
}

/**
 * Register the five read-path tools on `server`. Idempotent per (server, ctx):
 * calling twice would re-register the same tool name on the same server and
 * the MCP SDK would throw; the /mcp route builds a fresh server per request,
 * so this idempotency is implicit at the caller layer.
 */
export function registerReadTools(server: McpServer, ctx: MeetMcpContext): void {
	server.registerTool(
		'google_meet__list_conference_records',
		{
			description:
				'List Google Meet conference records visible to the connected host account. Optional filters: space_name (limit to a single Meet space), start_time_after (ISO-8601 timestamp; only records ending after this time).',
			inputSchema: {
				space_name: z
					.string()
					.optional()
					.describe('Restrict to a single Meet space, e.g. "spaces/AAAA".'),
				start_time_after: z
					.string()
					.optional()
					.describe('ISO-8601 timestamp — only records that ended after this time.'),
				page_size: z.number().int().min(1).max(100).optional(),
			},
		},
		async (input) => {
			try {
				return jsonResult(await listConferenceRecords(ctx, input))
			} catch (err) {
				return toolError('google_meet__list_conference_records', err)
			}
		},
	)

	server.registerTool(
		'google_meet__get_conference_record',
		{
			description:
				'Get a single Meet conference record by its resource name (e.g. "conferenceRecords/xyz").',
			inputSchema: {
				conference_record_name: z
					.string()
					.min(1)
					.describe('Full resource name — "conferenceRecords/<id>".'),
			},
		},
		async (input) => {
			try {
				return jsonResult(await getConferenceRecord(ctx, input))
			} catch (err) {
				return toolError('google_meet__get_conference_record', err)
			}
		},
	)

	server.registerTool(
		'google_meet__list_participants',
		{
			description:
				'List participants and their sessions on a conference record. Attendees are Google People IDs — external attendees may only resolve to display_name.',
			inputSchema: {
				conference_record_name: z.string().min(1),
				page_size: z.number().int().min(1).max(100).optional(),
			},
		},
		async (input) => {
			try {
				return jsonResult(await listParticipants(ctx, input))
			} catch (err) {
				return toolError('google_meet__list_participants', err)
			}
		},
	)

	server.registerTool(
		'google_meet__get_transcript_entries',
		{
			description:
				'Fetch the transcript entries for a conference record. Entries are walked to completion and returned flat in speaking order. Surfaces ARTEFACT_PENDING when the transcript is not ready yet.',
			inputSchema: {
				conference_record_name: z.string().min(1),
				page_size: z.number().int().min(1).max(100).optional(),
			},
		},
		async (input) => {
			try {
				return jsonResult(await getTranscriptEntries(ctx, input))
			} catch (err) {
				return toolError('google_meet__get_transcript_entries', err)
			}
		},
	)

	server.registerTool(
		'google_meet__list_recordings',
		{
			description:
				'List recordings on a conference record. Returns drive_destination.file (Drive file id) — consume via the Drive MCP.',
			inputSchema: {
				conference_record_name: z.string().min(1),
			},
		},
		async (input) => {
			try {
				return jsonResult(await listRecordings(ctx, input))
			} catch (err) {
				return toolError('google_meet__list_recordings', err)
			}
		},
	)
}

/**
 * Register the write-path tools on an existing MCP server. Split out from
 * `createGoogleMeetMcpServer` so the read path can share the same server
 * instance for its read-path tools without a duplicate route handler.
 */
export function registerGoogleMeetWriteTools(
	server: McpServer,
	ctx: OperationsContext,
): void {
	// Zod input shape for `google_meet__create_space`. Field names match the
	// spec on task 824f1a6a exactly; the tool description quotes the same
	// wording so an agent reading tools/list gets the acceptance-criteria
	// language verbatim.
	server.registerTool(
		'google_meet__create_space',
		{
			description:
				'Provision a Google Meet space with optional pre-configured moderation. Idempotent by (workspace, idempotency_key): default key is sha256(actor_id + purpose_normalised + YYYY-MM-DD), so a same-day retry with the same actor + purpose returns the same space.',
			inputSchema: {
				actor_id: z
					.string()
					.uuid()
					.optional()
					.describe('Actor whose Google Meet token creates the space. Defaults to the caller.'),
				purpose: z
					.string()
					.min(1)
					.max(500)
					.describe(
						'Free-text purpose ("Sebk demo w/ Acme"). Used to derive the default idempotency key.',
					),
				attach_to_calendar_event_id: z
					.string()
					.optional()
					.describe(
						'Reserved for the future GCal patch path — write-path v1 does not attach post-hoc; use create_meet_backed_event for the create+attach flow.',
					),
				access_type: z
					.enum(['ACCESS_TYPE_UNSPECIFIED', 'OPEN', 'TRUSTED', 'RESTRICTED'])
					.optional()
					.describe('Meet spaces.config.accessType.'),
				entry_point_access: z
					.enum(['ENTRY_POINT_ACCESS_UNSPECIFIED', 'ALL', 'CREATOR_APP_ONLY'])
					.optional()
					.describe('Meet spaces.config.entryPointAccess.'),
				moderation: z
					.enum(['MODERATION_UNSPECIFIED', 'ON', 'OFF'])
					.optional()
					.describe('Meet spaces.config.moderation.'),
				recording: z
					.object({ auto_start: z.boolean().optional() })
					.optional()
					.describe('artifactConfig.recordingConfig.autoRecordingGeneration.'),
				transcription: z
					.object({ auto_start: z.boolean().optional() })
					.optional()
					.describe('artifactConfig.transcriptionConfig.autoTranscriptionGeneration.'),
				attendance_report: z
					.object({ generate: z.boolean().optional() })
					.optional()
					.describe('attendanceReportGenerationType — GENERATE_REPORT vs DO_NOT_GENERATE.'),
				idempotency_key: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Override the default (actor + purpose + day) idempotency key. Same key returns the same cached space.',
					),
			},
		},
		async (args) =>
			runTool('google_meet__create_space', () => createSpace(ctx, args as CreateSpaceInput)),
	)

	server.registerTool(
		'google_meet__create_meet_backed_event',
		{
			description:
				'Create a Google Calendar event with a Meet space attached. Idempotent by conferenceData.createRequest.requestId (default: sha256(actor_id + summary + start.date_time)); GCal treats identical requestIds as a replay, so the same actor+summary+start on retry returns the same event and space.',
			inputSchema: {
				actor_id: z
					.string()
					.uuid()
					.optional()
					.describe('Actor whose Calendar hosts the event. Defaults to the caller.'),
				calendar_id: z
					.string()
					.optional()
					.describe("Calendar id to insert into. Defaults to the actor's primary calendar."),
				summary: z.string().min(1).max(1024).describe('Event summary (title).'),
				start: z
					.object({
						date_time: z
							.string()
							.min(1)
							.describe('RFC3339 datetime, e.g. "2026-09-15T15:00:00+02:00".'),
						time_zone: z
							.string()
							.optional()
							.describe('IANA time zone, e.g. "Europe/Copenhagen".'),
					})
					.describe('Event start.'),
				end: z
					.object({
						date_time: z.string().min(1).describe('RFC3339 datetime.'),
						time_zone: z.string().optional(),
					})
					.describe('Event end.'),
				attendees: z
					.array(
						z.object({
							email: z.string().email(),
							optional: z.boolean().optional(),
						}),
					)
					.optional()
					.describe('Invitees. Email is the only required field.'),
				description: z.string().optional(),
				request_id: z
					.string()
					.min(1)
					.max(1024)
					.optional()
					.describe(
						'Override the default deterministic requestId. Same value on retry returns the same event.',
					),
				send_updates: z
					.enum(['all', 'externalOnly', 'none'])
					.optional()
					.describe('GCal sendUpdates parameter — controls invitation emails.'),
				linked_meeting_object_id: z
					.string()
					.uuid()
					.optional()
					.describe(
						"Optional Maskin meeting-object id. If set, the tool writes back metadata.google_meet_space_name so the webhook can back-fill artefacts to the same object.",
					),
			},
		},
		async (args) =>
			runTool('google_meet__create_meet_backed_event', () =>
				createMeetBackedEvent(
					{ ...ctx, metadataWriter: defaultMeetingMetadataWriter },
					args as CreateMeetBackedEventInput,
				),
			),
	)
}

/**
 * Standard writeback: `metadata.google_meet_space_name = <spaces/xyz>` on
 * a meeting object in the caller's workspace. Silently skips if the row
 * doesn't exist or the workspace doesn't own it — the tool logs it as a
 * warning via the operations layer, and the calendar event is still valid.
 *
 * Uses a spread-merge so we don't clobber existing metadata keys — matches how
 * the other providers (Gmail, Skjald) mutate their linked-object metadata.
 */
const defaultMeetingMetadataWriter: MeetingMetadataWriter = async ({
	db,
	workspaceId,
	meetingObjectId,
	spaceName,
}) => {
	const [existing] = await db
		.select({ id: objects.id, metadata: objects.metadata, workspaceId: objects.workspaceId })
		.from(objects)
		.where(eq(objects.id, meetingObjectId))
		.limit(1)
	if (!existing) {
		throw new Error(`meeting object ${meetingObjectId} not found`)
	}
	if (existing.workspaceId !== workspaceId) {
		throw new Error(
			`meeting object ${meetingObjectId} does not belong to workspace ${workspaceId}`,
		)
	}
	const nextMetadata = {
		...((existing.metadata as Record<string, unknown> | null) ?? {}),
		google_meet_space_name: spaceName,
	}
	await db
		.update(objects)
		.set({ metadata: nextMetadata, updatedAt: new Date() })
		.where(eq(objects.id, meetingObjectId))
}

/**
 * Uniform tool wrapper — converts a resolved value into a JSON MCP result,
 * and a thrown MeetError into an `isError` tool result whose text carries the
 * normalised envelope. Non-MeetError throws propagate (MCP transport surfaces
 * the stack).
 */
async function runTool(
	toolName: string,
	fn: () => Promise<unknown>,
): Promise<{
	content: Array<{ type: 'text'; text: string }>
	structuredContent?: Record<string, unknown>
	isError?: true
}> {
	try {
		const result = await fn()
		return {
			content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
			structuredContent: result as Record<string, unknown>,
		}
	} catch (err) {
		if (isMeetError(err)) {
			logger.warn(`${toolName} returned a MeetError`, {
				code: err.code,
				providerStatus: err.providerStatus,
				message: err.message,
			})
			const envelope = { error: err.toEnvelope() }
			return {
				isError: true,
				content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
				structuredContent: envelope,
			}
		}
		throw err
	}
}
