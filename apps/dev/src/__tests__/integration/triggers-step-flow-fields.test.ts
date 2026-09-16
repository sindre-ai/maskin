import { triggers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { insertActor, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * D6a — Extend LoopStep (i.e. the `triggers` row) with three nullable fields
 * the Loops v4 vertical-story renderer (D6c) and the escalation reconciler
 * (D6b) both read from. This task is expand-only — no consumer code reads the
 * fields yet — so the test asserts:
 *   (1) an existing-style insert (no new fields specified) leaves all three
 *       columns NULL, i.e. the migration is backward compatible;
 *   (2) an insert that sets all three columns round-trips them exactly, so
 *       downstream D6b + D6c can rely on the schema when they wire up.
 *
 * Migration is `packages/db/drizzle/0067_triggers_step_flow_fields.sql`;
 * `global-setup.ts` replays every migration on a fresh schema at test-suite
 * boot, so a missing / broken migration file surfaces here as a column-not-
 * found on the `.set()` call rather than as a silent success.
 */
describe('triggers — Loops v4 step-flow fields (D6a)', () => {
	let workspaceId: string
	let targetActorId: string
	let handsOffToActorId: string
	let escalatesToActorId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const target = await insertActor(db, { type: 'agent', name: 'Target Agent' })
		targetActorId = target.id
		const handsOff = await insertActor(db, { type: 'agent', name: 'Downstream Agent' })
		handsOffToActorId = handsOff.id
		const escalates = await insertActor(db, { type: 'human', name: 'Escalation Owner' })
		escalatesToActorId = escalates.id
	})

	it('leaves all three new columns null when inserted without them (existing rows shape)', async () => {
		const row = await insertTrigger(db, workspaceId, getTestActorId(), targetActorId)
		const [read] = await db
			.select({
				handsOffToActorId: triggers.handsOffToActorId,
				escalatesToActorId: triggers.escalatesToActorId,
				escalateAfterMs: triggers.escalateAfterMs,
			})
			.from(triggers)
			.where(eq(triggers.id, row.id))
		expect(read.handsOffToActorId).toBeNull()
		expect(read.escalatesToActorId).toBeNull()
		expect(read.escalateAfterMs).toBeNull()
	})

	it('round-trips all three fields when set on insert', async () => {
		const row = await insertTrigger(db, workspaceId, getTestActorId(), targetActorId, {
			handsOffToActorId,
			escalatesToActorId,
			escalateAfterMs: 43_200_000,
		})
		const [read] = await db
			.select({
				handsOffToActorId: triggers.handsOffToActorId,
				escalatesToActorId: triggers.escalatesToActorId,
				escalateAfterMs: triggers.escalateAfterMs,
			})
			.from(triggers)
			.where(eq(triggers.id, row.id))
		expect(read.handsOffToActorId).toBe(handsOffToActorId)
		expect(read.escalatesToActorId).toBe(escalatesToActorId)
		expect(read.escalateAfterMs).toBe(43_200_000)
	})

	it('enforces the actor FK on hands_off_to_actor_id', async () => {
		await expect(
			insertTrigger(db, workspaceId, getTestActorId(), targetActorId, {
				handsOffToActorId: '11111111-1111-1111-1111-111111111111',
			}),
		).rejects.toThrow()
	})

	it('enforces the actor FK on escalates_to_actor_id', async () => {
		await expect(
			insertTrigger(db, workspaceId, getTestActorId(), targetActorId, {
				escalatesToActorId: '11111111-1111-1111-1111-111111111111',
			}),
		).rejects.toThrow()
	})
})
