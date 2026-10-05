import { z } from 'zod'
import { invalidInput } from './write-errors'

export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document'
export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet'

/**
 * Elements accepted in docStructuredBody. This mirrors the element array that
 * google_drive__get_document_structured returns (heading, paragraph, list,
 * table), so a read-then-write round trip works. startIndex / endIndex on an
 * element are ignored: positions are recomputed from the order of the array.
 */
export type DocElement =
	| { type: 'heading'; level: number; text: string }
	| { type: 'paragraph'; text: string }
	| { type: 'list'; ordered: boolean; items: string[] }
	| { type: 'table'; cells: string[][] }

const SUPPORTED_TYPES = ['heading', 'paragraph', 'list', 'table']

const headingSchema = z.object({
	level: z.number().int().min(1).max(6).optional(),
	text: z.string(),
})
const paragraphSchema = z.object({ text: z.string() })
const listSchema = z
	.object({
		ordered: z.boolean().optional(),
		items: z.array(z.string()).min(1).optional(),
		text: z.string().optional(),
	})
	.refine((v) => v.items !== undefined || v.text !== undefined, {
		message: 'a list needs "items" (string[]) or "text"',
	})
const tableSchema = z.object({
	cells: z.array(z.array(z.string()).min(1)).min(1),
})

function describe(path: string, error: z.ZodError): string {
	const issue = error.issues[0]
	if (!issue) return `${path}: invalid`
	return `${path}${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`
}

/**
 * Validate docStructuredBody into DocElements. Accepts the bare element array
 * or an object carrying it under "body" (the whole get_document_structured
 * result). Unsupported element types fail with INVALID_INPUT.
 */
export function parseDocBody(raw: unknown): DocElement[] {
	const list = Array.isArray(raw) ? raw : (raw as { body?: unknown } | null)?.body
	if (!Array.isArray(list)) {
		throw invalidInput(
			'docStructuredBody must be an array of elements, or an object with a "body" array.',
			`Supported element types: ${SUPPORTED_TYPES.join(', ')}.`,
		)
	}
	return list.map((el, i): DocElement => {
		const path = `docStructuredBody[${i}]`
		const type = (el as { type?: unknown } | null)?.type
		if (typeof type !== 'string' || !SUPPORTED_TYPES.includes(type)) {
			throw invalidInput(
				`${path}: element type ${JSON.stringify(type)} is not supported.`,
				`Supported element types: ${SUPPORTED_TYPES.join(', ')}.`,
			)
		}
		if (type === 'heading') {
			const r = headingSchema.safeParse(el)
			if (!r.success) throw invalidInput(describe(path, r.error))
			return { type, level: r.data.level ?? 1, text: r.data.text }
		}
		if (type === 'paragraph') {
			const r = paragraphSchema.safeParse(el)
			if (!r.success) throw invalidInput(describe(path, r.error))
			return { type, text: r.data.text }
		}
		if (type === 'list') {
			const r = listSchema.safeParse(el)
			if (!r.success) throw invalidInput(describe(path, r.error))
			return {
				type,
				ordered: r.data.ordered ?? false,
				items: r.data.items ?? [r.data.text as string],
			}
		}
		const r = tableSchema.safeParse(el)
		if (!r.success) throw invalidInput(describe(path, r.error))
		const width = Math.max(...r.data.cells.map((row) => row.length))
		return {
			type: 'table',
			cells: r.data.cells.map((row) => [...row, ...Array(width - row.length).fill('')]),
		}
	})
}

const oneLine = (s: string) => s.replace(/\r?\n/g, ' ')

/**
 * Docs batchUpdate requests for a run of consecutive non-table elements,
 * appended at `cursor` (the index just before the body's final newline).
 * Returns the requests and the cursor after the run. Indices are UTF-16 code
 * units, which is what JS string length counts.
 */
export function textRunRequests(
	elements: Exclude<DocElement, { type: 'table' }>[],
	cursor: number,
): { requests: object[]; cursor: number } {
	const requests: object[] = []
	let at = cursor
	for (const el of elements) {
		let text: string
		if (el.type === 'list') text = el.items.map((item) => `${oneLine(item)}\n`).join('')
		else if (el.type === 'heading') text = `${oneLine(el.text)}\n`
		else text = `${el.text}\n`
		const range = { startIndex: at, endIndex: at + text.length }
		requests.push({ insertText: { location: { index: at }, text } })
		if (el.type === 'heading') {
			requests.push({
				updateParagraphStyle: {
					range,
					paragraphStyle: { namedStyleType: `HEADING_${el.level}` },
					fields: 'namedStyleType',
				},
			})
		} else if (el.type === 'list') {
			requests.push({
				createParagraphBullets: {
					range,
					bulletPreset: el.ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
				},
			})
		}
		at += text.length
	}
	return { requests, cursor: at }
}

const sheetBodySchema = z.object({ values: z.array(z.array(z.string())).min(1) })

/** Sheet body is {values: string[][]}; every cell is written as text. */
export function parseSheetBody(raw: unknown): string[][] {
	const r = sheetBodySchema.safeParse(raw)
	if (!r.success) {
		throw invalidInput(
			`docStructuredBody for a Sheet must be {values: string[][]}. ${describe('docStructuredBody', r.error)}`,
		)
	}
	return r.data.values
}

const DEFAULT_ROWS = 1000
const DEFAULT_COLUMNS = 26
const MAX_PAYLOAD_CHARS = 8_000_000

/** spreadsheets.batchUpdate requests that write `values` from A1 of the sheet with `sheetId`. */
export function sheetValuesRequests(sheetId: number, values: string[][]): object[] {
	const rows = values.length
	const columns = Math.max(...values.map((row) => row.length))
	const requests: object[] = []
	if (rows > DEFAULT_ROWS || columns > DEFAULT_COLUMNS) {
		requests.push({
			updateSheetProperties: {
				properties: {
					sheetId,
					gridProperties: {
						rowCount: Math.max(rows, DEFAULT_ROWS),
						columnCount: Math.max(columns, DEFAULT_COLUMNS),
					},
				},
				fields: 'gridProperties.rowCount,gridProperties.columnCount',
			},
		})
	}
	requests.push({
		updateCells: {
			start: { sheetId, rowIndex: 0, columnIndex: 0 },
			rows: values.map((row) => ({
				values: row.map((cell) => ({ userEnteredValue: { stringValue: cell } })),
			})),
			fields: 'userEnteredValue',
		},
	})
	if (JSON.stringify(requests).length > MAX_PAYLOAD_CHARS) {
		throw invalidInput(
			'The Sheet body is too large for one write (about 8 MB serialized).',
			'Split the data across several smaller files or Sheets.',
		)
	}
	return requests
}
