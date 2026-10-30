import { parseJson, requestWithRetry, sleep } from './client'
import type { DriveToolContext } from './operations'

const DOCS_API_BASE = 'https://docs.googleapis.com/v1'
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4'

/**
 * Docs API and Sheets API reads for the structured-read tools. Same retry and
 * error classification as the Drive client (shared requestWithRetry), kept as a
 * separate interface so the Drive client's shape, and the fakes that implement
 * it, do not change. Tests inject a fake fetch.
 */
export interface DocsSheetsClient {
	getDocument(accessToken: string, documentId: string): Promise<DocsDocument>
	getSpreadsheetSheets(accessToken: string, spreadsheetId: string): Promise<SheetsMetadata>
	getSheetValues(
		accessToken: string,
		spreadsheetId: string,
		range: string,
		majorDimension: 'ROWS' | 'COLUMNS',
	): Promise<SheetsValuesResponse>
}

export interface DocsSheetsToolContext extends DriveToolContext {
	/** Injection point for tests. Defaults to the real fetch-backed client. */
	docsSheetsClient?: DocsSheetsClient
}

/** The slice of a Docs API document the structured read uses. */
export interface DocsDocument {
	documentId?: string
	title?: string
	revisionId?: string
	body?: { content?: DocsStructuralElement[] }
}

export interface DocsStructuralElement {
	startIndex?: number
	endIndex?: number
	paragraph?: DocsParagraph
	table?: { tableRows?: Array<{ tableCells?: Array<{ content?: DocsStructuralElement[] }> }> }
}

export interface DocsParagraph {
	paragraphStyle?: { namedStyleType?: string }
	bullet?: { listId?: string; nestingLevel?: number }
	elements?: Array<{ textRun?: { content?: string } }>
}

export interface SheetsMetadata {
	sheets?: Array<{ properties?: { title?: string; gridProperties?: { rowCount?: number } } }>
}

export interface SheetsValuesResponse {
	range?: string
	majorDimension?: string
	values?: string[][]
}

export function createDefaultDocsSheetsClient(
	fetchImpl: typeof fetch = fetch,
	sleepImpl: (ms: number) => Promise<void> = sleep,
): DocsSheetsClient {
	return {
		async getDocument(accessToken, documentId) {
			const qs = new URLSearchParams({ fields: 'documentId,title,revisionId,body.content' })
			const res = await requestWithRetry(
				fetchImpl,
				sleepImpl,
				`${DOCS_API_BASE}/documents/${encodeURIComponent(documentId)}?${qs.toString()}`,
				accessToken,
				'docs.documents.get',
			)
			return await parseJson<DocsDocument>(res)
		},

		async getSpreadsheetSheets(accessToken, spreadsheetId) {
			const qs = new URLSearchParams({ fields: 'sheets.properties(title,gridProperties.rowCount)' })
			const res = await requestWithRetry(
				fetchImpl,
				sleepImpl,
				`${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}?${qs.toString()}`,
				accessToken,
				'sheets.spreadsheets.get',
			)
			return await parseJson<SheetsMetadata>(res)
		},

		async getSheetValues(accessToken, spreadsheetId, range, majorDimension) {
			const qs = new URLSearchParams({ majorDimension })
			const res = await requestWithRetry(
				fetchImpl,
				sleepImpl,
				`${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${qs.toString()}`,
				accessToken,
				'sheets.spreadsheets.values.get',
			)
			return await parseJson<SheetsValuesResponse>(res)
		},
	}
}
