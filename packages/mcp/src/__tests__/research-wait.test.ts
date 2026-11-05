import { describe, expect, it, vi } from 'vitest'
import {
	type ResearchRunView,
	describeResearchRun,
	researchRunEnded,
	waitForResearchRun,
} from '../research-wait'

const run = (over: Partial<ResearchRunView> = {}): ResearchRunView => ({
	id: 'run-1',
	status: 'running',
	report_md: null,
	...over,
})

describe('waitForResearchRun', () => {
	it('returns at once when the run has ended', async () => {
		const fetchRun = vi.fn().mockResolvedValue(run({ status: 'done', report_md: 'r' }))
		const sleep = vi.fn()
		const out = await waitForResearchRun(fetchRun, { sleep })
		expect(out.status).toBe('done')
		expect(fetchRun).toHaveBeenCalledTimes(1)
		expect(sleep).not.toHaveBeenCalled()
	})

	it('polls until the run ends', async () => {
		const fetchRun = vi
			.fn()
			.mockResolvedValueOnce(run())
			.mockResolvedValueOnce(run())
			.mockResolvedValueOnce(run({ status: 'capped', report_md: 'r' }))
		const out = await waitForResearchRun(fetchRun, { sleep: async () => {} })
		expect(out.status).toBe('capped')
		expect(fetchRun).toHaveBeenCalledTimes(3)
	})

	it('gives the running status back once the wait is used up', async () => {
		let now = 0
		const fetchRun = vi.fn().mockResolvedValue(run())
		const out = await waitForResearchRun(fetchRun, {
			waitMs: 90_000,
			pollMs: 3_000,
			now: () => now,
			sleep: async (ms) => {
				now += ms
			},
		})
		expect(out.status).toBe('running')
		// One read at the start, then one every 3 seconds up to 90 seconds.
		expect(fetchRun).toHaveBeenCalledTimes(31)
		expect(now).toBe(90_000)
	})
})

describe('researchRunEnded', () => {
	it('is true for done, capped, failed and interrupted only', () => {
		for (const status of ['done', 'capped', 'failed', 'interrupted'] as const) {
			expect(researchRunEnded({ status })).toBe(true)
		}
		for (const status of ['queued', 'running'] as const) {
			expect(researchRunEnded({ status })).toBe(false)
		}
	})
})

describe('describeResearchRun', () => {
	it('gives the report with the id, status and cost for a finished run', () => {
		const out = describeResearchRun(
			run({
				status: 'done',
				report_md: '## TL;DR\nFive years [1].',
				usage: { cost_cents: 7 },
				cap: { cap_cents: 100 },
			}),
		)
		expect(out.isError).toBe(false)
		expect(out.text).toContain('## TL;DR')
		expect(out.text).toContain('research_id: run-1. Status: done. Cost $0.07 of a $1.00 cap.')
	})

	it('says a capped report is incomplete', () => {
		const out = describeResearchRun(run({ status: 'capped', report_md: '> **Warning:** x' }))
		expect(out.isError).toBe(false)
		expect(out.text).toContain('incomplete')
	})

	it('tells the caller to ask again with the id, not to start a second run, while running', () => {
		const out = describeResearchRun(run())
		expect(out.isError).toBe(false)
		expect(out.text).toContain('research_id "run-1"')
		expect(out.text).toContain('Do not start a second run')
	})

	it('reports a failed run as an error with its reason', () => {
		const out = describeResearchRun(run({ status: 'failed', error: 'The model call failed' }))
		expect(out.isError).toBe(true)
		expect(out.text).toContain('The model call failed')
	})

	it('reports an interrupted run as an error that says to start again', () => {
		const out = describeResearchRun(run({ status: 'interrupted' }))
		expect(out.isError).toBe(true)
		expect(out.text).toContain('Start it again')
	})
})
