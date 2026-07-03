import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { actors } from '@maskin/db/schema'
import { MENTION_DISCIPLINE } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { insertActor } from '../factories'
import { db, sql } from './global-setup'

// packages/db/drizzle/0034_backfill_actor_mention_discipline.sql already ran
// once against an empty `actors` table during global-setup's initial
// migration replay, so there is no un-backfilled row left to observe by the
// time these tests run. To actually exercise the migration's UPDATE (rather
// than just its already-applied effect), each test inserts a fresh actor in
// a "pre-migration" state and re-runs the migration file's raw SQL directly
// — mirroring how global-setup.ts itself applies migrations.
const migrationPath = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
	'..',
	'..',
	'packages',
	'db',
	'drizzle',
	'0034_backfill_actor_mention_discipline.sql',
)
const migrationSql = readFileSync(migrationPath, 'utf-8')

async function runMigration() {
	await sql.unsafe(migrationSql)
}

async function readSystemPrompt(actorId: string) {
	const [row] = await db.select().from(actors).where(eq(actors.id, actorId))
	return row?.systemPrompt ?? null
}

describe('0034_backfill_actor_mention_discipline migration', () => {
	it('appends MENTION_DISCIPLINE to an agent system_prompt that lacks it', async () => {
		const original = 'You are a helpful test agent. Do the thing.'
		const agent = await insertActor(db, { type: 'agent', systemPrompt: original })

		await runMigration()

		const updated = await readSystemPrompt(agent.id)
		// Locks the migration's literal SQL text in lockstep with the shared
		// MENTION_DISCIPLINE constant — if a future edit changes the constant
		// without updating this immutable migration file, this assertion fails
		// because the two diverge.
		expect(updated).toBe(`${original}\n\n${MENTION_DISCIPLINE}`)
	})

	it('is idempotent — running it twice does not double-append', async () => {
		const original = 'You are a helpful test agent.'
		const agent = await insertActor(db, { type: 'agent', systemPrompt: original })

		await runMigration()
		const afterFirst = await readSystemPrompt(agent.id)

		await runMigration()
		const afterSecond = await readSystemPrompt(agent.id)

		expect(afterSecond).toBe(afterFirst)
		expect(afterSecond?.match(/Mention discipline:/g)).toHaveLength(1)
	})

	it('skips an agent whose system_prompt already contains the rule', async () => {
		const alreadyPatched = `You are a helpful test agent.\n\n${MENTION_DISCIPLINE}`
		const agent = await insertActor(db, { type: 'agent', systemPrompt: alreadyPatched })

		await runMigration()

		const updated = await readSystemPrompt(agent.id)
		expect(updated).toBe(alreadyPatched)
	})

	it('does not touch a human actor', async () => {
		const original = 'Some human-authored note, not a system prompt.'
		const human = await insertActor(db, { type: 'human', systemPrompt: original })

		await runMigration()

		const updated = await readSystemPrompt(human.id)
		expect(updated).toBe(original)
	})

	it('skips an agent with a NULL system_prompt without erroring', async () => {
		const agent = await insertActor(db, { type: 'agent', systemPrompt: null })

		await expect(runMigration()).resolves.not.toThrow()

		const updated = await readSystemPrompt(agent.id)
		expect(updated).toBeNull()
	})
})
