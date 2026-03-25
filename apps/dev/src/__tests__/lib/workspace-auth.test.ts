import { describe, expect, it } from 'vitest'
import { isWorkspaceMember } from '../../lib/workspace-auth'
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
