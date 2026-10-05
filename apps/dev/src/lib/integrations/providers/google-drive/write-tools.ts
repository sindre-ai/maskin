import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
	trackDriveCommentCreated,
	trackDriveFileWritten,
} from '../../../analytics/drive-write-events'
import { logger } from '../../../logger'
import { commentOnDocument } from './comment'
import { GOOGLE_DOC_MIME, GOOGLE_SHEET_MIME } from './doc-body'
import { DriveWriteError } from './write-errors'
import { type StorageSource, writeFile } from './write-file'
import { type DriveHttp, createDriveHttp } from './write-http'

export interface DriveWriteToolsContext {
	workspaceId: string
	actorId: string
	/** Returns a valid (refreshed if needed) Drive access token for this workspace. */
	getAccessToken: () => Promise<string>
	openStorageObject?: (key: string) => Promise<StorageSource>
	/** Test seams. */
	fetchImpl?: typeof fetch
	sleep?: (ms: number) => Promise<void>
}

const WRITE_FILE_DESCRIPTION = `Create a new file in the connected Google Drive. Returns {fileId, name, mimeType, webViewLink, driveFileVersion?}. It never overwrites or updates an existing file.

content (for ordinary files) is one of:
- a utf8 string,
- {encoding: "base64", data: "..."},
- {storageUrl: "..."}: a storage key inside this workspace, such as the storageUrl google_drive__get_file_bytes returns. Use this for large files; it uploads in 8 MB resumable chunks.
Inline content under 5 MB uploads in one request. If the upload cannot be completed the call fails with UPLOAD_FAILED: restart it with a fresh call.

To create a Google Doc, set mimeType to ${GOOGLE_DOC_MIME} and pass docStructuredBody as the element array that google_drive__get_document_structured returns (or the whole result, which carries it under "body"). Supported elements, in order:
- {type: "heading", level: 1-6, text}
- {type: "paragraph", text}
- {type: "list", ordered?: boolean, items: string[]}
- {type: "table", cells: string[][]} (rows of cell text)
startIndex and endIndex on elements are ignored. Any other element type is rejected with INVALID_INPUT. content is not used for Docs.

To create a Google Sheet, set mimeType to ${GOOGLE_SHEET_MIME} and pass docStructuredBody as {values: string[][]}, written from cell A1 of the first sheet as text.

PERMISSION_DENIED means the connected account cannot write to parentFolderId; SCOPE_INSUFFICIENT means the Drive scope was not granted.`

const COMMENT_DESCRIPTION = `Add a comment to a Google Doc or Sheet (or any Drive file). Returns {commentId, createdTime, htmlContent}.
Without anchor the comment is a top-level file comment. For a Doc, anchor {docStartIndex, docEndIndex} anchors it to that text range (UTF-16 code units, as google_drive__get_document_structured reports them). For a Sheet, anchor {sheetRange} anchors it to a cell or range in A1 notation, optionally with a sheet name ("Sheet1!B2:C4").
PERMISSION_DENIED means the connected account cannot comment on that file; SCOPE_INSUFFICIENT means the Drive scope was not granted.`

export const writeFileInputShape = {
	name: z.string().min(1).describe('File name, including extension for ordinary files.'),
	parentFolderId: z
		.string()
		.min(1)
		.optional()
		.describe("Target folder id. Defaults to the connected account's My Drive root."),
	mimeType: z.string().min(1).describe('MIME type of the file to create.'),
	content: z
		.union([
			z.string(),
			z.object({ encoding: z.literal('base64'), data: z.string() }),
			z.object({ storageUrl: z.string().min(1) }),
		])
		.optional()
		.describe('File bytes. Required unless creating a Doc or Sheet from docStructuredBody.'),
	docStructuredBody: z
		.union([z.array(z.unknown()), z.record(z.unknown())])
		.optional()
		.describe('Doc: element array. Sheet: {values: string[][]}. See the tool description.'),
}

export const commentInputShape = {
	fileId: z.string().min(1),
	content: z.string().min(1).describe('Comment text.'),
	anchor: z
		.union([
			z.object({ docStartIndex: z.number().int().min(0), docEndIndex: z.number().int().min(1) }),
			z.object({ sheetRange: z.string().min(1) }),
		])
		.optional(),
}

function jsonResult(payload: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

function toolError(operation: string, err: unknown) {
	if (err instanceof DriveWriteError) {
		logger.info('Google Drive MCP tool returned a normalized error', {
			operation,
			code: err.code,
		})
		return {
			isError: true as const,
			content: [{ type: 'text' as const, text: JSON.stringify(err.toEnvelope()) }],
		}
	}
	logger.error('Google Drive MCP tool unexpected error', {
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

/** Registers google_drive__write_file and google_drive__comment_on_document on `server`. */
export function registerDriveWriteTools(server: McpServer, ctx: DriveWriteToolsContext): void {
	const http: DriveHttp = createDriveHttp({
		getAccessToken: ctx.getAccessToken,
		fetchImpl: ctx.fetchImpl,
		sleep: ctx.sleep,
	})

	server.registerTool(
		'google_drive__write_file',
		{ description: WRITE_FILE_DESCRIPTION, inputSchema: writeFileInputShape },
		async (input) => {
			try {
				const { output, path } = await writeFile(
					{
						http,
						workspaceId: ctx.workspaceId,
						openStorageObject: ctx.openStorageObject,
					},
					input,
				)
				void trackDriveFileWritten({
					workspaceId: ctx.workspaceId,
					actorId: ctx.actorId,
					mimeType: output.mimeType,
					path,
				})
				return jsonResult(output)
			} catch (err) {
				return toolError('google_drive__write_file', err)
			}
		},
	)

	server.registerTool(
		'google_drive__comment_on_document',
		{ description: COMMENT_DESCRIPTION, inputSchema: commentInputShape },
		async (input) => {
			try {
				const output = await commentOnDocument(http, input)
				void trackDriveCommentCreated({
					workspaceId: ctx.workspaceId,
					actorId: ctx.actorId,
					anchor: !input.anchor ? 'none' : 'docStartIndex' in input.anchor ? 'doc' : 'sheet',
				})
				return jsonResult(output)
			} catch (err) {
				return toolError('google_drive__comment_on_document', err)
			}
		},
	)
}
