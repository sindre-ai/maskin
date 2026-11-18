import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import {
	type YoutubeOutcome,
	type YoutubeToolName,
	trackYoutubeToolCalled,
} from '../../../analytics/youtube-events'
import { logger } from '../../../logger'
import { type YoutubeClientContext, youtubeRead } from './client'
import { type YoutubeErrorCode, isYoutubeError } from './errors'

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
function registerTool(
	server: McpServer,
	ctx: YoutubeMcpContext,
	name: YoutubeToolName,
	description: string,
	run: () => Promise<unknown>,
) {
	const toolName = `youtube__${name}`
	server.registerTool(
		toolName,
		{ description, inputSchema: {}, annotations: { readOnlyHint: true } },
		async () => {
			let outcome: YoutubeOutcome = 'ok'
			let result: ReturnType<typeof jsonResult> | ReturnType<typeof toolError>
			try {
				result = jsonResult(await run())
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

function registerTools(server: McpServer, ctx: YoutubeMcpContext): void {
	const client: YoutubeClientContext = ctx

	registerTool(
		server,
		ctx,
		'get_channel',
		'Get the connected YouTube channel: title, description, subscriber, view and video counts, and the id of its uploads playlist. Returns the channel as the YouTube Data API returns it. Costs 1 quota unit; repeat reads within 15 minutes are served from a cache at no cost. If the Google account owns several channels, the one chosen at connect time is returned.',
		() =>
			youtubeRead(client, {
				tool: 'youtube__get_channel',
				path: 'channels',
				params: { part: 'snippet,statistics,contentDetails', mine: 'true' },
				units: 1,
			}),
	)
}
