import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { findIntegrationRow, getValidToken, slackApiCall, loggerError } = vi.hoisted(() => ({
	findIntegrationRow: vi.fn(),
	getValidToken: vi.fn(),
	slackApiCall: vi.fn(),
	loggerError: vi.fn(),
}))

vi.mock('../../lib/integrations/lookup', () => ({ findIntegrationRow }))
vi.mock('../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = getValidToken
	},
}))
vi.mock('../../lib/integrations/providers/slack/slack-api', () => ({ slackApiCall }))
vi.mock('../../lib/integrations/registry', () => ({
	getProvider: vi.fn(() => ({ config: { name: 'slack' } })),
}))
vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: loggerError },
}))

import {
	BALANCE_ALERT_SLACK_CHANNEL,
	OpenRouterBalanceMonitor,
	readOpenRouterBalance,
} from '../../services/openrouter-balance-monitor'

const OPS_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const db = {} as Database
const T0 = new Date('2026-11-20T09:00:00Z')
const hoursLater = (h: number) => new Date(T0.getTime() + h * 60 * 60 * 1000)

function credits(totalCredits: number, totalUsage: number) {
	return new Response(
		JSON.stringify({ data: { total_credits: totalCredits, total_usage: totalUsage } }),
	)
}

function monitorWith(fetchImpl: ReturnType<typeof vi.fn>) {
	return new OpenRouterBalanceMonitor(db, fetchImpl as unknown as typeof fetch)
}

describe('OpenRouterBalanceMonitor', () => {
	const saved = {
		key: process.env.MASKIN_FALLBACK_OPENROUTER_KEY,
		base: process.env.MASKIN_FALLBACK_BASE_URL,
		ops: process.env.MASKIN_OPS_WORKSPACE_ID,
	}

	beforeEach(() => {
		vi.clearAllMocks()
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-test'
		// biome-ignore lint/performance/noDelete: assigning undefined would leave the string "undefined"
		delete process.env.MASKIN_FALLBACK_BASE_URL
		process.env.MASKIN_OPS_WORKSPACE_ID = OPS_WORKSPACE_ID
		findIntegrationRow.mockResolvedValue({ id: 'integration-1' })
		getValidToken.mockResolvedValue('xoxb-ops-token')
		slackApiCall.mockResolvedValue({ ok: true })
	})

	afterEach(() => {
		for (const [name, value] of [
			['MASKIN_FALLBACK_OPENROUTER_KEY', saved.key],
			['MASKIN_FALLBACK_BASE_URL', saved.base],
			['MASKIN_OPS_WORKSPACE_ID', saved.ops],
		] as const) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	})

	it('reads total_credits minus total_usage with the fallback key', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(credits(500, 462.5))
		const reading = await readOpenRouterBalance(
			'sk-or-test',
			'https://openrouter.ai/api',
			fetchImpl,
		)

		expect(reading).toEqual({ ok: true, balanceUsd: 37.5 })
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://openrouter.ai/api/v1/credits',
			expect.objectContaining({ headers: { Authorization: 'Bearer sk-or-test' } }),
		)
	})

	it('stays silent above the threshold', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(credits(500, 400))
		await monitorWith(fetchImpl).tick(T0)

		expect(slackApiCall).not.toHaveBeenCalled()
		expect(loggerError).not.toHaveBeenCalled()
	})

	it('warns once in #development with the balance and the top-up link when under $50', async () => {
		const fetchImpl = vi.fn().mockImplementation(async () => credits(500, 462.5))
		await monitorWith(fetchImpl).tick(T0)

		expect(slackApiCall).toHaveBeenCalledTimes(1)
		expect(slackApiCall).toHaveBeenCalledWith('xoxb-ops-token', 'chat.postMessage', {
			channel: BALANCE_ALERT_SLACK_CHANNEL,
			text: expect.stringMatching(/\$37\.50.*top up at openrouter\.ai\/credits/i),
			unfurl_links: false,
		})
	})

	it('suppresses a repeat inside 24 hours and warns again after', async () => {
		const fetchImpl = vi.fn().mockImplementation(async () => credits(500, 462.5))
		const monitor = monitorWith(fetchImpl)

		await monitor.tick(T0)
		await monitor.tick(hoursLater(1))
		await monitor.tick(hoursLater(23))
		expect(slackApiCall).toHaveBeenCalledTimes(1)

		await monitor.tick(hoursLater(25))
		expect(slackApiCall).toHaveBeenCalledTimes(2)
	})

	it('does not use up the 24 hours when Slack did not take the warning', async () => {
		const fetchImpl = vi.fn().mockImplementation(async () => credits(500, 462.5))
		const monitor = monitorWith(fetchImpl)

		slackApiCall.mockRejectedValueOnce(new Error('slack down'))
		await monitor.tick(T0)
		await monitor.tick(hoursLater(1))

		expect(slackApiCall).toHaveBeenCalledTimes(2)
	})

	it('says a failed credits call once, guesses no balance, and says it again only after a good read', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response('nope', { status: 401 }))
			.mockResolvedValueOnce(new Response('nope', { status: 401 }))
			.mockResolvedValueOnce(credits(500, 400))
			.mockResolvedValueOnce(new Response('nope', { status: 500 }))
		const monitor = monitorWith(fetchImpl)

		await monitor.tick(T0)
		expect(slackApiCall).toHaveBeenCalledTimes(1)
		expect(slackApiCall).toHaveBeenCalledWith(
			'xoxb-ops-token',
			'chat.postMessage',
			expect.objectContaining({
				text: expect.stringContaining('Could not read the OpenRouter balance (HTTP 401)'),
			}),
		)

		await monitor.tick(hoursLater(1))
		expect(slackApiCall).toHaveBeenCalledTimes(1)

		await monitor.tick(hoursLater(2)) // good read, above threshold
		await monitor.tick(hoursLater(3))
		expect(slackApiCall).toHaveBeenCalledTimes(2)
	})

	it('treats a network error or an odd response as a failed read', async () => {
		expect(
			await readOpenRouterBalance(
				'k',
				'https://openrouter.ai/api',
				vi.fn().mockRejectedValue(new Error('timeout')),
			),
		).toEqual({ ok: false, reason: 'timeout' })
		expect(
			await readOpenRouterBalance(
				'k',
				'https://openrouter.ai/api',
				vi.fn().mockResolvedValue(new Response('{}')),
			),
		).toEqual({ ok: false, reason: 'unexpected response shape' })
	})

	it('does nothing without the key or when the base URL is not OpenRouter', async () => {
		const fetchImpl = vi.fn()

		// biome-ignore lint/performance/noDelete: assigning undefined would leave the string "undefined"
		delete process.env.MASKIN_FALLBACK_OPENROUTER_KEY
		await monitorWith(fetchImpl).tick(T0)

		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-test'
		process.env.MASKIN_FALLBACK_BASE_URL = 'https://llm.internal.example/api'
		await monitorWith(fetchImpl).tick(T0)

		expect(fetchImpl).not.toHaveBeenCalled()
		expect(slackApiCall).not.toHaveBeenCalled()
	})

	it('logs at error and does not throw when the ops workspace is not configured', async () => {
		// biome-ignore lint/performance/noDelete: assigning undefined would leave the string "undefined"
		delete process.env.MASKIN_OPS_WORKSPACE_ID
		const fetchImpl = vi.fn().mockImplementation(async () => credits(500, 462.5))

		await expect(monitorWith(fetchImpl).tick(T0)).resolves.toBeUndefined()

		expect(loggerError).toHaveBeenCalledWith(
			expect.stringContaining('MASKIN_OPS_WORKSPACE_ID unset'),
			expect.any(Object),
		)
		expect(slackApiCall).not.toHaveBeenCalled()
	})
})
