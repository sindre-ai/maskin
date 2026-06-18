import { DEFAULT_AGENTS } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { seedDefaultAgents } from '../../services/seed-default-agents'
import { createTestContext } from '../setup'

describe('seedDefaultAgents', () => {
	it('inserts all three default agents + member rows on a fresh workspace', async () => {
		const { db, mockResults, calls } = createTestContext()
		// No existing trio members → seeder should insert all three.
		mockResults.select = []
		mockResults.insertQueue = [
			[{ id: 'driver-id' }],
			[{}],
			[{ id: 'coach-id' }],
			[{}],
			[{ id: 'strategist-id' }],
			[{}],
		]

		await seedDefaultAgents(db, 'ws-1', 'creator-1')

		// 3 actor inserts + 3 member inserts.
		expect(calls.inserts).toHaveLength(6)
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
		// Each gets its own ank_-prefixed key.
		const keys = actorInserts.map((i) => i.apiKey)
		expect(keys.every((k) => typeof k === 'string' && k.startsWith('ank_'))).toBe(true)
		expect(new Set(keys).size).toBe(3)
	})

	it('is idempotent: skips any trio member already seated on the workspace', async () => {
		const { db, mockResults, calls } = createTestContext()
		// All three already seated → seeder should make zero inserts.
		mockResults.select = [{ name: 'Driver' }, { name: 'Coach' }, { name: 'Strategist' }]

		await seedDefaultAgents(db, 'ws-1', 'creator-1')

		expect(calls.inserts).toHaveLength(0)
	})

	it('skips only the trio members already present', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.select = [{ name: 'Coach' }]
		mockResults.insertQueue = [[{ id: 'driver-id' }], [{}], [{ id: 'strategist-id' }], [{}]]

		await seedDefaultAgents(db, 'ws-1', 'creator-1')

		expect(calls.inserts).toHaveLength(4)
		const actorInserts = [calls.inserts[0], calls.inserts[2]] as Array<{ name?: string }>
		expect(actorInserts.map((i) => i.name)).toEqual(['Driver', 'Strategist'])
	})

	it('throws when an actor insert returns empty', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = []
		mockResults.insertQueue = [[]] // Driver actor insert returns empty

		await expect(seedDefaultAgents(db, 'ws-1', 'creator-1')).rejects.toThrow(/Driver/)
	})
})
