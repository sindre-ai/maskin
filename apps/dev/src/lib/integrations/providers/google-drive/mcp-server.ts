import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { McpClient } from '../../../analytics/mcp-client'
import {
	type McpSessionSource,
	argKeys,
	captureMcpToolCall,
} from '../../../analytics/mcp-tool-calls'
import { recordEvent } from '../../../events/record-event'
import { logger } from '../../../logger'
import { config as driveConfig } from './config'
import { DriveError, isDriveError } from './errors'
import type { DriveToolContext } from './operations'
import { getGoogleDriveAccessToken } from './token'
import {
	GET_DOCUMENT_STRUCTURED_DESCRIPTION,
	GET_DOCUMENT_STRUCTURED_TOOL,
	type GetDocumentStructuredInput,
	getDocumentStructured,
} from './tools/get-document-structured'
import {
	GET_FILE_BYTES_DESCRIPTION,
	GET_FILE_BYTES_TOOL,
	type GetFileBytesInput,
	getFileBytes,
} from './tools/get-file-bytes'
import {
	GET_SHEET_RANGE_DESCRIPTION,
	GET_SHEET_RANGE_TOOL,
	type GetSheetRangeInput,
	SHEET_PAGE_SIZE_MAX,
	getSheetRange,
} from './tools/get-sheet-range'
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
import {
	WATCH_FOLDER_DESCRIPTION,
	WATCH_FOLDER_TOOL,
	type WatchFolderInput,
	watchFolder,
} from './tools/watch-folder'
import { DRIVE_EVENT_TYPES } from './watch'
import { isDriveWriteError } from './write-errors'
import type { StorageSource } from './write-file'
import {
	COMMENT_DESCRIPTION,
	COMMENT_ON_DOCUMENT_TOOL,
	type CommentToolInput,
	WRITE_FILE_DESCRIPTION,
	WRITE_FILE_TOOL,
	type WriteFileToolInput,
	commentInputShape,
	driveCommentOnDocument,
	driveWriteFile,
	writeFileInputShape,
} from './write-tools'

/**
 * In-process MCP server for the Google Drive integration, served over
 * Streamable HTTP at /api/integrations/google-drive/mcp (mounted in
 * app-factory.ts). Same shape as the Meet server: one factory call per request,
 * so the caller's workspace and actor are bound at construction and cannot leak
 * across concurrent requests.
 *
 * Adding a tool = one file under ./tools plus one registerTool entry below.
 */
export interface DriveMcpContext {
	db: Database
	workspaceId: string
	actorId: string
	/** X-Maskin-Session-Id of the calling agent session, when the request carried one. */
	sessionId?: string
	/** MCP client family from the User-Agent, for the tool-call trace. Absent = other. */
	client?: McpClient
	/** Whether the caller is a person or an agent, for the tool-call trace. Absent = unresolved. */
	actorType?: 'human' | 'agent' | null
	/** Where get_file_bytes streams downloads and write_file reads storageUrl sources. Absent = those paths answer with a clean error. */
	storage?: StorageProvider
}

export function createGoogleDriveMcpServer(
	ctx: DriveMcpContext,
	/** Called before any tool is registered, e.g. to gate tools on the caller's access. */
	onServer?: (server: McpServer) => void,
): McpServer {
	const server = new McpServer(
		{ name: 'maskin-google-drive', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	)
	onServer?.(server)
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

	server.registerTool(
		GET_FILE_BYTES_TOOL,
		{
			description: GET_FILE_BYTES_DESCRIPTION,
			inputSchema: {
				fileId: z.string().min(1).describe('Drive file id.'),
				exportMimeType: z
					.string()
					.optional()
					.describe(
						'Export type for Google-native files (Docs, Sheets, Slides). Ignored for binary files.',
					),
			},
		},
		async (args) =>
			runTool(ctx, GET_FILE_BYTES_TOOL, args, () =>
				getFileBytes({ ...toolCtx, storage: ctx.storage }, args as GetFileBytesInput),
			),
	)

	server.registerTool(
		WATCH_FOLDER_TOOL,
		{
			description: WATCH_FOLDER_DESCRIPTION,
			inputSchema: {
				folderId: z.string().min(1).describe('Drive folder id to watch.'),
				eventTypes: z
					.array(z.enum(DRIVE_EVENT_TYPES))
					.optional()
					.describe('Which actions fire: created, updated, deleted, trashed. Default all four.'),
			},
		},
		async (args) =>
			runTool(ctx, WATCH_FOLDER_TOOL, args, () => watchFolder(toolCtx, args as WatchFolderInput)),
	)

	server.registerTool(
		GET_DOCUMENT_STRUCTURED_TOOL,
		{
			description: GET_DOCUMENT_STRUCTURED_DESCRIPTION,
			inputSchema: {
				documentId: z.string().min(1).describe('Google Doc id.'),
				startIndex: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe('Start of the range to read, in UTF-16 code units. Default: the start.'),
				endIndex: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe('End of the range to read, in UTF-16 code units. Default: the end.'),
			},
		},
		async (args) =>
			runTool(ctx, GET_DOCUMENT_STRUCTURED_TOOL, args, () =>
				getDocumentStructured(toolCtx, args as GetDocumentStructuredInput),
			),
	)

	server.registerTool(
		GET_SHEET_RANGE_TOOL,
		{
			description: GET_SHEET_RANGE_DESCRIPTION,
			inputSchema: {
				spreadsheetId: z.string().min(1).describe('Google Sheet id.'),
				range: z.string().min(1).describe('A1 notation, e.g. "Sheet1!A1:D500" or "Sheet1".'),
				pageSize: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe(`Sheet rows per page. Default 1000, capped at ${SHEET_PAGE_SIZE_MAX}.`),
				pageToken: z.string().optional().describe('nextPageToken from a previous call.'),
				majorDimension: z
					.enum(['ROWS', 'COLUMNS'])
					.optional()
					.describe('ROWS (default) or COLUMNS.'),
			},
		},
		async (args) =>
			runTool(ctx, GET_SHEET_RANGE_TOOL, args, () =>
				getSheetRange(toolCtx, args as GetSheetRangeInput),
			),
	)

	const writeCtx = {
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		getAccessToken: async () =>
			(await getGoogleDriveAccessToken(ctx.db, ctx.workspaceId, ctx.actorId)).accessToken,
		openStorageObject: ctx.storage && openStorageSource(ctx.storage),
	}

	server.registerTool(
		WRITE_FILE_TOOL,
		{ description: WRITE_FILE_DESCRIPTION, inputSchema: writeFileInputShape },
		async (args) =>
			runTool(ctx, WRITE_FILE_TOOL, args, () =>
				driveWriteFile(writeCtx, args as WriteFileToolInput),
			),
	)

	server.registerTool(
		COMMENT_ON_DOCUMENT_TOOL,
		{ description: COMMENT_DESCRIPTION, inputSchema: commentInputShape },
		async (args) =>
			runTool(ctx, COMMENT_ON_DOCUMENT_TOOL, args, () =>
				driveCommentOnDocument(writeCtx, args as CommentToolInput),
			),
	)

	return server
}

/**
 * StorageProvider has no streaming read yet (get returns the whole Buffer; the
 * sibling file-bytes task added a streaming write only), so a storageUrl source
 * is held in memory for the length of the upload. Swap this for a stream once
 * StorageProvider grows one.
 */
function openStorageSource(storage: StorageProvider) {
	return async (key: string): Promise<StorageSource> => {
		const bytes = await storage.get(key)
		return {
			stream: (async function* () {
				yield bytes
			})(),
			size: bytes.length,
		}
	}
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
	} catch (thrown) {
		const err = fromWriteError(thrown)
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
		// The route sits behind authMiddleware, so the caller always resolved by API key.
		authMethod: 'api_key',
		client: ctx.client ?? 'other',
		actorType: ctx.actorType ?? null,
	})
	if (errorClass === null) void stampFirstToolCall(ctx)
	return result
}

/** The write tools keep their own error class; agents see one envelope vocabulary. */
function fromWriteError(err: unknown): unknown {
	if (!isDriveWriteError(err)) return err
	return new DriveError({
		code: err.code,
		message: err.message,
		provider_status: err.providerStatus,
		retry_after_ms: err.retryAfterMs,
		hint: err.hint,
	})
}

/**
 * Record the first successful Drive tool call on the integration row as
 * config.first_tool_call_at (ISO timestamp). The customer UI derives its
 * has-ingested state from this key and nothing else. The WHERE clause makes the
 * write set-only-if-unset, so a second successful call never moves it, and the
 * caller only invokes this for errorClass null. Drive is one row per workspace
 * at v1 (workspace-scoped, actor_id NULL), so the workspace id picks the row;
 * revisit the key if per-human Drive rows ever ship.
 *
 * Fire and forget: a failure is logged and never fails the tool call.
 */
async function stampFirstToolCall(ctx: DriveMcpContext): Promise<void> {
	try {
		const stampedAt = new Date().toISOString()
		const rows = await ctx.db
			.update(integrations)
			.set({
				config: sql`jsonb_set(COALESCE(${integrations.config}, '{}'::jsonb), '{first_tool_call_at}', to_jsonb(${stampedAt}::text), true)`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(integrations.workspaceId, ctx.workspaceId),
					eq(integrations.provider, driveConfig.name),
					eq(integrations.status, 'active'),
					isNull(integrations.actorId),
					sql`NOT (COALESCE(${integrations.config}, '{}'::jsonb) ? 'first_tool_call_at')`,
				),
			)
			.returning({ id: integrations.id })
		const row = rows[0]
		if (!row) return
		await recordEvent(ctx.db, {
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
			action: 'updated',
			entityType: 'integration',
			entityId: row.id,
			data: { provider: driveConfig.name, first_tool_call_at: stampedAt },
		})
	} catch (err) {
		logger.warn('Google Drive first_tool_call_at stamp failed', {
			workspaceId: ctx.workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
