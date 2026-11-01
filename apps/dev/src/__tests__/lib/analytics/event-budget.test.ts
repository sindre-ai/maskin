import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	__resetPosthogEventBudgetForTesting,
	admitPosthogEvent,
} from '../../../lib/analytics/event-budget'
import { logger } from '../../../lib/logger'

describe('admitPosthogEvent', () => {
	beforeEach(() => {
		__resetPosthogEventBudgetForTesting()
		vi.stubEnv('POSTHOG_EVENT_DAILY_CAP', '3')
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it('sends an event until its daily cap, then drops it and warns once', () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
		const results = Array.from({ length: 5 }, () => admitPosthogEvent('file_saved').send)
		expect(results).toEqual([true, true, true, false, false])
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('daily cap'),
			expect.objectContaining({ event: 'file_saved', dailyCap: 3 }),
		)
	})

	it('keeps a separate count per event name', () => {
		for (let i = 0; i < 3; i++) admitPosthogEvent('file_saved')
		expect(admitPosthogEvent('file_saved').send).toBe(false)
		expect(admitPosthogEvent('loop_installed').send).toBe(true)
	})

	it('never caps tier 1 events', () => {
		for (const event of [
			'agent_session_completed',
			'agent_session_started',
			'chat_session_started',
			'foryou_card_action',
			'signup_completed',
			'workspace_created',
			'checkout_session_completed',
		]) {
			for (let i = 0; i < 10; i++) expect(admitPosthogEvent(event)).toEqual({ send: true })
		}
	})

	it('turns the cap off at 0 and falls back to the default on a bad value', () => {
		vi.stubEnv('POSTHOG_EVENT_DAILY_CAP', '0')
		for (let i = 0; i < 50; i++) expect(admitPosthogEvent('file_saved').send).toBe(true)
		vi.stubEnv('POSTHOG_EVENT_DAILY_CAP', 'lots')
		for (let i = 0; i < 50; i++) expect(admitPosthogEvent('loop_installed').send).toBe(true)
	})

	it('resets the count on a new UTC day and logs the previous day once', () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-10-30T23:59:00Z'))
		const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
		vi.spyOn(logger, 'warn').mockImplementation(() => {})
		for (let i = 0; i < 4; i++) admitPosthogEvent('file_saved')
		expect(admitPosthogEvent('file_saved').send).toBe(false)

		vi.setSystemTime(new Date('2026-10-31T00:01:00Z'))
		expect(admitPosthogEvent('file_saved').send).toBe(true)
		expect(info).toHaveBeenCalledTimes(1)
		expect(info).toHaveBeenCalledWith(
			expect.stringContaining('previous UTC day'),
			expect.objectContaining({
				day: '2026-10-30',
				sentTotal: 3,
				events: { file_saved: { seen: 5, sent: 3, sampledOut: 0, capped: 2 } },
			}),
		)
	})

	describe('sampling', () => {
		it('drops provenance_edge_written outright', () => {
			vi.spyOn(Math, 'random').mockReturnValue(0)
			expect(admitPosthogEvent('provenance_edge_written').send).toBe(false)
		})

		it('sends a sampled event with its rate when the draw is under the rate', () => {
			vi.spyOn(Math, 'random').mockReturnValue(0.05)
			expect(admitPosthogEvent('mcp_tool_call_response_size')).toEqual({
				send: true,
				sampleRate: 0.1,
			})
		})

		it('drops a sampled event when the draw is at or over the rate', () => {
			vi.spyOn(Math, 'random').mockReturnValue(0.5)
			expect(admitPosthogEvent('mcp_handshake').send).toBe(false)
		})

		it('does not use up the cap on events that were sampled out', () => {
			vi.spyOn(Math, 'random').mockReturnValue(0.5)
			for (let i = 0; i < 20; i++) admitPosthogEvent('trigger_match_failed')
			vi.spyOn(Math, 'random').mockReturnValue(0)
			expect(admitPosthogEvent('trigger_match_failed').send).toBe(true)
		})
	})
})
