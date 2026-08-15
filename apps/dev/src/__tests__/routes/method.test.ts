import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { METHOD_SITE_PAGEVIEW_EVENT } from '../../lib/analytics/method-site-pageview'
import methodRoutes, { slugFor } from '../../routes/method'
import { createTestContext } from '../setup'

const wsId = '00000000-0000-0000-0000-000000000001'

function mount() {
	const { db, mockResults } = createTestContext()
	const app = new Hono()
	app.use('*', async (c, next) => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal env for the method route
		;(c as any).set('db', db)
		await next()
	})
	app.route('/method', methodRoutes)
	return { app, mockResults }
}

const originalKey = process.env.VITE_POSTHOG_KEY
const originalHost = process.env.VITE_POSTHOG_HOST

function restoreEnv(name: 'VITE_POSTHOG_KEY' | 'VITE_POSTHOG_HOST', value: string | undefined) {
	if (value === undefined) Reflect.deleteProperty(process.env, name)
	else process.env[name] = value
}

describe('method routes', () => {
	beforeEach(() => {
		process.env.METHOD_WORKSPACE_ID = undefined
		process.env.VITE_POSTHOG_KEY = 'phc_test_key'
		process.env.VITE_POSTHOG_HOST = 'https://eu.i.posthog.com'
	})

	afterEach(() => {
		restoreEnv('VITE_POSTHOG_KEY', originalKey)
		restoreEnv('VITE_POSTHOG_HOST', originalHost)
	})

	describe('GET /method/development', () => {
		it('serves an empty cover shell (200) when no workspace has opted in', async () => {
			const { app, mockResults } = mount()
			mockResults.select = []
			const res = await app.request('/method/development')
			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toContain('text/html')
			expect(res.headers.get('cache-control')).toContain('s-maxage=300')
			const html = await res.text()
			expect(html).toContain('<!doctype html>')
			expect(html).toContain('Development')
			// Ship metric inlined even on the empty shell so a probe still
			// counts as a pageview.
			expect(html).toContain(METHOD_SITE_PAGEVIEW_EVENT)
			expect(html).toContain('posthog.init(')
		})

		it('renders featured + sibling chapters when workspace has published chapters', async () => {
			const { app, mockResults } = mount()
			mockResults.selectQueue = [
				[
					{
						id: wsId,
						settings: {
							publish: {
								enabled: true,
								title: 'Sindre.ai',
								description: 'A working method.',
								visibility: 'public',
								version: 1,
							},
						},
					},
				],
				[
					{
						id: '11111111-1111-1111-1111-111111111111',
						title: 'How we work',
						content: '# Intro\n\nHello world.',
						updatedAt: new Date('2026-06-01T00:00:00Z'),
						metadata: { grade: 'chapter', section: 'Development' },
					},
					{
						id: '22222222-2222-2222-2222-222222222222',
						title: 'On betting',
						content: 'Betting is how work compounds.',
						updatedAt: new Date('2026-05-01T00:00:00Z'),
						metadata: { grade: 'chapter' },
					},
				],
			]
			const res = await app.request('/method/development')
			expect(res.status).toBe(200)
			const html = await res.text()
			expect(html).toContain('Sindre.ai')
			expect(html).toContain('How we work')
			expect(html).toContain('On betting')
			expect(res.headers.get('etag')).toMatch(/^"[a-f0-9]+"$/)
			// Cover pageview has an empty chapter_slug.
			expect(html).toContain('chapter_slug:')
			expect(html).toContain(METHOD_SITE_PAGEVIEW_EVENT)
		})

		it('returns 304 when If-None-Match matches ETag', async () => {
			const { app, mockResults } = mount()
			const wsRow = {
				id: wsId,
				settings: { publish: { enabled: true, title: 'M', version: 3 } },
			}
			const chapterRow = {
				id: '11111111-1111-1111-1111-111111111111',
				title: 'Chapter',
				content: 'body',
				updatedAt: new Date('2026-06-01T00:00:00Z'),
				metadata: { grade: 'chapter' },
			}
			mockResults.selectQueue = [[wsRow], [chapterRow]]

			const first = await app.request('/method/development')
			const etag = first.headers.get('etag') ?? ''
			expect(etag).not.toEqual('')

			mockResults.selectQueue = [[wsRow], [chapterRow]]
			const second = await app.request('/method/development', {
				headers: { 'if-none-match': etag },
			})
			expect(second.status).toBe(304)
		})
	})

	describe('GET /method/development/:slug', () => {
		it('renders a chapter matched by slug with the pageview script inlined', async () => {
			const { app, mockResults } = mount()
			const chapterId = '11111111-1111-1111-1111-111111111111'
			const slug = slugFor(chapterId, 'How we work')
			mockResults.selectQueue = [
				[
					{
						id: wsId,
						settings: { publish: { enabled: true, title: 'M', version: 2 } },
					},
				],
				[
					{
						id: chapterId,
						title: 'How we work',
						content: '# Intro\n\nThis is the article.',
						updatedAt: new Date('2026-06-01T00:00:00Z'),
						metadata: { grade: 'chapter' },
					},
				],
			]
			const res = await app.request(`/method/development/${slug}`)
			expect(res.status).toBe(200)
			const html = await res.text()
			expect(html).toContain('How we work')
			expect(html).toContain('This is the article.')
			expect(html).toContain('<h1>Intro</h1>')
			expect(res.headers.get('cache-control')).toContain('s-maxage=300')
			// T2 ship metric: chapter_slug is inlined as a JSON literal.
			expect(html).toContain(`"${slug}"`)
			expect(html).toContain('posthog.capture(')
		})

		it('returns 404 for an unknown slug', async () => {
			const { app, mockResults } = mount()
			mockResults.selectQueue = [
				[
					{
						id: wsId,
						settings: { publish: { enabled: true, title: 'M' } },
					},
				],
				[],
			]
			const res = await app.request('/method/development/no-such-slug-abc123')
			expect(res.status).toBe(404)
		})

		it('returns 404 for a malformed slug', async () => {
			const { app } = mount()
			const res = await app.request('/method/development/BAD..slug!')
			expect(res.status).toBe(404)
		})

		it('sanitises embedded HTML in the chapter body so raw <script> never reaches the reader', async () => {
			const { app, mockResults } = mount()
			const chapterId = '11111111-1111-1111-1111-111111111111'
			const slug = slugFor(chapterId, 'Sec test')
			mockResults.selectQueue = [
				[
					{
						id: wsId,
						settings: { publish: { enabled: true } },
					},
				],
				[
					{
						id: chapterId,
						title: 'Sec test',
						content: '<script>alert(1)</script>\n\nHello',
						updatedAt: new Date('2026-06-01T00:00:00Z'),
						metadata: { grade: 'chapter' },
					},
				],
			]
			const res = await app.request(`/method/development/${slug}`)
			const html = await res.text()
			// The article body wraps the sanitised markdown output.
			const bodyMatch = html.match(/<div class="article__body">([\s\S]*?)<\/div>/)
			expect(bodyMatch).not.toBeNull()
			const articleBody = bodyMatch?.[1] ?? ''
			expect(articleBody).not.toContain('<script>')
			expect(articleBody).not.toContain('alert(1)')
			expect(articleBody).toContain('Hello')
		})

		it('degrades to a no-op pageview script when VITE_POSTHOG_KEY is unset', async () => {
			Reflect.deleteProperty(process.env, 'VITE_POSTHOG_KEY')
			const { app, mockResults } = mount()
			const chapterId = '11111111-1111-1111-1111-111111111111'
			const slug = slugFor(chapterId, 'K')
			mockResults.selectQueue = [
				[
					{
						id: wsId,
						settings: { publish: { enabled: true } },
					},
				],
				[
					{
						id: chapterId,
						title: 'K',
						content: 'body',
						updatedAt: new Date('2026-06-01T00:00:00Z'),
						metadata: { grade: 'chapter' },
					},
				],
			]
			const res = await app.request(`/method/development/${slug}`)
			expect(res.status).toBe(200)
			const body = await res.text()
			expect(body).toContain(METHOD_SITE_PAGEVIEW_EVENT)
			expect(body).not.toContain('posthog.init(')
		})
	})

	describe('slugFor', () => {
		it('produces a stable kebab + 6-hex suffix', () => {
			const s = slugFor('11111111-1111-1111-1111-111111111111', 'How We Work — Part 1')
			expect(s).toMatch(/^how-we-work-part-1-[a-f0-9]{6}$/)
		})

		it('is stable across title edits when the id stays constant', () => {
			const id = '11111111-1111-1111-1111-111111111111'
			const a = slugFor(id, 'Working method')
			const b = slugFor(id, 'A better title for the working method')
			expect(a.slice(-6)).toEqual(b.slice(-6))
		})
	})
})
