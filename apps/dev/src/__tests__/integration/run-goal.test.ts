import { sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { buildRunGoalBlock, saveRunGoal } from '../../services/run-goal'
import {
	insertActor,
	insertObject,
	insertRelationship,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db } from './global-setup'

const FRONTEND = 'https://maskin.io'

describe('run goal block (integration)', () => {
	it('finds the loop through its trigger_ids and through an in_loop edge, against real jsonb', async () => {
		const actor = await insertActor(db)
		const workspace = await insertWorkspace(db, actor.id)
		const trigger = await insertTrigger(db, workspace.id, actor.id, actor.id)
		const task = await insertObject(db, workspace.id, actor.id, {
			type: 'task',
			title: 'Ship it',
			content: '## Done when\n\n- Shipped',
		})
		const viaTrigger = await insertObject(db, workspace.id, actor.id, {
			type: 'loop',
			title: 'Trigger loop',
			metadata: { trigger_ids: ['00000000-0000-0000-0000-000000000000', trigger.id] },
		})
		const viaEdge = await insertObject(db, workspace.id, actor.id, {
			type: 'loop',
			title: 'Edge loop',
			metadata: { trigger_ids: [] },
		})
		await insertObject(db, workspace.id, actor.id, {
			type: 'loop',
			title: 'Unrelated loop',
			metadata: { trigger_ids: ['11111111-1111-1111-1111-111111111111'] },
		})
		await insertRelationship(db, actor.id, {
			sourceType: 'object',
			sourceId: viaEdge.id,
			targetType: 'object',
			targetId: task.id,
			type: 'in_loop',
		})

		const block = await buildRunGoalBlock(
			db,
			{ workspaceId: workspace.id, triggerId: trigger.id, initiatedFromObjectId: task.id },
			FRONTEND,
		)

		expect(block).toContain('> - Shipped')
		expect(block).toContain(`[Trigger loop](${FRONTEND}/${workspace.id}/objects/${viaTrigger.id})`)
		expect(block).toContain(`[Edge loop](${FRONTEND}/${workspace.id}/objects/${viaEdge.id})`)
		expect(block).not.toContain('Unrelated loop')
	})

	it('does not read an object from another workspace', async () => {
		const actor = await insertActor(db)
		const workspace = await insertWorkspace(db, actor.id)
		const otherWorkspace = await insertWorkspace(db, actor.id)
		const foreign = await insertObject(db, otherWorkspace.id, actor.id, {
			type: 'task',
			title: 'Foreign',
			content: '## Done when\n\n- Secret',
		})

		const block = await buildRunGoalBlock(
			db,
			{ workspaceId: workspace.id, triggerId: null, initiatedFromObjectId: foreign.id },
			FRONTEND,
		)

		expect(block).not.toContain('Secret')
		expect(block).toContain('The instruction that follows this block is your goal')
	})

	it('saves the block as a merge, keeps other config keys, and never overwrites the first save', async () => {
		const actor = await insertActor(db)
		const workspace = await insertWorkspace(db, actor.id)
		const session = await insertSession(db, workspace.id, actor.id, actor.id, {
			config: { llm_route: 'claude_oauth' },
		})

		await saveRunGoal(db, session.id, 'first block')
		await saveRunGoal(db, session.id, 'second block')

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.config).toEqual({ llm_route: 'claude_oauth', run_goal: 'first block' })
	})
})
