import type { Database } from '@maskin/db'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { logger } from '../../../logger'
import { MeetToolError } from './errors'
import {
	getConferenceRecord,
	getTranscriptEntries,
	listConferenceRecords,
	listParticipants,
	listRecordings,
} from './read-operations'

export interface MeetMcpContext {
	db: Database
	workspaceId: string
	actorId?: string
}

/**
 * Google Meet MCP server. This file assembles the read-path tools this task
 * owns; Task 4 (write-path: create_space + create_meet_backed_event) merges
 * into the same file and calls its own registerWriteTools next to
 * `registerReadTools` here. Merge-conflict resolution is expected at
 * aggregate-review time — both slices are additive.
 */
export function createGoogleMeetMcpServer(ctx: MeetMcpContext): McpServer {
	const server = new McpServer(
		{ name: 'google-meet', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	)
	registerReadTools(server, ctx)
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
