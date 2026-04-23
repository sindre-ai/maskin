import type { Database } from '@maskin/db'
import { describe, expect, it } from 'vitest'
import { buildObjectiveContext } from '../../../lib/agents/objective-context'

/**
 * Build a mock Database that resolves each select() call with the next preset response.
 * Handlers follow the exact order buildObjectiveContext issues its queries in:
 *   1. Fetch the target object
 *   2. Parent `breaks_into` edge
 *   3. Parent object (if edge existed)
 *   4. Participant edges
 *   5. Participant actors (if any)
 *   6. Recent comment events
 *   7. Comment author actors (if any comments)
 */
function mockDb(responses: unknown[][]) {
	const queue = [...responses]
	const next = () => queue.shift() ?? []
	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => ({
						// biome-ignore lint/suspicious/noThenProperty: mock needs .then for Drizzle's await
						then: (resolve: (v: unknown) => void) => resolve(next()),
					}),
					orderBy: () => ({
						limit: () => ({
							// biome-ignore lint/suspicious/noThenProperty: mock needs .then for Drizzle's await
							then: (resolve: (v: unknown) => void) => resolve(next()),
						}),
					}),
					// biome-ignore lint/suspicious/noThenProperty: mock needs .then for Drizzle's await
					then: (resolve: (v: unknown) => void) => resolve(next()),
				}),
			}),
		}),
	}
	return db as unknown as Database
}

describe('buildObjectiveContext', () => {
	const objectId = '00000000-0000-0000-0000-000000000001'
	const betId = '00000000-0000-0000-0000-000000000002'
	const alice = '00000000-0000-0000-0000-000000000003'
	const rex = '00000000-0000-0000-0000-000000000004'
	const bob = '00000000-0000-0000-0000-000000000005'

	it('returns null when the object does not exist', async () => {
		const db = mockDb([[]])
		const result = await buildObjectiveContext(db, objectId)
		expect(result).toBeNull()
	})

	it('composes title, parent bet, assignees, watchers, and recent comments', async () => {
		const object = { id: objectId, title: 'Ship pricing page', type: 'task', status: 'in_progress' }
		const parent = { id: betId, title: 'Self-serve pricing', type: 'bet', status: 'active' }
		const db = mockDb([
			[object],
			[{ sourceId: betId }],
			[parent],
			[
				{ targetId: alice, type: 'assigned_to' },
				{ targetId: rex, type: 'assigned_to' },
				{ targetId: bob, type: 'watches' },
			],
			[
				{ id: alice, name: 'Alice', type: 'human' },
				{ id: rex, name: 'Rex', type: 'agent' },
				{ id: bob, name: 'Bob', type: 'human' },
			],
			[
				{ actorId: alice, data: { content: 'Starting with the hero.' }, createdAt: new Date() },
				{ actorId: rex, data: { content: 'Acknowledged.' }, createdAt: new Date() },
			],
			[
				{ id: alice, name: 'Alice' },
				{ id: rex, name: 'Rex' },
			],
		])

		const result = await buildObjectiveContext(db, objectId)
		expect(result).not.toBeNull()
		expect(result).toContain('## Shared Objective')
		expect(result).toContain('Title: Ship pricing page')
		expect(result).toContain('Parent bet: Self-serve pricing')
		expect(result).toContain('Alice (human)')
		expect(result).toContain('Rex (agent)')
		expect(result).toContain('Watchers: Bob')
		expect(result).toContain('Rex: Acknowledged.')
		expect(result).toContain('Alice: Starting with the hero.')
	})

	it('omits optional sections when empty', async () => {
		const object = { id: objectId, title: 'Solo task', type: 'task', status: 'todo' }
		const db = mockDb([[object], [], [], [], []])
		const result = await buildObjectiveContext(db, objectId)
		expect(result).toContain('Title: Solo task')
		expect(result).not.toContain('Parent bet:')
		expect(result).not.toContain('Assignees:')
		expect(result).not.toContain('Watchers:')
		expect(result).not.toContain('Recent comments:')
	})
})
