import type { Database } from '@maskin/db'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
	type McpSessionSource,
	argKeys,
	captureMcpToolCall,
} from '../../../analytics/mcp-tool-calls'
import { logger } from '../../../logger'
import { isDriveError } from './errors'
import type { DriveToolContext } from './operations'
import {
	LIST_FOLDER_DESCRIPTION,
	LIST_FOLDER_TOOL,
	type ListFolderInput,
	listFolder,
} from './tools/list-folder'
import {
	SEARCH_FILES_DESCRIPTION,
	SEARCH_FILES_TOOL,
	type SearchFilesInput,
	searchFiles,
} from './tools/search-files'

/**
 * In-process MCP server for the Google Drive integration, served over
 * Streamable HTTP at /api/integrations/google-drive/mcp (mounted in
 * app-factory.ts). Same shape as the Meet server: one factory call per request,
 * so the caller's workspace and actor are bound at construction and cannot leak
 * across concurrent requests.
 *
 * Adding a tool = one file under ./tools plus one registerTool entry below. This
 * task registers exactly two: search_files and list_folder.
 */
export interface DriveMcpContext {
	db: Database
	workspaceId: string
	actorId: string
	/** X-Maskin-Session-Id of the calling agent session, when the request carried one. */
	sessionId?: string
}

export function createGoogleDriveMcpServer(ctx: DriveMcpContext): McpServer {
	const server = new McpServer(
		{ name: 'maskin-google-drive', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	)
	const toolCtx: DriveToolContext = {
		db: ctx.db,
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
	}

	server.registerTool(
		SEARCH_FILES_TOOL,
		{
			description: SEARCH_FILES_DESCRIPTION,
			inputSchema: {
				query: z.string().describe('Drive query language, e.g. "fullText contains \'invoice\'".'),
				pageSize: z.number().int().min(1).optional().describe('Results per page, capped at 100.'),
				pageToken: z.string().optional().describe('nextPageToken from a previous call.'),
				orderBy: z
					.string()
					.optional()
					.describe("Drive orderBy, e.g. 'modifiedTime desc'. Passed through unchanged."),
				includeTrashed: z.boolean().optional().describe('Include trashed files. Default false.'),
			},
		},
		async (args) =>
			runTool(ctx, SEARCH_FILES_TOOL, args, () => searchFiles(toolCtx, args as SearchFilesInput)),
	)

	server.registerTool(
		LIST_FOLDER_TOOL,
		{
			description: LIST_FOLDER_DESCRIPTION,
			inputSchema: {
				folderId: z.string().min(1).describe('Drive folder id.'),
				recursive: z
					.boolean()
					.optional()
					.describe('Walk subfolders (max 5000 files or 5 levels). Default false.'),
				pageSize: z.number().int().min(1).optional().describe('Results per page, capped at 1000.'),
				pageToken: z.string().optional().describe('nextPageToken from a previous call.'),
			},
		},
		async (args) =>
			runTool(ctx, LIST_FOLDER_TOOL, args, () => listFolder(toolCtx, args as ListFolderInput)),
	)

	return server
}

type ToolResult = {
	content: Array<{ type: 'text'; text: string }>
	structuredContent?: Record<string, unknown>
	isError?: true
}

/**
 * Uniform wrapper: a resolved value becomes a JSON tool result, a DriveError
 * becomes an isError result carrying the normalized envelope, and every call
 * (either way) is recorded on the existing mcp_tool_call event. The trace keeps
 * that event's privacy contract: argument key names only, never values or
 * result content.
 */
async function runTool(
	ctx: DriveMcpContext,
	toolName: string,
	args: unknown,
	fn: () => Promise<unknown>,
): Promise<ToolResult> {
	const startedAt = Date.now()
	let result: ToolResult
	let errorClass: string | null = null
	try {
		const value = await fn()
		result = {
			content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
			structuredContent: value as Record<string, unknown>,
		}
	} catch (err) {
		if (isDriveError(err)) {
			logger.info('Google Drive MCP tool returned a normalized error', {
				toolName,
				code: err.code,
				providerStatus: err.providerStatus,
			})
			errorClass = err.code
			const envelope = { error: err.toEnvelope() }
			result = {
				isError: true,
				content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
				structuredContent: envelope,
			}
		} else {
			logger.error('Google Drive MCP tool unexpected error', {
				toolName,
				error: err instanceof Error ? err.message : String(err),
			})
			errorClass = 'unclassified'
			const envelope = {
				error: { code: 'PROVIDER_ERROR', message: 'Unexpected upstream error.' },
			}
			result = {
				isError: true,
				content: [{ type: 'text', text: JSON.stringify(envelope) }],
				structuredContent: envelope,
			}
		}
	}

	const sessionSource: McpSessionSource = ctx.sessionId ? 'maskin-session' : 'unknown'
	void captureMcpToolCall(ctx.workspaceId, {
		sessionId: ctx.sessionId ?? '',
		sessionSource,
		seq: null,
		toolName,
		argKeys: argKeys(args),
		ok: errorClass === null,
		errorClass,
		durationMs: Date.now() - startedAt,
		responseBytes: result.content[0]?.text.length ?? null,
		transport: 'http',
		agentActorId: ctx.actorId,
	})
	return result
}
