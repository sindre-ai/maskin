import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertActor, insertWorkspace } from '../factories'
import { db, sql } from './global-setup'

// Resolve the migration SQL once at module load
const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationPath = join(
	__dirname,
	'..',
	'..',
	'..',
	'..',
	'..',
	'packages',
	'db',
	'drizzle',
	'0014_workspace_backlog_status.sql',
)
const migrationSql = readFileSync(migrationPath, 'utf-8')

// The migration runs once during global-setup. Each test seeds rows with the
// pre-migration shape, then re-applies the migration SQL to exercise it.
async function applyMigration() {
	await sql.unsafe(migrationSql)
}

async function getStatuses(workspaceId: string): Promise<string[] | undefined> {
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
	const settings = row.settings as { statuses?: { task?: string[] } }
	return settings.statuses?.task
}

describe('migration 0014 — backlog in settings.statuses.task', () => {
	it('prepends backlog to a workspace whose task array lacks it', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: {
				statuses: {
					task: ['todo', 'in_progress', 'in_review', 'testing', 'done', 'blocked'],
				},
			},
		})

		await applyMigration()

		expect(await getStatuses(ws.id)).toEqual([
			'backlog',
			'todo',
			'in_progress',
			'in_review',
			'testing',
			'done',
			'blocked',
		])
	})

	it('leaves a workspace alone if backlog is already present', async () => {
		const actor = await insertActor(db)
		const initial = ['backlog', 'todo', 'in_progress', 'done', 'blocked']
		const ws = await insertWorkspace(db, actor.id, {
			settings: { statuses: { task: initial } },
		})

		await applyMigration()

		expect(await getStatuses(ws.id)).toEqual(initial)
	})

	it('is idempotent — running twice produces the same result as once', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: { statuses: { task: ['todo', 'in_progress', 'done', 'blocked'] } },
		})

		await applyMigration()
		const afterFirst = await getStatuses(ws.id)
		await applyMigration()
		const afterSecond = await getStatuses(ws.id)

		expect(afterFirst).toEqual(['backlog', 'todo', 'in_progress', 'done', 'blocked'])
		expect(afterSecond).toEqual(afterFirst)
	})

	it('does not touch workspaces whose settings have no task-status array', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: { statuses: { bet: ['signal', 'active'] } },
		})

		await applyMigration()

		// task array still absent — Zod default fills it in at runtime
		expect(await getStatuses(ws.id)).toBeUndefined()
		// statuses object intact
		const [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id))
		const settings = row.settings as { statuses: { bet: string[] } }
		expect(settings.statuses.bet).toEqual(['signal', 'active'])
	})
})
