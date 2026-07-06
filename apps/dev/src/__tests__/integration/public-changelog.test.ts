import { SINDRE_AI_PUBLIC_WORKSPACE_ID } from '../../routes/public-changelog'
import { insertObject, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: publicChangelogRoutes } = await import('../../routes/public-changelog')

function createApp() {
	return createIntegrationApp({ path: '/v1', module: publicChangelogRoutes })
}

describe('Public changelog integration', () => {
	beforeEach(async () => {
		// The route hardcodes this workspace id by contract — recreate it fresh
		// per test so the FK on objects.workspace_id resolves.
		await insertWorkspace(db, getTestActorId(), { id: SINDRE_AI_PUBLIC_WORKSPACE_ID })
	})

	it('serves only published changelog_entry rows from the public workspace', async () => {
		const otherWorkspace = await insertWorkspace(db, getTestActorId())

		const published = await insertObject(db, SINDRE_AI_PUBLIC_WORKSPACE_ID, getTestActorId(), {
			type: 'changelog_entry',
			status: 'published',
			title: 'Public, published entry',
			metadata: { tag: 'New' },
		})
		await insertObject(db, SINDRE_AI_PUBLIC_WORKSPACE_ID, getTestActorId(), {
			type: 'changelog_entry',
			status: 'draft',
			title: 'Draft entry — must not leak',
			metadata: { tag: 'New' },
		})
		await insertObject(db, SINDRE_AI_PUBLIC_WORKSPACE_ID, getTestActorId(), {
			type: 'changelog_entry',
			status: 'approved',
			title: 'Approved entry — must not leak',
			metadata: { tag: 'New' },
		})
		await insertObject(db, otherWorkspace.id, getTestActorId(), {
			type: 'changelog_entry',
			status: 'published',
			title: 'Other workspace entry — must not leak',
			metadata: { tag: 'New' },
		})
		// Same workspace and status, different object type — proves the type
		// filter is load-bearing too, not just workspace + status.
		await insertObject(db, SINDRE_AI_PUBLIC_WORKSPACE_ID, getTestActorId(), {
			type: 'task',
			status: 'published',
			title: 'Wrong-type row — must not leak',
		})

		const res = await createApp().request(jsonGet('/v1/changelog'))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { entries: Array<{ id: string; title: string }> }

		expect(body.entries).toHaveLength(1)
		expect(body.entries[0].id).toBe(published.id)
		expect(body.entries[0].title).toBe('Public, published entry')
	})

	it('returns an empty feed when the public workspace has no published entries', async () => {
		await insertObject(db, SINDRE_AI_PUBLIC_WORKSPACE_ID, getTestActorId(), {
			type: 'changelog_entry',
			status: 'draft',
			title: 'Still drafting',
		})

		const res = await createApp().request(jsonGet('/v1/changelog'))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { entries: unknown[] }
		expect(body.entries).toEqual([])
	})
})
