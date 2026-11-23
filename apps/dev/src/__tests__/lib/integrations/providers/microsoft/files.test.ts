import { describe, expect, it } from 'vitest'
import {
	MAX_READ_BYTES,
	buildGetFileRequest,
	buildListFilesRequest,
	buildSearchFilesRequest,
	buildSiteSearchRequest,
	buildUploadRequest,
	cutText,
	isTextFile,
	readBlocker,
	trimItem,
} from '../../../../../lib/integrations/providers/microsoft/files'

describe('file addresses', () => {
	it('lists the top folder of the own OneDrive by default', () => {
		const built = buildListFilesRequest({})
		if (!built.ok) throw new Error(built.message)
		expect(new URL(built.url).pathname).toBe('/v1.0/me/drive/root/children')
		expect(new URL(built.url).searchParams.get('$top')).toBe('26')
	})

	it('addresses a folder by path, one encoded part at a time', () => {
		const built = buildListFilesRequest({ folder_path: '/Reports/Q3 plan/' })
		if (!built.ok) throw new Error(built.message)
		expect(built.url).toContain('/me/drive/root:/Reports/Q3%20plan:/children')
	})

	it('uses the site library when a site id is given, and refuses an id that is not one', () => {
		const ok = buildListFilesRequest({ site_id: 'contoso.sharepoint.com,aa-bb,cc-dd' })
		if (!ok.ok) throw new Error(ok.message)
		expect(ok.url).toContain('/sites/contoso.sharepoint.com%2Caa-bb%2Ccc-dd/drive/root/children')
		for (const site_id of ['a/b', 'a b', '../me', 'a?x=1']) {
			expect(buildListFilesRequest({ site_id }).ok).toBe(false)
		}
	})

	it('refuses folder paths that climb out or hold characters OneDrive rejects', () => {
		for (const folder_path of ['a/../b', './a', 'a/b*c', 'a\\b', 'a/b?']) {
			expect(buildListFilesRequest({ folder_path }).ok).toBe(false)
		}
	})

	it('doubles a quote in the search text so it stays inside the q parameter', () => {
		const built = buildSearchFilesRequest({ query: "it's  here" })
		if (!built.ok) throw new Error(built.message)
		expect(decodeURIComponent(built.url)).toContain("search(q='it''s here')")
		expect(buildSearchFilesRequest({ query: '   ' }).ok).toBe(false)
	})

	it('searches sites with the text encoded, and asks for no more than the cap', () => {
		const built = buildSiteSearchRequest({ query: 'sales & ops', limit: 500 })
		if (!built.ok) throw new Error(built.message)
		expect(new URL(built.url).searchParams.get('search')).toBe('sales & ops')
		expect(built.limit).toBe(25)
	})

	it('encodes an item id whole', () => {
		const built = buildGetFileRequest({ item_id: '01AB/cd+ef=' })
		if (!built.ok) throw new Error(built.message)
		expect(built.contentUrl).toBe(
			'https://graph.microsoft.com/v1.0/me/drive/items/01AB%2Fcd%2Bef%3D/content',
		)
		expect(buildGetFileRequest({ item_id: ' ' }).ok).toBe(false)
	})
})

describe('buildUploadRequest', () => {
	it('fails on a name clash by default and replaces only when asked', () => {
		const safe = buildUploadRequest({ name: 'a.md', content: 'x' })
		const replace = buildUploadRequest({ name: 'a.md', content: 'x', overwrite: true })
		if (!safe.ok || !replace.ok) throw new Error('expected ok')
		expect(safe.url).toBe(
			'https://graph.microsoft.com/v1.0/me/drive/root:/a.md:/content?@microsoft.graph.conflictBehavior=fail',
		)
		expect(replace.url).toContain('conflictBehavior=replace')
	})

	it('refuses a name with a path in it, empty text and text over the cap', () => {
		expect(buildUploadRequest({ name: 'a/b.md', content: 'x' }).ok).toBe(false)
		expect(buildUploadRequest({ name: '..', content: 'x' }).ok).toBe(false)
		expect(buildUploadRequest({ name: 'a.md', content: '' }).ok).toBe(false)
		// Counted in bytes: 400,000 three-byte characters is 1.2 MB.
		expect(buildUploadRequest({ name: 'a.md', content: '€'.repeat(400_000) }).ok).toBe(false)
	})
})

describe('reading a file', () => {
	it('reads text files by type or by extension, and not office files or folders', () => {
		expect(isTextFile({ name: 'a.bin', file: { mimeType: 'text/plain' } })).toBe(true)
		expect(isTextFile({ name: 'a.csv', file: { mimeType: 'application/octet-stream' } })).toBe(true)
		expect(
			isTextFile({ name: 'a.docx', file: { mimeType: 'application/vnd.openxmlformats' } }),
		).toBe(false)
		expect(isTextFile({ name: 'dir', folder: {} })).toBe(false)
	})

	it('gives a reason for a folder, a non-text file and a big file, and none for a small text file', () => {
		expect(readBlocker({ folder: {} })).toMatch(/folder/)
		expect(readBlocker({ name: 'a.pdf', file: { mimeType: 'application/pdf' } })).toMatch(
			/plain text/,
		)
		expect(
			readBlocker({ name: 'a.txt', size: MAX_READ_BYTES + 1, file: { mimeType: 'text/plain' } }),
		).toMatch(/bigger/)
		expect(readBlocker({ name: 'a.txt', size: 10, file: { mimeType: 'text/plain' } })).toBeNull()
	})

	it('cuts long text and says so', () => {
		expect(cutText('short')).toEqual({ text: 'short', truncated: false })
		expect(cutText('x'.repeat(30_001)).truncated).toBe(true)
	})

	it('trims an item to what an agent needs, with the parent as a plain path', () => {
		expect(
			trimItem({ id: 'i', name: 'a.md', parentReference: { path: '/drives/b!x/root:/Docs/2026' } }),
		).toMatchObject({ id: 'i', type: 'file', folder: '/Docs/2026' })
		expect(
			trimItem({
				id: 'r',
				name: 'x',
				folder: { childCount: 2 },
				parentReference: { path: '/drive/root:' },
			}),
		).toMatchObject({ type: 'folder', child_count: 2, folder: '/' })
	})
})
