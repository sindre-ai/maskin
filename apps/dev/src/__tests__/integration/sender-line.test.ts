import { describe, expect, it } from 'vitest'
import { loadSenderLine } from '../../services/workspace-briefing'
import { insertActor } from '../factories'
import { db } from './global-setup'

describe('loadSenderLine (real Postgres)', () => {
	it('names an agent actor as another agent', async () => {
		const actor = await insertActor(db, { name: 'Planner', type: 'agent' })
		const line = await loadSenderLine(db, actor.id)
		expect(line).toContain('Sent by Planner, another agent.')
		expect(line).toContain('not from a person')
	})

	it('names a human actor as a person', async () => {
		const actor = await insertActor(db, { name: 'Magnus', type: 'human' })
		expect(await loadSenderLine(db, actor.id)).toBe('Sent by Magnus, a person.')
	})

	it('returns an empty string for an unknown actor', async () => {
		expect(await loadSenderLine(db, '00000000-0000-4000-8000-000000000000')).toBe('')
	})
})
