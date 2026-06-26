import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { capturePosthogEvent } from '../../../analytics/posthog'
import { logger } from '../../../logger'
import { GoogleCalendarError, createEvent, sendRsvp, updateEvent } from './write-tools'

export interface GoogleCalendarContext {
	/**
	 * Caller-resolved Google access token (already refreshed if needed via
	 * `TokenManager.getValidToken`). The MCP server does not refresh — token
	 * lifecycle is the route's responsibility.
	 */
	accessToken: string
	/** Workspace owning the integration — distinct id for PostHog + logs. */
	workspaceId: string
	/** Actor (agent) calling the tool — propagates into the PostHog event. */
	actorId: string
	/**
	 * Forwarded as Google's `events.insert?requestId=` on `create_event` so
	 * two MCP calls with the same `Idempotency-Key` HTTP header collapse to a
	 * single Google insert (AC-T7). Undefined when the agent didn't set the
	 * header — Google generates a fresh id and dedup is disabled.
	 */
	idempotencyKey?: string
	/**
	 * Email of the connected Google account. Used by `send_rsvp` as the
	 * attendee whose response we patch when the agent doesn't override.
	 */
	connectedEmail: string
}

const PROVIDER = 'google-calendar'

const createEventInput = {
	calendarId: z
		.string()
		.min(1)
		.describe(
			"Google calendar id to write to. Use `primary` for the connected user's main calendar.",
		),
	title: z.string().min(1).describe('Event title (summary).'),
	start: z
		.string()
		.min(1)
		.describe(
			'Event start. Pass an ISO datetime (`2026-07-04T09:00:00+02:00`) for timed events or a bare date (`2026-07-04`) for all-day events.',
		),
	end: z.string().min(1).describe('Event end, same format rules as `start`.'),
	attendees: z
		.array(z.string().email())
		.optional()
		.describe('Email addresses to invite. Omitted creates an event with only the organizer.'),
	description: z.string().optional().describe('Optional event body / agenda.'),
	location: z.string().optional().describe('Optional location string.'),
}

const updateEventInput = {
	calendarId: z.string().min(1).describe('Calendar id holding the event.'),
	eventId: z.string().min(1).describe('Google event id returned by `create_event` or a list call.'),
	changes: z
		.object({
			title: z.string().optional(),
			start: z.string().optional(),
			end: z.string().optional(),
			attendees: z.array(z.string().email()).optional(),
			description: z.string().optional(),
			location: z.string().optional(),
		})
		.refine((c) => Object.keys(c).length > 0, {
			message: 'changes must include at least one field to update',
		})
		.describe(
			'Partial patch — only the named fields are sent to Google; omitted fields are left as-is.',
		),
}

const sendRsvpInput = {
	calendarId: z.string().min(1).describe('Calendar id holding the event.'),
	eventId: z.string().min(1).describe('Google event id.'),
	response: z
		.enum(['accepted', 'tentative', 'declined'])
		.describe('RSVP response to set for the calling user.'),
	attendeeEmail: z
		.string()
		.email()
		.optional()
		.describe(
			'Email of the attendee whose response to set. Defaults to the connected Google account.',
		),
}

function emitInvocation(
	ctx: GoogleCalendarContext,
	toolName: string,
	outcome: 'success' | 'error',
	errorCode?: string,
) {
	void capturePosthogEvent('mcp_tool_invocation', ctx.workspaceId, {
		tool_provider: PROVIDER,
		tool_name: toolName,
		workspace_id: ctx.workspaceId,
		actor_id: ctx.actorId,
		outcome,
		error_code: errorCode ?? null,
	})
}

function toolError(toolName: string, ctx: GoogleCalendarContext, err: unknown) {
	if (err instanceof GoogleCalendarError) {
		logger.warn('Google Calendar write tool returned mapped error', {
			toolName,
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
			code: err.code,
			httpStatus: err.httpStatus,
		})
		emitInvocation(ctx, toolName, 'error', err.code)
		return {
			isError: true,
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify({ ok: false, code: err.code, message: err.message }),
				},
			],
		}
	}
	logger.error('Google Calendar write tool failed unexpectedly', {
		toolName,
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		error: String(err),
	})
	emitInvocation(ctx, toolName, 'error', 'INTERNAL_ERROR')
	return {
		isError: true,
		content: [
			{
				type: 'text' as const,
				text: JSON.stringify({
					ok: false,
					code: 'INTERNAL_ERROR',
					message: 'Unexpected error invoking Google Calendar.',
				}),
			},
		],
	}
}

/**
 * Build a fresh MCP server per request. The three write tools are registered
 * with the access token + workspace identity bound at construction time so a
 * connection cannot leak credentials between workspaces.
 */
export function createGoogleCalendarMcpServer(ctx: GoogleCalendarContext): McpServer {
	const server = new McpServer({ name: 'maskin-google-calendar', version: '0.1.0' })

	server.registerTool(
		'create_event',
		{
			description:
				'Create a new event on a Google calendar. Returns the new event id and a Google Calendar UI link. Pass an Idempotency-Key request header to make retries safe — Google dedupes server-side for 24h.',
			inputSchema: createEventInput,
		},
		async (args) => {
			try {
				const out = await createEvent(ctx.accessToken, args, ctx.idempotencyKey)
				logger.info('Google Calendar create_event succeeded', {
					workspaceId: ctx.workspaceId,
					actorId: ctx.actorId,
					calendarId: args.calendarId,
					eventId: out.eventId,
					idempotent: Boolean(ctx.idempotencyKey),
				})
				emitInvocation(ctx, 'create_event', 'success')
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								ok: true,
								eventId: out.eventId,
								htmlLink: out.htmlLink,
							}),
						},
					],
				}
			} catch (err) {
				return toolError('create_event', ctx, err)
			}
		},
	)

	server.registerTool(
		'update_event',
		{
			description:
				'Patch named fields on an existing Google Calendar event. Only the fields in `changes` are sent — omitted fields stay as-is on Google.',
			inputSchema: updateEventInput,
		},
		async (args) => {
			try {
				const out = await updateEvent(ctx.accessToken, args)
				logger.info('Google Calendar update_event succeeded', {
					workspaceId: ctx.workspaceId,
					actorId: ctx.actorId,
					calendarId: args.calendarId,
					eventId: out.eventId,
					fieldsChanged: Object.keys(args.changes),
				})
				emitInvocation(ctx, 'update_event', 'success')
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ ok: true, ...out }),
						},
					],
				}
			} catch (err) {
				return toolError('update_event', ctx, err)
			}
		},
	)

	server.registerTool(
		'send_rsvp',
		{
			description:
				"Set the calling user's RSVP response (accepted/tentative/declined) on a Google Calendar event the user is invited to.",
			inputSchema: sendRsvpInput,
		},
		async (args) => {
			try {
				const out = await sendRsvp(ctx.accessToken, {
					calendarId: args.calendarId,
					eventId: args.eventId,
					response: args.response,
					attendeeEmail: args.attendeeEmail ?? ctx.connectedEmail,
				})
				logger.info('Google Calendar send_rsvp succeeded', {
					workspaceId: ctx.workspaceId,
					actorId: ctx.actorId,
					calendarId: args.calendarId,
					eventId: args.eventId,
					response: args.response,
				})
				emitInvocation(ctx, 'send_rsvp', 'success')
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ ok: true, ...out }),
						},
					],
				}
			} catch (err) {
				return toolError('send_rsvp', ctx, err)
			}
		},
	)

	return server
}
