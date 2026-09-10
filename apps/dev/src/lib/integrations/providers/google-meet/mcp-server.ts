import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { logger } from '../../../logger'
import { isMeetError } from './errors'
import {
	type CreateMeetBackedEventInput,
	type CreateSpaceInput,
	type MeetingMetadataWriter,
	createMeetBackedEvent,
	createSpace,
} from './operations'

/**
 * In-process MCP server for the Google Meet write path, served over Streamable
 * HTTP at `/api/integrations/google-meet/mcp` (mounted in app-factory.ts).
 * Sibling of the LinkedIn / Slack MCP surfaces.
 *
 * Only exposes the two write-path tools shipped by task 824f1a6a:
 *   - `google_meet__create_space`
 *   - `google_meet__create_meet_backed_event`
 *
 * Task 3 (read path) adds `google_meet__list_conference_records`,
 * `google_meet__get_transcript_entries`, `google_meet__list_participants`,
 * `google_meet__list_recordings` alongside via a second `register*Tools`
 * call on the same server. Both write and read paths share the token
 * resolver in ./token.ts and the error taxonomy in ./errors.ts.
 */
export interface GoogleMeetMcpContext {
	db: Database
	workspaceId: string
	callerActorId: string
}

/**
 * Register the write-path tools on an existing MCP server. Split out from
 * `createGoogleMeetMcpServer` so Task 3 can share the same server instance
 * for its read-path tools without a duplicate route handler.
 */
export function registerGoogleMeetWriteTools(
	server: McpServer,
	ctx: GoogleMeetMcpContext,
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
		async (args) => runTool('google_meet__create_space', () =>
			createSpace(ctx, args as CreateSpaceInput),
		),
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
						"Optional Maskin meeting-object id. If set, the tool writes back metadata.google_meet_space_name so Task 3's webhook can back-fill artefacts to the same object.",
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
 * Uses jsonb_set so we don't clobber existing metadata keys — matches how
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

/**
 * Build the MCP server that the HTTP route uses. Kept as a factory (rather
 * than a module-level singleton) so per-request state — the caller's
 * workspace id + actor id — is bound at construction time and can't leak
 * across concurrent requests through a shared closure.
 */
export function createGoogleMeetMcpServer(ctx: GoogleMeetMcpContext): McpServer {
	const server = new McpServer({ name: 'maskin-google-meet', version: '0.1.0' })
	registerGoogleMeetWriteTools(server, ctx)
	return server
}
