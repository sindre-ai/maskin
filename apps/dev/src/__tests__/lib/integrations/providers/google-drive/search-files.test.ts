import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replayCassette } from './cassette'
import searchCassette from './cassettes/search-files.json'

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

import { searchFiles } from '../../../../../lib/integrations/providers/google-drive/tools/search-files'

const db = {} as never
const ctx = { db, workspaceId: 'ws-1', actorId: 'actor-1' }

beforeEach(() => {
	getToken.mockReset().mockResolvedValue({ accessToken: 'tok', integrationId: 'int-1' })
	capture.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('searchFiles (cassette)', () => {
	it('returns the documented file shape plus nextPageToken, hiding trashed by default', async () => {
		const fetchSpy = replayCassette(searchCassette)

		const out = await searchFiles(ctx, { query: "fullText contains 'invoice'" })

		expect(out.nextPageToken).toBe('page-2-token')
		expect(out.files).toHaveLength(2)
		expect(out.files[0]).toEqual({
			id: '1AbC',
			name: 'Invoice 2026-09.pdf',
			mimeType: 'application/pdf',
			modifiedTime: '2026-09-30T08:15:00.000Z',
			parents: ['0Root'],
			owners: [{ displayName: 'Sebk', emailAddress: 'sebk@meshfirm.com' }],
			webViewLink: 'https://drive.google.com/file/d/1AbC/view',
		})
		const u = new URL(String(fetchSpy.mock.calls[0]?.[0]))
		expect(u.searchParams.get('q')).toBe("(fullText contains 'invoice') and trashed = false")
		expect(u.searchParams.get('pageSize')).toBe('100')
	})

	it('follows the page token and ends with no nextPageToken', async () => {
		replayCassette(searchCassette)
		const out = await searchFiles(ctx, {
			query: "fullText contains 'invoice'",
			pageToken: 'page-2-token',
		})
		expect(out).toEqual({ files: [] })
	})

	it('includeTrashed true drops the trashed filter and passes the query through', async () => {
		const fetchSpy = replayCassette(searchCassette)
		await searchFiles(ctx, {
			query: "mimeType = 'application/vnd.google-apps.document'",
			includeTrashed: true,
		})
		const u = new URL(String(fetchSpy.mock.calls[0]?.[0]))
		expect(u.searchParams.get('q')).toBe("(mimeType = 'application/vnd.google-apps.document')")
	})

	it('parenthesises the caller query so an "or" cannot escape the trashed filter', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => new Response(JSON.stringify({ files: [] }), { status: 200 }))
		await searchFiles(ctx, { query: "name contains 'a' or name contains 'b'" })
		const u = new URL(String(fetchSpy.mock.calls[0]?.[0]))
		expect(u.searchParams.get('q')).toBe(
			"(name contains 'a' or name contains 'b') and trashed = false",
		)
	})

	it('an empty query with includeTrashed sends no q at all', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => new Response(JSON.stringify({ files: [] }), { status: 200 }))
		await searchFiles(ctx, { query: '  ', includeTrashed: true, orderBy: 'modifiedTime desc' })
		const u = new URL(String(fetchSpy.mock.calls[0]?.[0]))
		expect(u.searchParams.get('q')).toBe('')
		expect(u.searchParams.get('orderBy')).toBe('modifiedTime desc')
	})

	it('caps pageSize at 100', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => new Response(JSON.stringify({ files: [] }), { status: 200 }))
		await searchFiles(ctx, { query: 'x', pageSize: 5000 })
		expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.get('pageSize')).toBe('100')
		await searchFiles(ctx, { query: 'x', pageSize: 7 })
		expect(new URL(String(fetchSpy.mock.calls[1]?.[0])).searchParams.get('pageSize')).toBe('7')
	})

	it('resolves the token for the caller workspace only', async () => {
		replayCassette(searchCassette)
		await searchFiles(ctx, { query: "fullText contains 'invoice'" })
		expect(getToken).toHaveBeenCalledWith(db, 'ws-1')
	})

	it('emits drive_search_ran with counts and flags, never the query text', async () => {
		replayCassette(searchCassette)
		await searchFiles(ctx, { query: "fullText contains 'invoice'" })

		expect(capture).toHaveBeenCalledTimes(1)
		const [event, distinctId, props] = capture.mock.calls[0] as [
			string,
			string,
			Record<string, unknown>,
		]
		expect(event).toBe('drive_search_ran')
		expect(distinctId).toBe('actor-1')
		expect(props).toEqual({
			provider: 'google-drive',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			result_count: 2,
			has_more: true,
			include_trashed: false,
			page_size: 100,
		})
		expect(JSON.stringify(props)).not.toContain('invoice')
	})

	it('propagates a classified Drive error and emits no success event', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ error: { errors: [{ reason: 'notFound' }] } }), {
				status: 404,
			}),
		)
		await expect(searchFiles(ctx, { query: 'x' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
		expect(capture).not.toHaveBeenCalled()
	})

	it('propagates INTEGRATION_MISSING from the token layer before any Drive call', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		getToken.mockRejectedValueOnce(
			Object.assign(new Error('none'), { code: 'INTEGRATION_MISSING' }),
		)
		await expect(searchFiles(ctx, { query: 'x' })).rejects.toMatchObject({
			code: 'INTEGRATION_MISSING',
		})
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
