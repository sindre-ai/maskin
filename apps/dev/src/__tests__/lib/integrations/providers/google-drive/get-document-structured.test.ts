import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import docCassette from './cassettes/docs-structured.json'
import { replayDocsSheetsCassette } from './docs-sheets-cassette'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const getToken = vi.fn()
vi.mock('../../../../../lib/integrations/providers/google-drive/token', () => ({
	getGoogleDriveAccessToken: (...args: unknown[]) => getToken(...args),
}))

const capture = vi.fn()
vi.mock('../../../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capture(...args),
}))

import type {
	DocsDocument,
	DocsSheetsClient,
} from '../../../../../lib/integrations/providers/google-drive/docs-sheets-client'
import {
	DOCUMENT_MAX_RESPONSE_BYTES,
	getDocumentStructured,
} from '../../../../../lib/integrations/providers/google-drive/tools/get-document-structured'

const ctx = { db: {} as never, workspaceId: 'ws-1', actorId: 'actor-1' }

beforeEach(() => {
	getToken.mockReset().mockResolvedValue({ accessToken: 'tok', integrationId: 'int-1' })
	capture.mockReset()
})
afterEach(() => vi.restoreAllMocks())

/** A Doc of `count` plain paragraphs of `chars` characters each (one index per character, plus the newline). */
function bigDoc(count: number, chars: number): DocsDocument {
	const text = 'x'.repeat(chars)
	return {
		documentId: 'big',
		title: 'Big',
		revisionId: 'rev-1',
		body: {
			content: Array.from({ length: count }, (_, i) => ({
				startIndex: 1 + i * (chars + 1),
				endIndex: 1 + (i + 1) * (chars + 1),
				paragraph: {
					paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
					elements: [{ textRun: { content: `${text}\n` } }],
				},
			})),
		},
	}
}

const clientFor = (doc: DocsDocument): DocsSheetsClient => ({
	getDocument: vi.fn().mockResolvedValue(doc),
	getSpreadsheetSheets: vi.fn(),
	getSheetValues: vi.fn(),
})

describe('getDocumentStructured (cassette)', () => {
	it('returns typed elements in order with UTF-16 indices, levels, text, cells and grouped lists', async () => {
		const fetchSpy = replayDocsSheetsCassette(docCassette)

		const out = await getDocumentStructured(ctx, { documentId: 'doc-plan' })

		expect(out).toEqual({
			documentId: 'doc-plan',
			title: 'Quarterly plan',
			revisionId: 'rev-42',
			truncated: false,
			body: [
				{ type: 'heading', startIndex: 1, endIndex: 16, level: 1, text: 'Quarterly plan' },
				{ type: 'paragraph', startIndex: 16, endIndex: 31, text: 'Revenue is up.' },
				{
					type: 'list',
					startIndex: 31,
					endIndex: 64,
					items: [
						{ text: 'Hire two engineers', level: 0 },
						{ text: 'Backend first', level: 1 },
					],
				},
				{ type: 'heading', startIndex: 64, endIndex: 70, level: 2, text: 'Risks' },
				{
					type: 'table',
					startIndex: 70,
					endIndex: 100,
					cells: [
						['Risk', 'Owner'],
						['Churn', 'Ana\nEU'],
					],
				},
				{
					type: 'list',
					startIndex: 100,
					endIndex: 117,
					items: [{ text: 'Second list item', level: 0 }],
				},
				{
					type: 'list',
					startIndex: 117,
					endIndex: 128,
					items: [{ text: 'Other list', level: 0 }],
				},
			],
		})

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
		const u = new URL(url)
		expect(u.origin + u.pathname).toBe('https://docs.googleapis.com/v1/documents/doc-plan')
		expect(u.searchParams.get('fields')).toBe('documentId,title,revisionId,body.content')
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
	})

	it('with startIndex and endIndex returns only the overlapping elements', async () => {
		replayDocsSheetsCassette(docCassette)

		const out = await getDocumentStructured(ctx, {
			documentId: 'doc-plan',
			startIndex: 20,
			endIndex: 60,
		})

		expect(out.body.map((e) => e.type)).toEqual(['paragraph', 'list'])
		expect(out.body[1]).toMatchObject({ startIndex: 31, endIndex: 64 })
		expect(out.truncated).toBe(false)
	})

	it('treats the range as half-open: an element ending at startIndex is excluded', async () => {
		replayDocsSheetsCassette(docCassette)
		const out = await getDocumentStructured(ctx, { documentId: 'doc-plan', startIndex: 16 })
		expect(out.body[0]).toMatchObject({ type: 'paragraph', startIndex: 16 })
		const upTo = await getDocumentStructured(ctx, { documentId: 'doc-plan', endIndex: 16 })
		expect(upTo.body.map((e) => e.type)).toEqual(['heading'])
	})

	it('maps a missing document to FILE_NOT_FOUND', async () => {
		replayDocsSheetsCassette(docCassette)
		await expect(getDocumentStructured(ctx, { documentId: 'doc-missing' })).rejects.toMatchObject({
			code: 'FILE_NOT_FOUND',
		})
		expect(capture).not.toHaveBeenCalled()
	})

	it('rejects endIndex <= startIndex before touching the token or Google', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		await expect(
			getDocumentStructured(ctx, { documentId: 'd', startIndex: 10, endIndex: 10 }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		expect(getToken).not.toHaveBeenCalled()
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('emits drive_doc_read with counts and flags, never ids, titles or text', async () => {
		replayDocsSheetsCassette(docCassette)
		await getDocumentStructured(ctx, { documentId: 'doc-plan' })
		await getDocumentStructured(ctx, { documentId: 'doc-plan', startIndex: 20, endIndex: 60 })

		expect(capture).toHaveBeenCalledTimes(2)
		const [name, actor, props] = capture.mock.calls[0] as [string, string, Record<string, unknown>]
		expect(name).toBe('drive_doc_read')
		expect(actor).toBe('actor-1')
		expect(props).toMatchObject({
			provider: 'google-drive',
			workspace_id: 'ws-1',
			element_count: 7,
			ranged: false,
			truncated: false,
		})
		expect(typeof props.response_bytes).toBe('number')
		expect(capture.mock.calls[1]?.[2]).toMatchObject({ element_count: 2, ranged: true })
		const serialized = JSON.stringify(capture.mock.calls)
		expect(serialized).not.toContain('doc-plan')
		expect(serialized).not.toContain('Quarterly')
	})
})

describe('getDocumentStructured 4 MB cap', () => {
	it('returns a 500-page-sized Doc in full when it serializes to 4 MB or less (S15)', async () => {
		// 500 pages x 30 paragraphs x 100 characters.
		const doc = bigDoc(15_000, 100)
		const out = await getDocumentStructured(
			{ ...ctx, docsSheetsClient: clientFor(doc) },
			{ documentId: 'big' },
		)

		expect(out.body).toHaveLength(15_000)
		expect(out.truncated).toBe(false)
		expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(
			DOCUMENT_MAX_RESPONSE_BYTES,
		)
	})

	it('errors with DOCUMENT_TOO_LARGE past 4 MB, never a cut-short body, and says how to page', async () => {
		const doc = bigDoc(20_000, 300)

		const err = await getDocumentStructured(
			{ ...ctx, docsSheetsClient: clientFor(doc) },
			{ documentId: 'big' },
		).catch((e) => e)

		expect(err).toMatchObject({ code: 'DOCUMENT_TOO_LARGE' })
		expect(err.message).toContain('startIndex and endIndex')
		expect(err.message).toContain(`0 to ${1 + 20_000 * 301}`)
		expect(capture).not.toHaveBeenCalled()
	})

	it('serves a range of the same Doc that fits, with only the overlapping elements', async () => {
		const doc = bigDoc(20_000, 300)
		const out = await getDocumentStructured(
			{ ...ctx, docsSheetsClient: clientFor(doc) },
			{ documentId: 'big', startIndex: 1, endIndex: 1 + 1000 * 301 },
		)
		expect(out.body).toHaveLength(1000)
		expect(out.truncated).toBe(false)
	})

	it('errors with DOCUMENT_TOO_LARGE for a requested range that is itself over 4 MB', async () => {
		const doc = bigDoc(20_000, 300)
		const err = await getDocumentStructured(
			{ ...ctx, docsSheetsClient: clientFor(doc) },
			{ documentId: 'big', startIndex: 5 },
		).catch((e) => e)
		expect(err).toMatchObject({ code: 'DOCUMENT_TOO_LARGE' })
		expect(err.message).toContain('requested range')
	})
})
