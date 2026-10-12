import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getIntegrationCredential, getValidToken, slackApiCall, loggerError } = vi.hoisted(() => ({
	getIntegrationCredential: vi.fn(),
	getValidToken: vi.fn(),
	slackApiCall: vi.fn(),
	loggerError: vi.fn(),
}))

vi.mock('../../lib/integrations/lookup', () => ({ getIntegrationCredential }))
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

import { notifySebkOnSlack } from '../../lib/vat-notifications'

const OPS_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333'
const db = {} as Database

describe('notifySebkOnSlack', () => {
	const originalOpsWorkspaceId = process.env.MASKIN_OPS_WORKSPACE_ID
	const originalBotToken = process.env.SLACK_BOT_TOKEN

	beforeEach(() => {
		vi.clearAllMocks()
		process.env.MASKIN_OPS_WORKSPACE_ID = OPS_WORKSPACE_ID
		// biome-ignore lint/performance/noDelete: assigning undefined would leave the string "undefined"
		delete process.env.SLACK_BOT_TOKEN
		getIntegrationCredential.mockResolvedValue({ id: INTEGRATION_ID })
		getValidToken.mockResolvedValue('xoxb-ops-token')
		slackApiCall.mockResolvedValue({ ok: true })
	})

	afterEach(() => {
		if (originalOpsWorkspaceId === undefined) {
			// biome-ignore lint/performance/noDelete: assigning undefined would leave the string "undefined"
			delete process.env.MASKIN_OPS_WORKSPACE_ID
		} else {
			process.env.MASKIN_OPS_WORKSPACE_ID = originalOpsWorkspaceId
		}
		if (originalBotToken !== undefined) process.env.SLACK_BOT_TOKEN = originalBotToken
	})

	it('DMs Sebk with the ops workspace integration token and no SLACK_BOT_TOKEN env var', async () => {
		await notifySebkOnSlack(db, 'dispute opened')

		expect(getIntegrationCredential).toHaveBeenCalledWith(db, OPS_WORKSPACE_ID, 'slack', null)
		expect(getValidToken).toHaveBeenCalledWith(db, INTEGRATION_ID, expect.anything())
		expect(slackApiCall).toHaveBeenCalledWith('xoxb-ops-token', 'chat.postMessage', {
			channel: 'U04A164KDB7',
			text: 'dispute opened',
			unfurl_links: false,
		})
		expect(loggerError).not.toHaveBeenCalled()
	})

	it('logs at error and does not throw when MASKIN_OPS_WORKSPACE_ID is unset', async () => {
		// biome-ignore lint/performance/noDelete: assigning undefined would leave the string "undefined"
		delete process.env.MASKIN_OPS_WORKSPACE_ID

		await expect(notifySebkOnSlack(db, 'dispute opened')).resolves.toBeUndefined()

		expect(loggerError).toHaveBeenCalledWith(
			expect.stringContaining('MASKIN_OPS_WORKSPACE_ID unset'),
			expect.any(Object),
		)
		expect(getIntegrationCredential).not.toHaveBeenCalled()
		expect(slackApiCall).not.toHaveBeenCalled()
	})

	it('logs at error and does not throw when the ops workspace has no active slack integration', async () => {
		getIntegrationCredential.mockResolvedValue(null)

		await expect(notifySebkOnSlack(db, 'dispute opened')).resolves.toBeUndefined()

		expect(loggerError).toHaveBeenCalledWith(
			expect.stringContaining('no active slack integration'),
			expect.objectContaining({ opsWorkspaceId: OPS_WORKSPACE_ID }),
		)
		expect(getValidToken).not.toHaveBeenCalled()
		expect(slackApiCall).not.toHaveBeenCalled()
	})

	it('logs at error and does not throw when token resolution or the Slack call fails', async () => {
		getValidToken.mockRejectedValue(new Error('integration revoked'))

		await expect(notifySebkOnSlack(db, 'dispute opened')).resolves.toBeUndefined()

		expect(loggerError).toHaveBeenCalledWith(
			'vat.notify_sebk failed',
			expect.objectContaining({ error: 'integration revoked' }),
		)
	})
})
