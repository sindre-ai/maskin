import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getIntegrationCredentialMock, getValidTokenMock, slackApiCallMock } = vi.hoisted(() => ({
	getIntegrationCredentialMock: vi.fn(),
	getValidTokenMock: vi.fn(),
	slackApiCallMock: vi.fn(),
}))

vi.mock('../../../lib/events/record-event', () => ({ recordEvent: vi.fn() }))
vi.mock('../../../lib/integrations/lookup', () => ({
	getIntegrationCredential: getIntegrationCredentialMock,
}))
vi.mock('../../../lib/integrations/oauth/token-manager', () => ({
	// A class, not vi.fn(): the dead-letter suite's restoreAllMocks would clear a vi.fn() implementation.
	TokenManager: class {
		getValidToken = getValidTokenMock
	},
}))
vi.mock('../../../lib/integrations/providers/slack/slack-api', () => ({
	slackApiCall: slackApiCallMock,
}))

import { recordEvent } from '../../../lib/events/record-event'
import {
	type EffectContext,
	createDefaultEffectRunner,
	postToSales,
} from '../../../lib/outreach/voice/effects'
const ctx: EffectContext = {
	workspaceId: '00000000-0000-4000-8000-000000000001',
	contactId: '00000000-0000-4000-8000-000000000002',
	actorId: '00000000-0000-4000-8000-000000000003',
	dialAttemptN: 2,
}
const db = {} as Database

describe('voice dead letter posts to #sales', () => {
	const savedEnv = { ...process.env }

	beforeEach(() => {
		process.env.TELNYX_API_KEY = 'test-key'
		process.env.VOICE_SMS_MISSED_CALL_NUDGE = 'hello'
		vi.spyOn(Math, 'random').mockReturnValue(0)
		vi.mocked(recordEvent).mockReset()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		process.env = { ...savedEnv }
	})

	it('posts exactly once, with contact id, dial attempt and reason, after a final 5xx', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }))
		vi.stubGlobal('fetch', fetchMock)
		const post = vi.fn().mockResolvedValue(undefined)

		await expect(
			createDefaultEffectRunner(db, post).sendSms(
				'missed_call_nudge',
				ctx,
				'+4512345678',
				'+4593707030',
			),
		).rejects.toMatchObject({ name: 'TelnyxHttpError', status: 503 })

		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(post).toHaveBeenCalledTimes(1)
		const text = post.mock.calls[0]?.[2] as string
		expect(text).toContain(ctx.contactId)
		expect(text).toContain('dial attempt 2')
		expect(text).toContain('HTTP 503')
		// The attention-5 event stays.
		expect(recordEvent).toHaveBeenCalledTimes(1)
		expect(recordEvent).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				action: 'voice_dead_letter',
				data: expect.objectContaining({ attention: 5, channel: '#sales' }),
			}),
		)
	})

	it('posts zero times for a 4xx, which surfaces immediately', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 422 }))
		vi.stubGlobal('fetch', fetchMock)
		const post = vi.fn().mockResolvedValue(undefined)

		await expect(
			createDefaultEffectRunner(db, post).sendSms(
				'missed_call_nudge',
				ctx,
				'+4512345678',
				'+4593707030',
			),
		).rejects.toMatchObject({ name: 'TelnyxHttpError', status: 422 })

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(post).not.toHaveBeenCalled()
		expect(recordEvent).not.toHaveBeenCalled()
	})

	it('posts once for a reducer dead letter effect, carrying its reason', async () => {
		const post = vi.fn().mockResolvedValue(undefined)

		await createDefaultEffectRunner(db, post).deadLetter('stale_dialing_claim', ctx)

		expect(post).toHaveBeenCalledTimes(1)
		expect(post.mock.calls[0]?.[2]).toContain('stale_dialing_claim')
		expect(recordEvent).toHaveBeenCalledTimes(1)
	})
})

describe('postToSales resolves the bot from the workspace Slack integration', () => {
	beforeEach(() => {
		getIntegrationCredentialMock.mockReset()
		getValidTokenMock.mockReset()
		slackApiCallMock.mockReset()
	})

	it('posts to #sales with the integration token for the given workspace', async () => {
		getIntegrationCredentialMock.mockResolvedValue({ id: 'int-1' })
		getValidTokenMock.mockResolvedValue('xoxb-integration')
		slackApiCallMock.mockResolvedValue({})

		await postToSales(db, ctx.workspaceId, 'dead letter text')

		expect(getIntegrationCredentialMock).toHaveBeenCalledWith(db, ctx.workspaceId, 'slack', null)
		expect(getValidTokenMock).toHaveBeenCalledWith(db, 'int-1', expect.anything())
		expect(slackApiCallMock).toHaveBeenCalledTimes(1)
		expect(slackApiCallMock).toHaveBeenCalledWith('xoxb-integration', 'chat.postMessage', {
			channel: '#sales',
			text: 'dead letter text',
			unfurl_links: false,
		})
	})

	it('does not read SLACK_BOT_TOKEN', async () => {
		vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-env-should-be-ignored')
		getIntegrationCredentialMock.mockResolvedValue({ id: 'int-1' })
		getValidTokenMock.mockResolvedValue('xoxb-integration')
		slackApiCallMock.mockResolvedValue({})

		await postToSales(db, ctx.workspaceId, 'x')

		expect(slackApiCallMock.mock.calls[0]?.[0]).toBe('xoxb-integration')
		vi.unstubAllEnvs()
	})

	it('skips without throwing when the workspace has no active Slack integration', async () => {
		getIntegrationCredentialMock.mockResolvedValue(null)

		await expect(postToSales(db, ctx.workspaceId, 'x')).resolves.toBeUndefined()
		expect(getValidTokenMock).not.toHaveBeenCalled()
		expect(slackApiCallMock).not.toHaveBeenCalled()
	})

	it('swallows a token failure', async () => {
		getIntegrationCredentialMock.mockResolvedValue({ id: 'int-1' })
		getValidTokenMock.mockRejectedValue(new Error('token revoked'))

		await expect(postToSales(db, ctx.workspaceId, 'x')).resolves.toBeUndefined()
		expect(slackApiCallMock).not.toHaveBeenCalled()
	})

	it('swallows a Slack error such as not_in_channel', async () => {
		getIntegrationCredentialMock.mockResolvedValue({ id: 'int-1' })
		getValidTokenMock.mockResolvedValue('xoxb-integration')
		slackApiCallMock.mockRejectedValue(new Error('not_in_channel'))

		await expect(postToSales(db, ctx.workspaceId, 'x')).resolves.toBeUndefined()
	})
})
