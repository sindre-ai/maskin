import { describe, expect, it } from 'vitest'
import {
	DISCOVERY_CATEGORY,
	JOB_LOOP_CATEGORY,
	JOB_LOOP_PACKAGES,
	JOB_LOOP_PACKAGE_VERSION,
} from '../constants/job-loop-packages'

describe('job-loop catalog packages', () => {
	it('ships the four cross-functional loops named on the bet', () => {
		const slugs = JOB_LOOP_PACKAGES.map((p) => p.slug).sort()
		expect(slugs).toEqual(['bug-triage', 'incident', 'launch', 'standup'])
	})

	it('uses a distinct category from the discovery package', () => {
		expect(JOB_LOOP_CATEGORY).toBe('job-loop')
		expect(DISCOVERY_CATEGORY).toBe('discovery')
		expect(JOB_LOOP_CATEGORY).not.toBe(DISCOVERY_CATEGORY)
	})

	it('declares a non-empty version', () => {
		expect(JOB_LOOP_PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
	})

	it('keeps source_item_id values UUID-shaped, unique, and stable per package', () => {
		const all = JOB_LOOP_PACKAGES.flatMap((p) => p.items.map((i) => i.sourceItemId))
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
		for (const id of all) expect(id).toMatch(uuid)
		expect(new Set(all).size).toBe(all.length)
	})

	it('ships at least one item per loop so the storefront card has type chips', () => {
		for (const pkg of JOB_LOOP_PACKAGES) {
			expect(pkg.items.length).toBeGreaterThan(0)
			for (const item of pkg.items) {
				expect(['actor', 'trigger', 'skill', 'integration']).toContain(item.itemType)
			}
		}
	})
})
