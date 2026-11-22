import { describe, expect, it } from 'vitest'
import { REMOVAL_LEDGER } from '../removal-ledger'
import { MAX_LISTED_TOOL_ALIASES, TOOL_NAME_ALIASES } from '../tool-aliases'
import { tools } from '../tools'

describe('tool-name alias cap', () => {
	it(`lists at most ${MAX_LISTED_TOOL_ALIASES} tool-name aliases`, () => {
		expect(Object.keys(TOOL_NAME_ALIASES).length).toBeLessThanOrEqual(MAX_LISTED_TOOL_ALIASES)
	})

	it('has exactly one today: search_objects (1 of 10)', () => {
		expect(Object.keys(TOOL_NAME_ALIASES)).toEqual(['search_objects'])
	})

	it('only points at tools that exist', () => {
		for (const target of Object.values(TOOL_NAME_ALIASES)) {
			expect(Object.keys(tools)).toContain(target)
		}
	})

	it('does not keep run_agent or create_session: both were deleted outright', () => {
		expect(TOOL_NAME_ALIASES).not.toHaveProperty('run_agent')
		expect(tools).not.toHaveProperty('run_agent')
		expect(tools).not.toHaveProperty('create_session')
	})

	it('shows every alias as a live listed alias in the removal ledger, with a sweep date', () => {
		for (const [oldName, target] of Object.entries(TOOL_NAME_ALIASES)) {
			const entry = REMOVAL_LEDGER.find((e) => e.tool === oldName && e.path === undefined)
			expect(entry, `${oldName} has no removal ledger entry`).toBeDefined()
			expect(entry?.sweepDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
			expect(entry?.decision).toContain(`listed alias of ${target}`)
			expect(entry?.decision).toContain('live in tools/list')
		}
	})
})
