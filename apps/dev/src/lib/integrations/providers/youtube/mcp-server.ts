import type { Database } from '@maskin/db'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { logger } from '../../../logger'
import { type YoutubeClientContext, youtubeRead } from './client'
import { isYoutubeError } from './errors'

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
 * has one place to live.
 */
function registerTool(
	server: McpServer,
	name: string,
	description: string,
	run: () => Promise<unknown>,
) {
	server.registerTool(
		name,
		{ description, inputSchema: {}, annotations: { readOnlyHint: true } },
		async () => {
			try {
				return jsonResult(await run())
			} catch (err) {
				return toolError(name, err)
			}
		},
	)
}

function registerTools(server: McpServer, ctx: YoutubeMcpContext): void {
	const client: YoutubeClientContext = ctx

	registerTool(
		server,
		'youtube__get_channel',
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
