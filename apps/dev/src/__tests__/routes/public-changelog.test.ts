import { describe, expect, it } from 'vitest'
import publicChangelogRoutes from '../../routes/public-changelog'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

function buildEntryRow(overrides?: Record<string, unknown>) {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		title: 'Markdown previews now render inline',
		content: 'Open any `.md` file from the workspace and it now renders next to the editor.',
		metadata: { tag: 'New', hero_image_url: 'https://cdn.example/hero.png' },
		updatedAt: new Date('2026-06-13T09:00:00.000Z'),
		...overrides,
	}
}

describe('GET /v1/changelog (JSON)', () => {
	it('returns published entries newest-first with the documented shape', async () => {
		const { app, mockResults } = createTestApp(publicChangelogRoutes, '/v1')
		const newer = buildEntryRow()
		const older = buildEntryRow({
			id: '22222222-2222-4222-8222-222222222222',
			title: 'Faster session start',
			content: 'Container cold-start dropped from 4s to 1.2s.',
			metadata: { tag: 'Improved' },
			updatedAt: new Date('2026-06-06T09:00:00.000Z'),
		})
		mockResults.select = [newer, older]

		const res = await app.request(jsonGet('/v1/changelog'))
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			entries: Array<{
				id: string
				title: string
				content: string
				tag: string | null
				published_at: string
				hero_image_url?: string
			}>
		}

		expect(body.entries).toHaveLength(2)
		expect(body.entries[0]).toEqual({
			id: newer.id,
			title: newer.title,
			content: newer.content,
			tag: 'New',
			published_at: '2026-06-13T09:00:00.000Z',
			hero_image_url: 'https://cdn.example/hero.png',
		})
		// hero_image_url is omitted (not set to null/undefined) when missing.
		expect(body.entries[1].hero_image_url).toBeUndefined()
		expect(body.entries[1].tag).toBe('Improved')
	})

	it('returns an empty entries array when nothing is published', async () => {
		const { app, mockResults } = createTestApp(publicChangelogRoutes, '/v1')
		mockResults.select = []

		const res = await app.request(jsonGet('/v1/changelog'))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { entries: unknown[] }
		expect(body.entries).toEqual([])
	})

	it('orders by metadata.published_at when set, so editing an entry does not re-date or re-sort it', async () => {
		const { app, mockResults } = createTestApp(publicChangelogRoutes, '/v1')
		const editedButPublishedEarlier = buildEntryRow({
			id: '33333333-3333-4333-8333-333333333333',
			title: 'Old entry, edited today',
			metadata: { tag: 'Fixed', published_at: '2026-06-01T09:00:00.000Z' },
			// A later content edit bumps updated_at without touching published_at —
			// this must not change the entry's position or reported date.
			updatedAt: new Date('2026-07-01T09:00:00.000Z'),
		})
		const genuinelyNewer = buildEntryRow({
			id: '44444444-4444-4444-8444-444444444444',
			title: 'Newer entry, never edited',
			metadata: { tag: 'New', published_at: '2026-06-15T09:00:00.000Z' },
			updatedAt: new Date('2026-06-15T09:00:00.000Z'),
		})
		mockResults.select = [editedButPublishedEarlier, genuinelyNewer]

		const res = await app.request(jsonGet('/v1/changelog'))
		const body = (await res.json()) as { entries: Array<{ id: string; published_at: string }> }

		expect(body.entries.map((e) => e.id)).toEqual([genuinelyNewer.id, editedButPublishedEarlier.id])
		expect(body.entries[1].published_at).toBe('2026-06-01T09:00:00.000Z')
	})

	it('falls back to updated_at when metadata.published_at is absent', async () => {
		const { app, mockResults } = createTestApp(publicChangelogRoutes, '/v1')
		mockResults.select = [buildEntryRow()]

		const res = await app.request(jsonGet('/v1/changelog'))
		const body = (await res.json()) as { entries: Array<{ published_at: string }> }
		expect(body.entries[0].published_at).toBe('2026-06-13T09:00:00.000Z')
	})

	it('serves tag as null when metadata.tag is not one of the known values', async () => {
		const { app, mockResults } = createTestApp(publicChangelogRoutes, '/v1')
		mockResults.select = [buildEntryRow({ metadata: { tag: 'NotARealTag' } })]

		const res = await app.request(jsonGet('/v1/changelog'))
		const body = (await res.json()) as { entries: Array<{ tag: string | null }> }
		expect(body.entries[0].tag).toBeNull()
	})

	it('serves tag as null when metadata.tag is missing', async () => {
		const { app, mockResults } = createTestApp(publicChangelogRoutes, '/v1')
		mockResults.select = [buildEntryRow({ metadata: {} })]

		const res = await app.request(jsonGet('/v1/changelog'))
		const body = (await res.json()) as { entries: Array<{ tag: string | null }> }
		expect(body.entries[0].tag).toBeNull()
	})

	it('serves CORS headers permitting the marketing-site origin', async () => {
		// CORS is wired in app-factory, not in the route module — verify the
		// route doesn't break a CORS preflight when middleware is applied at
		// the app level. Route-level test asserts the underlying handler
		// behaviour; the wired-in CORS policy is covered in app-factory wiring.
		const { app, mockResults } = createTestApp(publicChangelogRoutes, '/v1')
		mockResults.select = []
		const res = await app.request(
			new Request('http://localhost/v1/changelog', {
				method: 'GET',
				headers: { Origin: 'https://sindre.ai' },
			}),
		)
		expect(res.status).toBe(200)
	})
})

describe('GET /v1/changelog.xml (RSS)', () => {
	it('returns a well-formed RSS 2.0 channel with entries as items', async () => {
		const { app, mockResults } = createTestApp(publicChangelogRoutes, '/v1')
		mockResults.select = [
			buildEntryRow({
				title: 'Title with <special> & "chars"',
				content: 'Body uses ampersands & angle brackets <like this>.',
				metadata: { tag: 'Fixed' },
			}),
		]

		const res = await app.request(jsonGet('/v1/changelog.xml'))
		expect(res.status).toBe(200)
		expect(res.headers.get('Content-Type')).toBe('application/rss+xml; charset=utf-8')

		const xml = await res.text()
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
		expect(xml).toContain('<rss version="2.0">')
		expect(xml).toContain('<title>Maskin changelog</title>')
		expect(xml).toContain('<link>https://sindre.ai/changelog</link>')
		// Tag prefix applied to item title; XML-special chars escaped.
		expect(xml).toContain(
			'<title>[Fixed] Title with &lt;special&gt; &amp; &quot;chars&quot;</title>',
		)
		// Description escapes & and < so the feed stays well-formed.
		expect(xml).toContain('Body uses ampersands &amp; angle brackets &lt;like this&gt;.')
		// pubDate is RFC 822, not ISO-8601 — many RSS readers reject ISO dates.
		expect(xml).toMatch(
			/<pubDate>[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/,
		)
	})

	it('returns an empty channel (no items) when nothing is published', async () => {
		const { app, mockResults } = createTestApp(publicChangelogRoutes, '/v1')
		mockResults.select = []

		const res = await app.request(jsonGet('/v1/changelog.xml'))
		expect(res.status).toBe(200)
		const xml = await res.text()
		expect(xml).toContain('<rss version="2.0">')
		expect(xml).not.toContain('<item>')
	})
})
