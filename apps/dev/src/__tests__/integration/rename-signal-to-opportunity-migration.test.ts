import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { events, actors, objects, triggers, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertActor, insertObject, insertTrigger, insertWorkspace } from '../factories'
import { db, sql } from './global-setup'

const here = dirname(fileURLToPath(import.meta.url))
const drizzleDir = join(here, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
const UP = '0113_rename_bet_status_signal_to_opportunity.sql'

async function runMigration() {
	const content = readFileSync(join(drizzleDir, UP), 'utf-8')
	for (const statement of splitStatements(content)) await sql.unsafe(statement)
}

const STATUS_PROMPT =
	'Stage bets in `signal`. A human moves a bet `signal → define`. Search status=signal. ' +
	'Dispatch: **signal** stand down. Never promote a signal-stage bet.'
const MIGRATED_PROMPT =
	'Stage bets in `opportunity`. A human moves a bet `opportunity → define`. Search status=opportunity. ' +
	'Dispatch: **opportunity** stand down. Never promote an opportunity-stage bet.'
const SKILL_DESCRIPTION = 'Move a bet from `signal`'
// Plain English and agent names must survive.
const UNRELATED = 'You are the Signal Analyst. Filter signal from noise; the strongest signal wins.'

describe('migration 0113_rename_bet_status_signal_to_opportunity (Integration)', () => {
	it('renames bets, workspace statuses, triggers, prompts and skills, leaves everything else, and is idempotent', async () => {
		const owner = await insertActor(db, { type: 'human' })
		const agent = await insertActor(db, {
			type: 'agent',
			systemPrompt: `${STATUS_PROMPT}\n${UNRELATED}`,
			description: 'Stages `signal` bets',
		})
		const ws = await insertWorkspace(db, owner.id, {
			settings: {
				statuses: {
					bet: ['signal', 'define', 'active'],
					task: ['todo', 'done'],
				},
			},
		})
		const customWs = await insertWorkspace(db, owner.id, {
			settings: { statuses: { bet: ['active', 'signal', 'opportunity', 'live'] } },
		})
		const untouchedWs = await insertWorkspace(db, owner.id, {
			settings: { statuses: { bet: ['define', 'active'] } },
		})

		const signalBet = await insertObject(db, ws.id, owner.id, { type: 'bet', status: 'signal' })
		const activeBet = await insertObject(db, ws.id, owner.id, { type: 'bet', status: 'active' })
		// `signal` on another type is not the bet status and must not move.
		const otherType = await insertObject(db, ws.id, owner.id, { type: 'insight', status: 'signal' })

		const trigger = await insertTrigger(db, ws.id, owner.id, agent.id, {
			config: { entity_type: 'bet', action: 'status_changed', from_status: 'signal' },
			actionPrompt: STATUS_PROMPT,
		})
		const plainTrigger = await insertTrigger(db, ws.id, owner.id, agent.id, {
			actionPrompt: UNRELATED,
		})
		await sql`
			INSERT INTO workspace_skills (workspace_id, name, description, content, storage_key, size_bytes)
			VALUES (${ws.id}, 'shape-bets', ${SKILL_DESCRIPTION}, ${STATUS_PROMPT}, 'k/shape-bets', 1)`

		await runMigration()

		// 1. Bets: moved, audited, other rows untouched.
		const [moved] = await db.select().from(objects).where(eq(objects.id, signalBet.id))
		expect(moved.status).toBe('opportunity')
		const [stillActive] = await db.select().from(objects).where(eq(objects.id, activeBet.id))
		expect(stillActive.status).toBe('active')
		const [insight] = await db.select().from(objects).where(eq(objects.id, otherType.id))
		expect(insight.status).toBe('signal')

		const logged = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, signalBet.id), eq(events.action, 'updated')))
		expect(logged).toHaveLength(1)
		expect(logged[0].data).toMatchObject({
			changes: [{ field: 'status', old: 'signal', new: 'opportunity' }],
		})

		// 2. Workspace status lists: renamed in place, deduped, others untouched.
		const settingsOf = async (id: string) => {
			const [row] = await db
				.select({ settings: workspaces.settings })
				.from(workspaces)
				.where(eq(workspaces.id, id))
			return row.settings as { statuses: Record<string, string[]> }
		}
		expect((await settingsOf(ws.id)).statuses).toEqual({
			bet: ['opportunity', 'define', 'active'],
			task: ['todo', 'done'],
		})
		expect((await settingsOf(customWs.id)).statuses.bet).toEqual(['active', 'opportunity', 'live'])
		expect((await settingsOf(untouchedWs.id)).statuses.bet).toEqual(['define', 'active'])

		// 3. Triggers: filter value and prompt text.
		const [migratedTrigger] = await db.select().from(triggers).where(eq(triggers.id, trigger.id))
		expect(migratedTrigger.config).toMatchObject({ from_status: 'opportunity' })
		expect(migratedTrigger.actionPrompt).toBe(MIGRATED_PROMPT)
		const [plain] = await db.select().from(triggers).where(eq(triggers.id, plainTrigger.id))
		expect(plain.actionPrompt).toBe(UNRELATED)

		// 4. Agent prompt: status references renamed, name and plain word kept.
		const [migratedAgent] = await db.select().from(actors).where(eq(actors.id, agent.id))
		expect(migratedAgent.systemPrompt).toBe(`${MIGRATED_PROMPT}\n${UNRELATED}`)
		expect(migratedAgent.description).toBe('Stages `opportunity` bets')

		// 5. Workspace skill.
		const [skill] = await sql<{ description: string; content: string }[]>`
			SELECT description, content FROM workspace_skills WHERE workspace_id = ${ws.id}`
		expect(skill.description).toBe('Move a bet from `opportunity`')
		expect(skill.content).toBe(MIGRATED_PROMPT)

		// Second run: nothing changes, nothing is logged again.
		const snapshot = async () => ({
			objects:
				await sql`SELECT id, status, updated_at FROM objects WHERE workspace_id = ${ws.id} ORDER BY id`,
			events: await sql`SELECT count(*)::int AS n FROM events WHERE entity_id = ${signalBet.id}`,
			workspaces:
				await sql`SELECT id, settings FROM workspaces WHERE id IN (${ws.id}, ${customWs.id}) ORDER BY id`,
			triggers:
				await sql`SELECT id, config, action_prompt FROM triggers WHERE workspace_id = ${ws.id} ORDER BY id`,
		})
		const before = await snapshot()
		await runMigration()
		expect(await snapshot()).toEqual(before)

		// Nothing in the migrated workspace still carries the old status.
		const leftovers = await sql`
			SELECT id FROM objects WHERE workspace_id = ${ws.id} AND type = 'bet' AND status = 'signal'`
		expect(leftovers).toHaveLength(0)
	})
})
