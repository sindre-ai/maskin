import {
	DEFAULT_AGENTS,
	SIGNUP_CAPTURE_SOURCE,
	SIGNUP_RESEARCH_SOURCE,
	STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER_NAME,
} from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { seedDefaultAgents } from '../../services/seed-default-agents'
import { createTestContext } from '../setup'

describe('seedDefaultAgents', () => {
	it('inserts the trio + the Strategist research-on-signup trigger on a fresh workspace', async () => {
		const { db, mockResults, calls } = createTestContext()
		// First select = existing trio (none). Second select = existing trigger (none).
		mockResults.selectQueue = [[], []]
		mockResults.insertQueue = [
			[{ id: 'driver-id' }],
			[{}],
			[{ id: 'coach-id' }],
			[{}],
			[{ id: 'strategist-id' }],
			[{}],
			[{ id: 'trigger-id' }],
		]

		await seedDefaultAgents(db, 'ws-1', 'creator-1')

		// 3 actor inserts + 3 member inserts + 1 trigger insert.
		expect(calls.inserts).toHaveLength(7)
		const actorInserts = [calls.inserts[0], calls.inserts[2], calls.inserts[4]] as Array<{
			name?: string
			isSystem?: boolean
			type?: string
			apiKey?: string
			createdBy?: string
		}>
		expect(actorInserts.map((i) => i.name)).toEqual(DEFAULT_AGENTS.map((a) => a.name))
		expect(actorInserts.every((i) => i.type === 'agent')).toBe(true)
		expect(actorInserts.every((i) => i.isSystem === true)).toBe(true)
		expect(actorInserts.every((i) => i.createdBy === 'creator-1')).toBe(true)
		const keys = actorInserts.map((i) => i.apiKey)
		expect(keys.every((k) => typeof k === 'string' && k.startsWith('ank_'))).toBe(true)
		expect(new Set(keys).size).toBe(3)

		const trigger = calls.inserts[6] as {
			workspaceId?: string
			name?: string
			type?: string
			config?: { entity_type?: string; action?: string; conditions?: unknown }
			actionPrompt?: string
			targetActorId?: string
			enabled?: boolean
			createdBy?: string
		}
		expect(trigger.workspaceId).toBe('ws-1')
		expect(trigger.name).toBe(STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER_NAME)
		expect(trigger.type).toBe('event')
		expect(trigger.targetActorId).toBe('strategist-id')
		expect(trigger.createdBy).toBe('creator-1')
		expect(trigger.enabled).toBe(true)
		expect(trigger.config?.entity_type).toBe('knowledge')
		expect(trigger.config?.action).toBe('created')
		expect(trigger.config?.conditions).toEqual([
			{ field: 'source', operator: 'equals', value: SIGNUP_CAPTURE_SOURCE },
		])
		// Action prompt must name the ship-metric tag so the Strategist writes it.
		expect(trigger.actionPrompt).toContain(SIGNUP_RESEARCH_SOURCE)
	})

	it('is idempotent: skips actor inserts and trigger when both already seated', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			[
				{ id: 'driver-id', name: 'Driver' },
				{ id: 'coach-id', name: 'Coach' },
				{ id: 'strategist-id', name: 'Strategist' },
			],
			[{ id: 'trigger-id' }],
		]

		await seedDefaultAgents(db, 'ws-1', 'creator-1')

		expect(calls.inserts).toHaveLength(0)
	})

	it('skips only the trio members already present', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			[{ id: 'coach-id', name: 'Coach' }],
			[], // no existing trigger
		]
		mockResults.insertQueue = [
			[{ id: 'driver-id' }],
			[{}],
			[{ id: 'strategist-id' }],
			[{}],
			[{ id: 'trigger-id' }],
		]

		await seedDefaultAgents(db, 'ws-1', 'creator-1')

		expect(calls.inserts).toHaveLength(5)
		const actorInserts = [calls.inserts[0], calls.inserts[2]] as Array<{ name?: string }>
		expect(actorInserts.map((i) => i.name)).toEqual(['Driver', 'Strategist'])
		const trigger = calls.inserts[4] as { targetActorId?: string }
		expect(trigger.targetActorId).toBe('strategist-id')
	})

	it('targets the pre-existing Strategist when the trio is already seated but the trigger is missing', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			[
				{ id: 'driver-id', name: 'Driver' },
				{ id: 'coach-id', name: 'Coach' },
				{ id: 'strategist-existing', name: 'Strategist' },
			],
			[], // no existing trigger
		]
		mockResults.insertQueue = [[{ id: 'trigger-id' }]]

		await seedDefaultAgents(db, 'ws-1', 'creator-1')

		expect(calls.inserts).toHaveLength(1)
		const trigger = calls.inserts[0] as { targetActorId?: string; name?: string }
		expect(trigger.name).toBe(STRATEGIST_RESEARCH_ON_SIGNUP_TRIGGER_NAME)
		expect(trigger.targetActorId).toBe('strategist-existing')
	})

	it('throws when an actor insert returns empty', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[]]
		mockResults.insertQueue = [[]] // Driver actor insert returns empty

		await expect(seedDefaultAgents(db, 'ws-1', 'creator-1')).rejects.toThrow(/Driver/)
	})
})
