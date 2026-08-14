import { relationships, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import methodRoutes, { slugFor } from '../../routes/method'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db } from './global-setup'

const wsIdEnvKey = 'METHOD_WORKSPACE_ID'

function mount(workspaceId: string) {
	const app = new Hono()
	app.use('*', async (c, next) => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal env
		;(c as any).set('db', db)
		await next()
	})
	app.route('/method', methodRoutes)
	process.env[wsIdEnvKey] = workspaceId
	return app
}

describe('method routes (integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		const actor = await insertActor(db, { type: 'human', name: 'Integration Author' })
		actorId = actor.id
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	afterEach(() => {
		process.env[wsIdEnvKey] = undefined
	})

	it('serves the empty cover shell when the workspace has not opted in', async () => {
		const app = mount(workspaceId)
		const res = await app.request('/method/development')
		expect(res.status).toBe(200)
		const html = await res.text()
		expect(html).toContain('<!doctype html>')
		expect(html).toContain('No chapters published yet.')
	})

	it('returns 404 for chapter routes when the workspace has not opted in', async () => {
		const app = mount(workspaceId)
		const res = await app.request('/method/development/anything')
		expect(res.status).toBe(404)
	})

	it('lists only validated knowledge chapters — filters out draft grade + wrong status', async () => {
		await db
			.update(workspaces)
			.set({
				settings: {
					publish: { enabled: true, title: 'Site', version: 1, visibility: 'public' },
				},
			})
			.where(eq(workspaces.id, workspaceId))

		// Valid: knowledge + validated + grade=chapter
		const chapter = await insertObject(db, workspaceId, actorId, {
			type: 'knowledge',
			status: 'validated',
			title: 'How we work',
			content: 'Body of chapter one.',
			metadata: { grade: 'chapter' },
		})

		// Wrong status
		await insertObject(db, workspaceId, actorId, {
			type: 'knowledge',
			status: 'draft',
			title: 'Draft chapter',
			content: 'not published',
			metadata: { grade: 'chapter' },
		})

		// Wrong grade
		await insertObject(db, workspaceId, actorId, {
			type: 'knowledge',
			status: 'validated',
			title: 'A blurb',
			content: 'not a chapter',
			metadata: { grade: 'atom' },
		})

		const app = mount(workspaceId)
		const res = await app.request('/method/development')
		expect(res.status).toBe(200)
		const html = await res.text()
		expect(html).toContain('How we work')
		expect(html).not.toContain('Draft chapter')
		expect(html).not.toContain('A blurb')

		const slug = slugFor(chapter?.id ?? '', 'How we work')
		const chapterRes = await app.request(`/method/development/${slug}`)
		expect(chapterRes.status).toBe(200)
		const chapterHtml = await chapterRes.text()
		expect(chapterHtml).toContain('Body of chapter one.')
	})

	it('excludes a chapter with an active contradicts inbound edge', async () => {
		await db
			.update(workspaces)
			.set({
				settings: {
					publish: { enabled: true, title: 'Site', version: 1, visibility: 'public' },
				},
			})
			.where(eq(workspaces.id, workspaceId))

		const good = await insertObject(db, workspaceId, actorId, {
			type: 'knowledge',
			status: 'validated',
			title: 'Standing chapter',
			content: 'Still true.',
			metadata: { grade: 'chapter' },
		})

		const contradicted = await insertObject(db, workspaceId, actorId, {
			type: 'knowledge',
			status: 'validated',
			title: 'Contradicted chapter',
			content: 'Superseded.',
			metadata: { grade: 'chapter' },
		})

		const critique = await insertObject(db, workspaceId, actorId, {
			type: 'knowledge',
			status: 'validated',
			title: 'Critique',
			content: 'Reason it fails.',
			metadata: { grade: 'atom' },
		})

		await db.insert(relationships).values({
			sourceType: 'object',
			sourceId: critique?.id ?? '',
			targetType: 'object',
			targetId: contradicted?.id ?? '',
			type: 'contradicts',
			createdBy: actorId,
		})

		const app = mount(workspaceId)
		const res = await app.request('/method/development')
		const html = await res.text()
		expect(html).toContain('Standing chapter')
		expect(html).not.toContain('Contradicted chapter')

		// And the direct chapter URL for a contradicted chapter should 404.
		const slug = slugFor(contradicted?.id ?? '', 'Contradicted chapter')
		const chapterRes = await app.request(`/method/development/${slug}`)
		expect(chapterRes.status).toBe(404)

		// Sanity: `good` is still reachable.
		void good
	})
})
