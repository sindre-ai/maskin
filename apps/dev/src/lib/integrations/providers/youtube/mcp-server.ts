import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
	type YoutubeOutcome,
	type YoutubeToolName,
	trackYoutubeToolCalled,
} from '../../../analytics/youtube-events'
import { logger } from '../../../logger'
import { type YoutubeClientContext, youtubeRead } from './client'
import { YoutubeError, type YoutubeErrorCode, isYoutubeError } from './errors'

/**
 * In-process MCP server for the YouTube integration, served over Streamable HTTP at
 * /api/integrations/youtube/mcp (mounted in app-factory.ts). Same shape as the Google Meet
 * factory: built per request, so the caller's workspace id and actor id cannot leak across
 * concurrent requests through a shared closure.
 */
export interface YoutubeMcpContext {
	db: Database
	workspaceId: string
	actorId: string
	/** The Maskin session making the call (X-Maskin-Session-Id), for the tool-called event only. */
	sessionId?: string | null
}

const OUTCOME_BY_CODE: Partial<Record<YoutubeErrorCode, YoutubeOutcome>> = {
	QUOTA_EXHAUSTED: 'quota_blocked',
	WORKSPACE_QUOTA_EXHAUSTED: 'quota_blocked',
	NOT_CONNECTED: 'not_connected',
	RECONSENT_REQUIRED: 'not_connected',
}

/** A session a flow trigger started, as opposed to a person's chat. Best-effort: false on any failure. */
async function startedByTrigger(db: Database, sessionId: string | null | undefined) {
	if (!sessionId) return false
	try {
		const [row] = await db
			.select({ triggerId: sessions.triggerId })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		return Boolean(row?.triggerId)
	} catch {
		return false
	}
}

function jsonResult(payload: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

function toolError(tool: string, err: unknown) {
	if (isYoutubeError(err)) {
		logger.info('YouTube MCP tool returned a normalized error', { tool, code: err.code })
		return {
			isError: true as const,
			content: [{ type: 'text' as const, text: JSON.stringify({ error: err.toPayload() }) }],
		}
	}
	// Never put the raw error text in the result or the log: it can carry response content.
	logger.error('YouTube MCP tool unexpected error', { tool })
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

export function createYoutubeMcpServer(
	ctx: YoutubeMcpContext,
	/** Called before any tool is registered, e.g. to gate tools on the caller's access. */
	onServer?: (server: McpServer) => void,
): McpServer {
	const server = new McpServer(
		{ name: 'maskin-youtube', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	)
	onServer?.(server)
	registerTools(server, ctx)
	return server
}

/**
 * Every tool goes through this one wrapper, so anything that must happen on every youtube__ call
 * has one place to live. It emits one youtube_tool_called event per call, on a cache hit and on a
 * quota refusal too. The event never throws and carries a category, never an error string.
 */
function registerTool<Shape extends z.ZodRawShape>(
	server: McpServer,
	ctx: YoutubeMcpContext,
	name: YoutubeToolName,
	description: string,
	inputSchema: Shape,
	run: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<unknown>,
) {
	const toolName = `youtube__${name}`
	server.registerTool(
		toolName,
		{ description, inputSchema, annotations: { readOnlyHint: true } },
		async (args) => {
			let outcome: YoutubeOutcome = 'ok'
			let result: ReturnType<typeof jsonResult> | ReturnType<typeof toolError>
			try {
				result = jsonResult(await run(args))
			} catch (err) {
				outcome = (isYoutubeError(err) && OUTCOME_BY_CODE[err.code]) || 'upstream_error'
				result = toolError(toolName, err)
			}
			await trackYoutubeToolCalled({
				workspaceId: ctx.workspaceId,
				agentId: ctx.actorId,
				sessionId: ctx.sessionId ?? null,
				tool: name,
				outcome,
				viaLoop: await startedByTrigger(ctx.db, ctx.sessionId),
			})
			return result
		},
	)
}

const MAX_PAGE_SIZE = 50
const GET_CHANNEL_PARAMS = { part: 'snippet,statistics,contentDetails', mine: 'true' }

/**
 * The uploads playlist id comes from the channel's contentDetails, so the caller never supplies
 * it. The channel read uses the same tool name and arguments as get_channel, so it shares that
 * tool's cache entry: when the channel was read in the last 15 minutes this costs nothing.
 */
async function getUploadsPlaylistId(client: YoutubeClientContext): Promise<string> {
	const channels = await youtubeRead<{
		items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>
	}>(client, {
		tool: 'youtube__get_channel',
		path: 'channels',
		params: GET_CHANNEL_PARAMS,
		units: 1,
	})
	const uploads = channels.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
	if (!uploads) {
		throw new YoutubeError({
			code: 'PROVIDER_ERROR',
			message: 'The connected Google account has no YouTube channel with an uploads playlist.',
		})
	}
	return uploads
}

function registerTools(server: McpServer, ctx: YoutubeMcpContext): void {
	const client: YoutubeClientContext = ctx

	registerTool(
		server,
		ctx,
		'get_channel',
		'Get the connected YouTube channel: title, description, subscriber, view and video counts, and the id of its uploads playlist. Returns the channel as the YouTube Data API returns it. Costs 1 quota unit; repeat reads within 15 minutes are served from a cache at no cost. If the Google account owns several channels, the one chosen at connect time is returned.',
		{},
		() =>
			youtubeRead(client, {
				tool: 'youtube__get_channel',
				path: 'channels',
				params: GET_CHANNEL_PARAMS,
				units: 1,
			}),
	)

	registerTool(
		server,
		ctx,
		'list_recent_videos',
		'List the newest uploads of the connected YouTube channel, newest first, as playlist items as the YouTube Data API returns them (video id, title, publish time). Use the video ids with get_video_stats. Returns up to 50 items per page; when more exist the response carries nextPageToken, pass it back as page_token for the next page. Costs 1 quota unit, plus 1 more when the channel itself is not cached; repeat reads within 15 minutes are served from a cache at no cost.',
		{
			max_results: z
				.number()
				.int()
				.min(1)
				.max(MAX_PAGE_SIZE)
				.optional()
				.describe(`How many items to return, 1 to ${MAX_PAGE_SIZE}. Default ${MAX_PAGE_SIZE}.`),
			page_token: z
				.string()
				.optional()
				.describe('The nextPageToken from a previous response, to get the next page.'),
		},
		async ({ max_results, page_token }) => {
			const uploadsPlaylistId = await getUploadsPlaylistId(client)
			const params: Record<string, string> = {
				part: 'snippet,contentDetails',
				playlistId: uploadsPlaylistId,
				maxResults: String(max_results ?? MAX_PAGE_SIZE),
			}
			if (page_token) params.pageToken = page_token
			return youtubeRead(client, {
				tool: 'youtube__list_recent_videos',
				path: 'playlistItems',
				params,
				units: 1,
			})
		},
	)
}
