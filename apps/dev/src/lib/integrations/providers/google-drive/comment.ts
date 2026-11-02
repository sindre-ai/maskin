import { invalidInput } from './write-errors'
import { DOCS_API, DRIVE_API, type DriveHttp, SHEETS_API, googleJson } from './write-http'

export type CommentAnchor = { docStartIndex: number; docEndIndex: number } | { sheetRange: string }

export interface CommentInput {
	fileId: string
	content: string
	anchor?: CommentAnchor
}

export interface CommentOutput {
	commentId: string
	createdTime: string
	htmlContent: string
}

/** Drive's Comments API takes the anchor as a base64-encoded JSON blob. */
export function encodeAnchor(blob: unknown): string {
	return Buffer.from(JSON.stringify(blob), 'utf8').toString('base64')
}

/** Split "Sheet 1!A1:B2" or "'My Sheet'!A1" into sheet title (if any) and A1 range. */
export function splitSheetRange(sheetRange: string): { title?: string; a1: string } {
	const bang = sheetRange.lastIndexOf('!')
	if (bang === -1) return { a1: sheetRange.trim() }
	let title = sheetRange.slice(0, bang).trim()
	if (title.startsWith("'") && title.endsWith("'") && title.length >= 2) {
		title = title.slice(1, -1).replace(/''/g, "'")
	}
	return { title, a1: sheetRange.slice(bang + 1).trim() }
}

async function docAnchor(http: DriveHttp, fileId: string, start: number, end: number) {
	// Fetched right before create so the anchor is as fresh as the revision race allows.
	const doc = await googleJson<{ revisionId?: string }>(
		http,
		`${DOCS_API}/documents/${encodeURIComponent(fileId)}?fields=revisionId`,
	)
	if (!doc.revisionId) throw invalidInput('Google did not return a revisionId for this Doc.')
	return encodeAnchor({ r: [doc.revisionId], a: [{ txt: { i: start, e: end } }] })
}

async function sheetAnchor(http: DriveHttp, fileId: string, sheetRange: string) {
	const { title, a1 } = splitSheetRange(sheetRange)
	if (!a1)
		throw invalidInput(
			'anchor.sheetRange must include a cell or range, such as "A1" or "Sheet1!A1:B2".',
		)
	const meta = await googleJson<{
		sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>
	}>(
		http,
		`${SHEETS_API}/spreadsheets/${encodeURIComponent(fileId)}?fields=sheets(properties(sheetId,title))`,
	)
	const sheets = meta.sheets ?? []
	const match = title ? sheets.find((s) => s.properties?.title === title) : sheets[0]
	if (match?.properties?.sheetId === undefined) {
		throw invalidInput(
			title ? `No sheet named "${title}" in this spreadsheet.` : 'This spreadsheet has no sheets.',
		)
	}
	// Sheets have no Docs-style revisionId endpoint; "head" anchors to the current state.
	return encodeAnchor({
		r: ['head'],
		a: [{ matrix: { sheet: [match.properties.sheetId], range: [a1] } }],
	})
}

export async function commentOnDocument(
	http: DriveHttp,
	input: CommentInput,
): Promise<CommentOutput> {
	if (!input.content.trim()) throw invalidInput('content must not be empty.')

	let anchor: string | undefined
	if (input.anchor && 'docStartIndex' in input.anchor) {
		const { docStartIndex: start, docEndIndex: end } = input.anchor
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
			throw invalidInput('anchor needs integer docStartIndex >= 0 and docEndIndex > docStartIndex.')
		}
		anchor = await docAnchor(http, input.fileId, start, end)
	} else if (input.anchor) {
		anchor = await sheetAnchor(http, input.fileId, input.anchor.sheetRange)
	}

	// Drive's comments methods require an explicit fields mask.
	const created = await googleJson<{
		id: string
		createdTime: string
		htmlContent?: string
		content?: string
	}>(
		http,
		`${DRIVE_API}/files/${encodeURIComponent(input.fileId)}/comments?fields=id,createdTime,htmlContent,content`,
		{ method: 'POST', body: { content: input.content, ...(anchor && { anchor }) } },
	)
	return {
		commentId: created.id,
		createdTime: created.createdTime,
		htmlContent: created.htmlContent ?? created.content ?? input.content,
	}
}
