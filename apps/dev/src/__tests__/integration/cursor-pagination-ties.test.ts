// Cursor walks over rows that share one microsecond-precision `created_at`.
//
// A bulk insert stamps every row with the same `now()`, which Postgres keeps to
// the microsecond. The cursor round-trips through a JS Date (milliseconds), so
// a seek that compares the raw column to the cursor skips or replays the tied
// rows. This walks 120 tied rows per endpoint at three page sizes and asserts
// every id comes back exactly once. Fails on the raw-column comparison.

import { files, triggers, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import { sql as dsql } from 'drizzle-orm'
import {
	buildFile,
	buildTrigger,
	buildWorkspaceSkill,
	insertActor,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: triggersRoutes } = await import('../../routes/triggers')
const { default: filesRoutes } = await import('../../routes/files')
const { default: workspaceSkillsRoutes } = await import('../../routes/workspace-skills')

const ROW_COUNT = 120
const LIMITS = [100, 25, 7]
const ORDERS = ['desc', 'asc'] as const
// Sub-millisecond digits: a JS Date cannot carry them, Postgres keeps them.
const TIED_AT = '2026-03-10T00:00:00.123456Z'
const SNAPSHOT_AT = '2026-03-11T00:00:00.000Z'

type Row = { id: string; createdAt: string }

async function walk(
	app: ReturnType<typeof createIntegrationApp>,
	path: string,
	headers: Record<string, string>,
	limit: number,
	order: (typeof ORDERS)[number],
): Promise<string[]> {
	const ids: string[] = []
	let cursor = ''
	// A walk that never terminates is itself a failure; cap the pages.
	for (let page = 0; page < ROW_COUNT * 2; page++) {
		const url = `${path}?limit=${limit}&order=${order}&snapshot_at=${encodeURIComponent(SNAPSHOT_AT)}${cursor}`
		const res = await app.request(jsonGet(url, headers))
		expect(res.status).toBe(200)
		const rows = (await res.json()) as Row[]
		ids.push(...rows.map((r) => r.id))
		if (rows.length < limit) return ids
		const last = rows[rows.length - 1]
		cursor = `&cursor_created_at=${encodeURIComponent(last.createdAt)}&cursor_id=${encodeURIComponent(last.id)}`
	}
	return ids
}

async function expectEveryIdOnce(
	app: ReturnType<typeof createIntegrationApp>,
	path: string,
	headers: Record<string, string>,
	seededIds: string[],
) {
	for (const order of ORDERS) {
		for (const limit of LIMITS) {
			const walked = await walk(app, path, headers, limit, order)
			expect(walked, `${order} walk at limit ${limit}`).toHaveLength(seededIds.length)
			expect([...walked].sort()).toEqual([...seededIds].sort())
		}
	}
}

describe('Cursor pagination — rows tied on a sub-millisecond created_at', () => {
	it('list_workspace_skills returns every skill once', async () => {
		const app = createIntegrationApp({ path: '/api/workspaces', module: workspaceSkillsRoutes })
		const ws = await insertWorkspace(db, getTestActorId())
		const rows = Array.from({ length: ROW_COUNT }, (_, i) =>
			buildWorkspaceSkill({
				workspaceId: ws.id,
				name: `tied-skill-${String(i).padStart(3, '0')}`,
				createdBy: getTestActorId(),
			}),
		)
		await db.insert(workspaceSkills).values(rows)
		const ids = rows.map((r) => r.id)
		await db.execute(
			dsql`update workspace_skills set created_at = ${TIED_AT}::timestamptz where workspace_id = ${ws.id}`,
		)

		await expectEveryIdOnce(app, `/api/workspaces/${ws.id}/skills`, {}, ids)
	})

	it('list_actors returns every member once', async () => {
		const app = createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
		const ws = await insertWorkspace(db, getTestActorId())
		const ids: string[] = []
		for (let i = 0; i < ROW_COUNT; i++) {
			const actor = await insertActor(db, { type: 'agent', name: `Tied actor ${i}` })
			ids.push(actor.id)
		}
		await db
			.insert(workspaceMembers)
			.values(ids.map((actorId) => ({ workspaceId: ws.id, actorId, role: 'member' })))
		await db.execute(
			dsql`update actors set created_at = ${TIED_AT}::timestamptz where id in (${dsql.join(
				ids.map((id) => dsql`${id}::uuid`),
				dsql`, `,
			)})`,
		)

		await expectEveryIdOnce(app, '/api/actors', { 'x-workspace-id': ws.id }, ids)
	})

	it('list_triggers returns every trigger once', async () => {
		const app = createIntegrationApp({ path: '/api/triggers', module: triggersRoutes })
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, { type: 'agent', name: 'Tied trigger agent' })
		const rows = Array.from({ length: ROW_COUNT }, (_, i) =>
			buildTrigger({
				workspaceId: ws.id,
				targetActorId: agent.id,
				createdBy: getTestActorId(),
				name: `Tied trigger ${i}`,
			}),
		)
		await db.insert(triggers).values(rows)
		await db.execute(
			dsql`update triggers set created_at = ${TIED_AT}::timestamptz where workspace_id = ${ws.id}`,
		)

		await expectEveryIdOnce(
			app,
			'/api/triggers',
			{ 'x-workspace-id': ws.id },
			rows.map((r) => r.id),
		)
	})

	it('list_files returns every file once', async () => {
		const app = createIntegrationApp({ path: '/api/files', module: filesRoutes })
		const ws = await insertWorkspace(db, getTestActorId())
		const rows = Array.from({ length: ROW_COUNT }, (_, i) =>
			buildFile({
				workspaceId: ws.id,
				createdBy: getTestActorId(),
				name: `tied-file-${i}.md`,
			}),
		)
		await db.insert(files).values(rows)
		await db.execute(
			dsql`update files set created_at = ${TIED_AT}::timestamptz where workspace_id = ${ws.id}`,
		)

		await expectEveryIdOnce(
			app,
			'/api/files',
			{ 'x-workspace-id': ws.id },
			rows.map((r) => r.id),
		)
	})
})
