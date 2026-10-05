import { describe, expect, it } from 'vitest'
import {
	parseDocBody,
	parseSheetBody,
	sheetValuesRequests,
	textRunRequests,
} from '../../../../lib/integrations/providers/google-drive/doc-body'
import { DriveWriteError } from '../../../../lib/integrations/providers/google-drive/write-errors'

describe('parseDocBody', () => {
	it('accepts a get_document_structured result as-is (read-then-write round trip)', () => {
		const result = {
			documentId: 'doc-1',
			title: 'Spec',
			revisionId: 'r1',
			truncated: false,
			body: [
				{ type: 'heading', startIndex: 1, endIndex: 6, level: 2, text: 'Plan' },
				{ type: 'paragraph', startIndex: 6, endIndex: 12, text: 'Hello' },
				{ type: 'list', startIndex: 12, endIndex: 20, text: 'one' },
				{ type: 'table', startIndex: 20, endIndex: 40, cells: [['a', 'b'], ['c']] },
			],
		}
		expect(parseDocBody(result)).toEqual([
			{ type: 'heading', level: 2, text: 'Plan' },
			{ type: 'paragraph', text: 'Hello' },
			{ type: 'list', ordered: false, items: ['one'] },
			{
				type: 'table',
				cells: [
					['a', 'b'],
					['c', ''],
				],
			},
		])
		expect(parseDocBody(result.body)).toHaveLength(4)
	})

	it('rejects unsupported element types with a clear validation error', () => {
		const run = () =>
			parseDocBody([
				{ type: 'paragraph', text: 'ok' },
				{ type: 'image', url: 'x' },
			])
		expect(run).toThrow(DriveWriteError)
		try {
			run()
		} catch (err) {
			const e = err as DriveWriteError
			expect(e.code).toBe('INVALID_INPUT')
			expect(e.message).toContain('docStructuredBody[1]')
			expect(e.message).toContain('"image"')
			expect(e.hint).toContain('heading, paragraph, list, table')
		}
	})

	it('rejects malformed elements and non-array bodies', () => {
		expect(() => parseDocBody({ nope: true })).toThrow(/array of elements/)
		expect(() => parseDocBody([{ type: 'heading', level: 9, text: 'x' }])).toThrow(
			/docStructuredBody\[0\]/,
		)
		expect(() => parseDocBody([{ type: 'table', cells: [] }])).toThrow(DriveWriteError)
		expect(() => parseDocBody([{ type: 'list' }])).toThrow(/items/)
	})
})

describe('textRunRequests', () => {
	it('computes insert positions and styles from the order of elements', () => {
		const { requests, cursor } = textRunRequests(
			[
				{ type: 'heading', level: 1, text: 'Title' },
				{ type: 'paragraph', text: 'Body' },
				{ type: 'list', ordered: true, items: ['a', 'b'] },
			],
			1,
		)
		expect(requests).toEqual([
			{ insertText: { location: { index: 1 }, text: 'Title\n' } },
			{
				updateParagraphStyle: {
					range: { startIndex: 1, endIndex: 7 },
					paragraphStyle: { namedStyleType: 'HEADING_1' },
					fields: 'namedStyleType',
				},
			},
			{ insertText: { location: { index: 7 }, text: 'Body\n' } },
			{ insertText: { location: { index: 12 }, text: 'a\nb\n' } },
			{
				createParagraphBullets: {
					range: { startIndex: 12, endIndex: 16 },
					bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
				},
			},
		])
		expect(cursor).toBe(16)
	})

	it('counts UTF-16 code units, so emoji advance the cursor by two', () => {
		const { cursor } = textRunRequests([{ type: 'paragraph', text: '😀' }], 1)
		expect(cursor).toBe(1 + 2 + 1)
	})

	it('keeps headings and list items on one line each', () => {
		const { requests } = textRunRequests([{ type: 'heading', level: 3, text: 'a\nb' }], 1)
		expect(requests[0]).toEqual({ insertText: { location: { index: 1 }, text: 'a b\n' } })
	})
})

describe('sheet body', () => {
	it('requires {values: string[][]}', () => {
		expect(parseSheetBody({ values: [['a', 'b'], ['c']] })).toEqual([['a', 'b'], ['c']])
		expect(() => parseSheetBody({ values: [[1, 2]] })).toThrow(/\{values: string\[\]\[\]\}/)
		expect(() => parseSheetBody([['a']])).toThrow(DriveWriteError)
	})

	it('writes text cells from A1 and grows the grid only when needed', () => {
		const small = sheetValuesRequests(0, [['a', 'b']])
		expect(small).toEqual([
			{
				updateCells: {
					start: { sheetId: 0, rowIndex: 0, columnIndex: 0 },
					rows: [
						{
							values: [
								{ userEnteredValue: { stringValue: 'a' } },
								{ userEnteredValue: { stringValue: 'b' } },
							],
						},
					],
					fields: 'userEnteredValue',
				},
			},
		])
		const wide = sheetValuesRequests(5, [Array(30).fill('x')])
		expect(wide[0]).toMatchObject({
			updateSheetProperties: {
				properties: { sheetId: 5, gridProperties: { rowCount: 1000, columnCount: 30 } },
			},
		})
	})
})
