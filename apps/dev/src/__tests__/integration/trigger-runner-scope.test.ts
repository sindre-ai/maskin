import { queryCronScopeMatches } from '../../services/trigger-runner'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Integration proof for T7's cron scope filter — mocked-DB unit tests can't
// catch a mis-cast on `metadata->>'review_by'`::timestamptz or the JSONB
// coercion pitfall documented in `.claude/rules/known-pitfalls.md`.
//
// DoD points verified end-to-end against real Postgres:
//  - a `knowledge` object with `doc_type: profile` and a past `review_by`
//    is returned by the scope query
//  - a `knowledge` object with `doc_type: profile` and a future `review_by`
//    is excluded
//  - a `knowledge` object with a different `doc_type` is excluded
//  - a non-`knowledge` object is excluded
//  - the workspace filter isolates results across workspaces
describe('T7 — Weekly Profile Review Sweep scope query (integration)', () => {
	it('returns only knowledge/profile rows whose review_by is in the past, scoped to the workspace', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const otherWs = await insertWorkspace(db, getTestActorId())

		const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
		const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

		const staleProfile = await insertObject(db, ws.id, getTestActorId(), {
			type: 'knowledge',
			title: 'About this company',
			metadata: { doc_type: 'profile', review_by: past },
		})
		await insertObject(db, ws.id, getTestActorId(), {
			type: 'knowledge',
			title: 'Fresh profile',
			metadata: { doc_type: 'profile', review_by: future },
		})
		await insertObject(db, ws.id, getTestActorId(), {
			type: 'knowledge',
			title: 'Stale topic page',
			metadata: { doc_type: 'topic_page', review_by: past },
		})
		await insertObject(db, ws.id, getTestActorId(), {
			type: 'bet',
			title: 'Stale bet',
			metadata: { doc_type: 'profile', review_by: past },
		})
		// Cross-workspace row with the same shape — must not leak in.
		await insertObject(db, otherWs.id, getTestActorId(), {
			type: 'knowledge',
			title: 'Other workspace stale profile',
			metadata: { doc_type: 'profile', review_by: past },
		})

		const matches = await queryCronScopeMatches(
			db,
			ws.id,
			{
				entity_type: 'knowledge',
				metadata_eq: { doc_type: 'profile' },
				metadata_before_now: 'review_by',
			},
			100,
		)

		expect(matches).toHaveLength(1)
		expect(matches[0].id).toBe(staleProfile.id)
		expect(matches[0].title).toBe('About this company')
	})

	it('returns 0 rows when no profiles are stale', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
		await insertObject(db, ws.id, getTestActorId(), {
			type: 'knowledge',
			title: 'Fresh profile',
			metadata: { doc_type: 'profile', review_by: future },
		})

		const matches = await queryCronScopeMatches(
			db,
			ws.id,
			{
				entity_type: 'knowledge',
				metadata_eq: { doc_type: 'profile' },
				metadata_before_now: 'review_by',
			},
			100,
		)

		expect(matches).toHaveLength(0)
	})
})
