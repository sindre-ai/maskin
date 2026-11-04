import { describe, expect, it } from 'vitest'
import { NotInWorkspaceError, assertInWorkspace } from '../../lib/workspace-scope'
import { createTestContext } from '../setup'

const wsId = '00000000-0000-0000-0000-000000000001'
const actorA = '00000000-0000-0000-0000-0000000000a1'
const actorB = '00000000-0000-0000-0000-0000000000a2'

describe('assertInWorkspace', () => {
	it('resolves when every actor is a member of the workspace', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ id: actorA }, { id: actorB }]

		await expect(assertInWorkspace(db, wsId, { actors: [actorA, actorB] })).resolves.toBeUndefined()
	})

	it('throws a 404 when any actor is not a member', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ id: actorA }]

		const err = await assertInWorkspace(db, wsId, { actors: [actorA, actorB] }).catch((e) => e)

		expect(err).toBeInstanceOf(NotInWorkspaceError)
		expect(err.status).toBe(404)
		expect(err.message).toBe('Actor not found')
	})

	it('counts a repeated id once', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ id: actorA }]

		await expect(assertInWorkspace(db, wsId, { actors: [actorA, actorA] })).resolves.toBeUndefined()
	})

	it('skips missing and empty ids without a query', async () => {
		const { db, mockResults } = createTestContext()
		// Would fail the check if it ran: no row comes back.
		mockResults.select = []

		await expect(
			assertInWorkspace(db, wsId, { actors: [undefined, null], objects: [], sessions: undefined }),
		).resolves.toBeUndefined()
	})

	it.each([
		['objects', 'Object'],
		['conversations', 'Conversation'],
		['triggers', 'Trigger'],
		['sessions', 'Session'],
	] as const)('throws a 404 when a %s id is not in the workspace', async (kind, label) => {
		const { db, mockResults } = createTestContext()
		mockResults.select = []

		const err = await assertInWorkspace(db, wsId, { [kind]: [actorA] }).catch((e) => e)

		expect(err).toBeInstanceOf(NotInWorkspaceError)
		expect(err.status).toBe(404)
		expect(err.message).toBe(`${label} not found`)
	})

	it('stops at the first kind that fails', async () => {
		const { db, mockResults } = createTestContext()
		// Actors pass, the object lookup finds nothing.
		mockResults.selectQueue = [[{ id: actorA }], []]

		const err = await assertInWorkspace(db, wsId, {
			actors: [actorA],
			objects: [actorB],
			sessions: [actorB],
		}).catch((e) => e)

		expect(err.message).toBe('Object not found')
	})
})
