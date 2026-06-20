import { describe, expect, it } from 'vitest'
import { filterWorkspaceMembers, isWorkspaceMember } from '../../lib/workspace-auth'
import { buildWorkspaceMember } from '../factories'
import { createTestContext } from '../setup'

describe('isWorkspaceMember', () => {
	it('returns true when actor is a member', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [buildWorkspaceMember()]

		const result = await isWorkspaceMember(db, 'actor-1', 'workspace-1')
		expect(result).toBe(true)
	})

	it('returns false when actor is not a member', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = []

		const result = await isWorkspaceMember(db, 'actor-1', 'workspace-1')
		expect(result).toBe(false)
	})
})

describe('filterWorkspaceMembers', () => {
	it('returns only the ids that match a workspace member row', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ actorId: 'actor-1' }, { actorId: 'actor-2' }]

		const result = await filterWorkspaceMembers(
			db,
			['actor-1', 'actor-2', 'actor-3'],
			'workspace-1',
		)
		expect(result).toEqual(['actor-1', 'actor-2'])
	})

	it('returns an empty array for an empty input without querying the db', async () => {
		const { db } = createTestContext()
		const result = await filterWorkspaceMembers(db, [], 'workspace-1')
		expect(result).toEqual([])
	})

	it('deduplicates input before querying', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ actorId: 'actor-1' }]

		const result = await filterWorkspaceMembers(
			db,
			['actor-1', 'actor-1', 'actor-1'],
			'workspace-1',
		)
		expect(result).toEqual(['actor-1'])
	})
})
