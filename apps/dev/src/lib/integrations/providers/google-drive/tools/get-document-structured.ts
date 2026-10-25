import { capturePosthogEvent } from '../../../../analytics/posthog'
import {
	type DocsParagraph,
	type DocsSheetsToolContext,
	type DocsStructuralElement,
	createDefaultDocsSheetsClient,
} from '../docs-sheets-client'
import { DriveError } from '../errors'
import { getGoogleDriveAccessToken } from '../token'

export const GET_DOCUMENT_STRUCTURED_TOOL = 'google_drive__get_document_structured'

/** A response whose serialized JSON is larger than this is refused, never cut short. */
export const DOCUMENT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export interface GetDocumentStructuredInput {
	documentId: string
	startIndex?: number
	endIndex?: number
}

export type DocumentElement =
	| { type: 'heading'; startIndex: number; endIndex: number; level: number; text: string }
	| { type: 'paragraph'; startIndex: number; endIndex: number; text: string }
	| { type: 'table'; startIndex: number; endIndex: number; cells: string[][] }
	| {
			type: 'list'
			startIndex: number
			endIndex: number
			items: Array<{ text: string; level: number }>
	  }

export interface GetDocumentStructuredOutput {
	documentId: string
	title: string
	revisionId: string
	body: DocumentElement[]
	/** Always false at v1: an oversize response is an error, not a cut-short success. */
	truncated: boolean
}

export const GET_DOCUMENT_STRUCTURED_DESCRIPTION =
	'Read a Google Doc as an ordered list of typed elements: heading (with level), paragraph, table (cells as rows of text) and list (items with nesting level), each with startIndex and endIndex in UTF-16 code units. With no range the whole Doc is returned if the response is 4 MB or less. With startIndex and endIndex only the elements overlapping that range are returned. A Doc, or a range, over 4 MB returns DOCUMENT_TOO_LARGE and never a cut-short body: re-call with a narrower startIndex and endIndex. Reads the first tab of the Doc. Text is plain text; formatting, images and tables of contents are not returned.'

/**
 * google_drive__get_document_structured. Google gives no server-side slicing on
 * Docs bodies, so the whole document is fetched and sliced here on
 * body.content[] by its startIndex/endIndex.
 */
export async function getDocumentStructured(
	ctx: DocsSheetsToolContext,
	input: GetDocumentStructuredInput,
): Promise<GetDocumentStructuredOutput> {
	if (
		input.startIndex !== undefined &&
		input.endIndex !== undefined &&
		input.endIndex <= input.startIndex
	) {
		throw new DriveError({
			code: 'INVALID_INPUT',
			message: 'endIndex must be greater than startIndex.',
		})
	}

	const { accessToken } = await getGoogleDriveAccessToken(ctx.db, ctx.workspaceId, ctx.actorId)
	const client = ctx.docsSheetsClient ?? createDefaultDocsSheetsClient()
	const doc = await client.getDocument(accessToken, input.documentId)

	const content = doc.body?.content ?? []
	const ranged = input.startIndex !== undefined || input.endIndex !== undefined
	const from = input.startIndex ?? 0
	const to = input.endIndex ?? Number.POSITIVE_INFINITY
	const overlapping = content.filter((el) => (el.endIndex ?? 0) > from && (el.startIndex ?? 0) < to)

	const out: GetDocumentStructuredOutput = {
		documentId: doc.documentId ?? input.documentId,
		title: doc.title ?? '',
		revisionId: doc.revisionId ?? '',
		body: toElements(overlapping),
		truncated: false,
	}

	const responseBytes = Buffer.byteLength(JSON.stringify(out), 'utf8')
	if (responseBytes > DOCUMENT_MAX_RESPONSE_BYTES) {
		const docEnd = content.reduce((max, el) => Math.max(max, el.endIndex ?? 0), 0)
		throw new DriveError({
			code: 'DOCUMENT_TOO_LARGE',
			message: `The ${ranged ? 'requested range' : 'document'} is ${(responseBytes / 1024 / 1024).toFixed(1)} MB, over the 4 MB limit. Re-call with startIndex and endIndex to read it in ranges; the document spans indices 0 to ${docEnd}.`,
			hint: 'Read it in several calls with a narrower startIndex and endIndex each.',
		})
	}

	// Best-effort; counts and sizes only, never ids, titles or text.
	void capturePosthogEvent('drive_doc_read', ctx.actorId, {
		provider: 'google-drive',
		workspace_id: ctx.workspaceId,
		actor_id: ctx.actorId,
		element_count: out.body.length,
		response_bytes: responseBytes,
		ranged,
		truncated: false,
	})
	return out
}

function toElements(content: DocsStructuralElement[]): DocumentElement[] {
	const out: DocumentElement[] = []
	// The list element still being extended: consecutive bullets of one Docs list.
	let open: { list: Extract<DocumentElement, { type: 'list' }>; listId?: string } | undefined
	for (const el of content) {
		const startIndex = el.startIndex ?? 0
		const endIndex = el.endIndex ?? startIndex

		if (el.table) {
			open = undefined
			out.push({
				type: 'table',
				startIndex,
				endIndex,
				cells: (el.table.tableRows ?? []).map((row) =>
					(row.tableCells ?? []).map((cell) =>
						(cell.content ?? [])
							.filter((c) => c.paragraph)
							.map((c) => paragraphText(c.paragraph as DocsParagraph))
							.join('\n'),
					),
				),
			})
			continue
		}

		const p = el.paragraph
		if (!p) continue // section breaks and tables of contents are not part of the model

		const text = paragraphText(p)
		if (p.bullet) {
			const item = { text, level: p.bullet.nestingLevel ?? 0 }
			if (open && open.listId === p.bullet.listId) {
				open.list.items.push(item)
				open.list.endIndex = endIndex
			} else {
				const list: Extract<DocumentElement, { type: 'list' }> = {
					type: 'list',
					startIndex,
					endIndex,
					items: [item],
				}
				out.push(list)
				open = { list, listId: p.bullet.listId }
			}
			continue
		}
		open = undefined

		const level = headingLevel(p.paragraphStyle?.namedStyleType)
		out.push(
			level > 0
				? { type: 'heading', startIndex, endIndex, level, text }
				: { type: 'paragraph', startIndex, endIndex, text },
		)
	}
	return out
}

function paragraphText(p: DocsParagraph): string {
	const joined = (p.elements ?? []).map((e) => e.textRun?.content ?? '').join('')
	return joined.endsWith('\n') ? joined.slice(0, -1) : joined
}

/** HEADING_1..HEADING_6 are headings; TITLE, SUBTITLE and NORMAL_TEXT are paragraphs. */
function headingLevel(namedStyleType: string | undefined): number {
	const m = /^HEADING_([1-6])$/.exec(namedStyleType ?? '')
	return m ? Number(m[1]) : 0
}
