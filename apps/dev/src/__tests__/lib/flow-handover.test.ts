import { describe, expect, it } from 'vitest'
import { flowOptsIntoHandoverTask, isDevelopmentTeamAgent } from '../../lib/flow-handover'

describe('flowOptsIntoHandoverTask', () => {
	it('is off unless the flow sets the key to true', () => {
		expect(flowOptsIntoHandoverTask(null)).toBe(false)
		expect(flowOptsIntoHandoverTask({})).toBe(false)
		expect(flowOptsIntoHandoverTask({ handover_is_task: false })).toBe(false)
		expect(flowOptsIntoHandoverTask({ handover_is_task: 'true' })).toBe(false)
		expect(flowOptsIntoHandoverTask({ handover_is_task: true })).toBe(true)
	})
})

describe('isDevelopmentTeamAgent', () => {
	it('knows the development team by name', () => {
		expect(isDevelopmentTeamAgent('Developer')).toBe(true)
		expect(isDevelopmentTeamAgent('Code Reviewer')).toBe(true)
		expect(isDevelopmentTeamAgent('Events Lead')).toBe(false)
		expect(isDevelopmentTeamAgent(null)).toBe(false)
	})
})
