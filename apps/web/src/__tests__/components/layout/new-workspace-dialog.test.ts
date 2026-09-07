import { createErrorMessage } from '@/components/layout/new-workspace-dialog'
import { ApiError } from '@/lib/api'
import { describe, expect, it } from 'vitest'

describe('createErrorMessage', () => {
	it('returns nothing when the mutation has not failed', () => {
		expect(createErrorMessage(null)).toBeUndefined()
	})

	it('keeps the server sentence and points at the plan for an ownership cap', () => {
		const err = new ApiError(
			403,
			'Ownership cap exceeded: actor owns 1/1 workspaces at trial tier.',
		)
		err.code = 'OWNERSHIP_CAP_EXCEEDED'
		const message = createErrorMessage(err)
		expect(message).toContain('Ownership cap exceeded')
		// "try again" is the one thing that cannot work against a plan limit.
		expect(message).not.toContain('try again')
		expect(message).toContain('Upgrade your plan')
	})

	it('falls back to the retry line for anything else', () => {
		expect(createErrorMessage(new ApiError(500, 'boom'))).toBe(
			"Couldn't create the workspace — try again",
		)
	})
})
