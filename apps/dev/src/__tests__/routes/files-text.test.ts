import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFile, buildWorkspaceMember } from '../factories'
import { buildBriefingDeck } from '../fixtures/briefing-deck'
import { jsonGet, jsonRequest } from '../helpers'
import { createImportTestApp } from '../setup'

const { default: filesRoutes } = await import('../../routes/files')

const workspaceId = '00000000-0000-0000-0000-000000000001'
const fileId = '11111111-1111-4111-8111-111111111111'

describe('GET /api/files/:id?format=text', () => {
	beforeEach(() => {
		vi.stubEnv('FRONTEND_URL', 'http://localhost:5173')
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	function setup(mimeType: string, bytes: Buffer) {
		const ctx = createImportTestApp(filesRoutes, '/api/files')
		const file = buildFile({ id: fileId, workspaceId, mimeType, sizeBytes: bytes.byteLength })
		vi.mocked(ctx.storageProvider.get).mockResolvedValue(bytes)
		ctx.mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })]]
		return { ...ctx, file }
	}

	it('returns the readable text of an HTML deck instead of its bytes', async () => {
		const html = buildBriefingDeck({ fontChars: 200_000 })
		const { app } = setup('text/html', Buffer.from(html))

		const res = await app.request(jsonGet(`/api/files/${fileId}?format=text`))

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json.extracted).toBe(true)
		expect(json.title).toBe('Weekly readout, 27 Oct')
		expect(json.meta_description).toBe('What we learned this week')
		expect(json.json_ld).toEqual([{ '@type': 'Report', name: 'Weekly readout' }])
		expect(json.content_text).toContain('## Plumbing is no moat')
		expect(json.content_text).not.toContain('QUJD')
		expect(json.content).toBeUndefined()
		expect(json.contentHash).toMatch(/^[0-9a-f]{64}$/)
		expect(JSON.stringify(json).length).toBeLessThan(5_000)
	})

	it('returns a non-HTML text file unchanged', async () => {
		const { app } = setup('text/markdown', Buffer.from('# Hello\n\n<b>kept</b>'))

		const json = await (await app.request(jsonGet(`/api/files/${fileId}?format=text`))).json()

		expect(json.content_text).toBe('# Hello\n\n<b>kept</b>')
		expect(json.extracted).toBe(false)
	})

	it('ignores format=text for a binary file and returns the base64 detail', async () => {
		const { app } = setup('image/png', Buffer.from([0x89, 0x50]))

		const json = await (await app.request(jsonGet(`/api/files/${fileId}?format=text`))).json()

		expect(json.encoding).toBe('base64')
		expect(json.content).toBe(Buffer.from([0x89, 0x50]).toString('base64'))
		expect(json.content_text).toBeUndefined()
	})

	it('returns 400 for an unknown format', async () => {
		const { app } = setup('text/html', Buffer.from('<p>x</p>'))

		const res = await app.request(jsonGet(`/api/files/${fileId}?format=pdf`))

		expect(res.status).toBe(400)
	})

	it('puts readable_with before content on a large raw HTML read', async () => {
		const html = buildBriefingDeck({ fontChars: 300_000 })
		const { app } = setup('text/html', Buffer.from(html))

		const raw = await (await app.request(jsonGet(`/api/files/${fileId}`))).text()

		const json = JSON.parse(raw)
		expect(json.readable_with).toMatch(
			/^get_file format=text \(\d+% of this file is embedded fonts\)$/,
		)
		expect(raw.indexOf('"readable_with"')).toBeLessThan(raw.indexOf('"content"'))
		expect(json.content).toBe(html)
	})

	it('adds no hint to a small HTML file', async () => {
		const { app } = setup('text/html', Buffer.from(buildBriefingDeck()))

		const json = await (await app.request(jsonGet(`/api/files/${fileId}`))).json()

		expect(json.readable_with).toBeUndefined()
	})
})

describe('PATCH /api/files/:id edits validation', () => {
	beforeEach(() => {
		vi.stubEnv('FRONTEND_URL', 'http://localhost:5173')
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	async function patch(body: Record<string, unknown>) {
		const { app } = createImportTestApp(filesRoutes, '/api/files')
		return app.request(
			jsonRequest('PATCH', `/api/files/${fileId}`, body, { 'X-Workspace-Id': workspaceId }),
		)
	}

	it('rejects edits together with content', async () => {
		const res = await patch({ content: 'x', edits: [{ old: 'a', new: 'b' }] })
		expect(res.status).toBe(400)
	})

	it('rejects edits with base64 encoding', async () => {
		const res = await patch({ encoding: 'base64', edits: [{ old: 'a', new: 'b' }] })
		expect(res.status).toBe(400)
	})

	it('rejects an empty edits list and an empty old string', async () => {
		expect((await patch({ edits: [] })).status).toBe(400)
		expect((await patch({ edits: [{ old: '', new: 'b' }] })).status).toBe(400)
	})

	it('rejects more than 50 edits', async () => {
		const edits = Array.from({ length: 51 }, () => ({ old: 'a', new: 'b' }))
		expect((await patch({ edits })).status).toBe(400)
	})

	it('rejects edits whose text is too large in total', async () => {
		const big = 'x'.repeat(200_000)
		const edits = Array.from({ length: 6 }, () => ({ old: big, new: 'y' }))
		expect((await patch({ edits })).status).toBe(400)
	})
})
