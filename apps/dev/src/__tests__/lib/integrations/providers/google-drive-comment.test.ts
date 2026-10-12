import { describe, expect, it } from 'vitest'
import {
	commentOnDocument,
	encodeAnchor,
	splitSheetRange,
} from '../../../../lib/integrations/providers/google-drive/comment'
import { DriveWriteError } from '../../../../lib/integrations/providers/google-drive/write-errors'
import { googleError, jsonResponse, makeHttp } from './google-drive-fakes'

interface Call {
	method: string
	url: string
	body?: Record<string, unknown>
}

function recorder(responses: Array<(c: Call) => Response | undefined>) {
	const calls: Call[] = []
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const call: Call = {
			method: init?.method ?? 'GET',
			url,
			body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
		}
		calls.push(call)
		for (const r of responses) {
			const res = r(call)
			if (res) return res
		}
		throw new Error(`unrouted ${call.method} ${url}`)
	}) as unknown as typeof fetch
	return { calls, http: makeHttp(fetchImpl) }
}

const created = (c: Call) =>
	c.method === 'POST' && c.url.includes('/drive/v3/files/file-1/comments')
		? jsonResponse({
				id: 'cmt-1',
				createdTime: '2026-10-05T10:00:00.000Z',
				htmlContent: '<p>Hi</p>',
			})
		: undefined

const decode = (anchor: unknown) =>
	JSON.parse(Buffer.from(String(anchor), 'base64').toString('utf8'))

describe('commentOnDocument', () => {
	it('posts a top-level comment when no anchor is given', async () => {
		const { calls, http } = recorder([created])
		const out = await commentOnDocument(http, { fileId: 'file-1', content: 'Hi' })
		expect(out).toEqual({
			commentId: 'cmt-1',
			createdTime: '2026-10-05T10:00:00.000Z',
			htmlContent: '<p>Hi</p>',
		})
		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toContain('fields=id,createdTime,htmlContent,content')
		expect(calls[0]?.body).toEqual({ content: 'Hi' })
	})

	it('anchors to a Doc range with a revisionId fetched right before create', async () => {
		const { calls, http } = recorder([
			(c) =>
				c.method === 'GET' &&
				c.url.includes('docs.googleapis.com/v1/documents/file-1?fields=revisionId')
					? jsonResponse({ revisionId: 'rev-9' })
					: undefined,
			created,
		])
		await commentOnDocument(http, {
			fileId: 'file-1',
			content: 'Tighten this',
			anchor: { docStartIndex: 10, docEndIndex: 25 },
		})
		expect(calls.map((c) => c.method)).toEqual(['GET', 'POST'])
		expect(decode(calls[1]?.body?.anchor)).toEqual({ r: ['rev-9'], a: [{ txt: { i: 10, e: 25 } }] })
	})

	it('anchors to a Sheet range, resolving the sheet gid by title', async () => {
		const { calls, http } = recorder([
			(c) =>
				c.method === 'GET' && c.url.includes('sheets.googleapis.com/v4/spreadsheets/file-1')
					? jsonResponse({
							sheets: [
								{ properties: { sheetId: 0, title: 'Sheet1' } },
								{ properties: { sheetId: 1234, title: 'Q3 numbers' } },
							],
						})
					: undefined,
			created,
		])
		await commentOnDocument(http, {
			fileId: 'file-1',
			content: 'Check B2',
			anchor: { sheetRange: "'Q3 numbers'!B2:C4" },
		})
		expect(decode(calls[1]?.body?.anchor)).toEqual({
			r: ['head'],
			a: [{ matrix: { sheet: [1234], range: ['B2:C4'] } }],
		})
	})

	it('uses the first sheet when the range has no sheet name', async () => {
		const { calls, http } = recorder([
			(c) =>
				c.method === 'GET'
					? jsonResponse({ sheets: [{ properties: { sheetId: 77, title: 'Data' } }] })
					: undefined,
			created,
		])
		await commentOnDocument(http, { fileId: 'file-1', content: 'x', anchor: { sheetRange: 'A1' } })
		expect(decode(calls[1]?.body?.anchor).a[0].matrix).toEqual({ sheet: [77], range: ['A1'] })
	})

	it('validates input before calling Google', async () => {
		const { calls, http } = recorder([])
		const bad = [
			{ fileId: 'file-1', content: '   ' },
			{ fileId: 'file-1', content: 'x', anchor: { docStartIndex: 5, docEndIndex: 5 } },
			{ fileId: 'file-1', content: 'x', anchor: { docStartIndex: -1, docEndIndex: 5 } },
		]
		for (const input of bad) {
			await expect(commentOnDocument(http, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		}
		expect(calls).toHaveLength(0)
	})

	it('fails on an unknown sheet name instead of anchoring to the wrong sheet', async () => {
		const { http } = recorder([
			(c) =>
				c.method === 'GET'
					? jsonResponse({ sheets: [{ properties: { sheetId: 0, title: 'A' } }] })
					: undefined,
		])
		await expect(
			commentOnDocument(http, {
				fileId: 'file-1',
				content: 'x',
				anchor: { sheetRange: 'Nope!A1' },
			}),
		).rejects.toThrow(/No sheet named "Nope"/)
	})

	it('returns PERMISSION_DENIED and SCOPE_INSUFFICIENT from the comment call', async () => {
		const denied = recorder([
			() =>
				googleError(
					403,
					'The user does not have sufficient permissions for this file.',
					'insufficientFilePermissions',
				),
		])
		await expect(
			commentOnDocument(denied.http, { fileId: 'file-1', content: 'x' }),
		).rejects.toMatchObject({
			code: 'PERMISSION_DENIED',
		})
		const scope = recorder([
			() =>
				googleError(
					403,
					'Request had insufficient authentication scopes.',
					'insufficientPermissions',
					{
						details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
					},
				),
		])
		const err = await commentOnDocument(scope.http, { fileId: 'file-1', content: 'x' }).catch(
			(e) => e,
		)
		expect(err).toBeInstanceOf(DriveWriteError)
		expect(err.code).toBe('SCOPE_INSUFFICIENT')
	})
})

describe('anchor helpers', () => {
	it('base64-encodes the JSON blob', () => {
		expect(decode(encodeAnchor({ r: ['x'] }))).toEqual({ r: ['x'] })
	})

	it('splits sheet ranges, including quoted names with apostrophes', () => {
		expect(splitSheetRange('A1:B2')).toEqual({ a1: 'A1:B2' })
		expect(splitSheetRange('Sheet1!A1')).toEqual({ title: 'Sheet1', a1: 'A1' })
		expect(splitSheetRange("'Bob''s data'!C3")).toEqual({ title: "Bob's data", a1: 'C3' })
	})
})
