import { z } from 'zod'
import {
	trackDriveCommentCreated,
	trackDriveFileWritten,
} from '../../../analytics/drive-write-events'
import { commentOnDocument } from './comment'
import { GOOGLE_DOC_MIME, GOOGLE_SHEET_MIME } from './doc-body'
import { type StorageSource, writeFile } from './write-file'
import { type DriveHttp, createDriveHttp } from './write-http'

export const WRITE_FILE_TOOL = 'google_drive__write_file'
export const COMMENT_ON_DOCUMENT_TOOL = 'google_drive__comment_on_document'

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

export const WRITE_FILE_DESCRIPTION = `Create a new file in the connected Google Drive. Returns {fileId, name, mimeType, webViewLink, driveFileVersion?}. It never overwrites or updates an existing file.

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

export const COMMENT_DESCRIPTION = `Add a comment to a Google Doc or Sheet (or any Drive file). Returns {commentId, createdTime, htmlContent}.
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

export type WriteFileToolInput = z.infer<z.ZodObject<typeof writeFileInputShape>>
export type CommentToolInput = z.infer<z.ZodObject<typeof commentInputShape>>

function httpFor(ctx: DriveWriteToolsContext): DriveHttp {
	return createDriveHttp({
		getAccessToken: ctx.getAccessToken,
		fetchImpl: ctx.fetchImpl,
		sleep: ctx.sleep,
	})
}

/** google_drive__write_file. Throws DriveWriteError; the server's runTool turns it into the error envelope. */
export async function driveWriteFile(ctx: DriveWriteToolsContext, input: WriteFileToolInput) {
	const { output, path } = await writeFile(
		{
			http: httpFor(ctx),
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
	return output
}

/** google_drive__comment_on_document. Throws DriveWriteError; see driveWriteFile. */
export async function driveCommentOnDocument(ctx: DriveWriteToolsContext, input: CommentToolInput) {
	const output = await commentOnDocument(httpFor(ctx), input)
	void trackDriveCommentCreated({
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		anchor: !input.anchor ? 'none' : 'docStartIndex' in input.anchor ? 'doc' : 'sheet',
	})
	return output
}
