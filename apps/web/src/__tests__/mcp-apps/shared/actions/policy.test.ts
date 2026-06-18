import { MUTATION_POLICY, getMutationPolicy } from '@/mcp-apps/shared/actions'
import { describe, expect, it } from 'vitest'

describe('MUTATION_POLICY', () => {
	it('exposes the v1 mutation kinds', () => {
		expect(Object.keys(MUTATION_POLICY).sort()).toEqual(
			['object_delete', 'object_driver', 'object_relationship_add', 'object_status'].sort(),
		)
	})

	it('marks delete as confirm-required + destructive', () => {
		const policy = getMutationPolicy('object_delete')
		expect(policy.confirm).toBe(true)
		expect(policy.variant).toBe('destructive')
		expect(policy.optimistic).toBe(false)
	})

	it('keeps status / owner one-click + optimistic per the v1 design doc', () => {
		expect(getMutationPolicy('object_status').confirm).toBe(false)
		expect(getMutationPolicy('object_status').optimistic).toBe(true)
		expect(getMutationPolicy('object_driver').confirm).toBe(false)
		expect(getMutationPolicy('object_driver').optimistic).toBe(true)
	})
})
