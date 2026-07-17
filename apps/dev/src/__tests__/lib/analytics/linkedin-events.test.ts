import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	trackLinkedinAccountConnected,
	trackLinkedinMessageSent,
} from '../../../lib/analytics/linkedin-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

describe('trackLinkedinAccountConnected', () => {
	it('emits `linkedin_account_connected` with workspace as distinct id and the contracted props', async () => {
		await trackLinkedinAccountConnected({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			unipileAccountId: 'unipile-acc-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('linkedin_account_connected', 'ws-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			unipile_account_id: 'unipile-acc-1',
		})
	})
})

describe('trackLinkedinMessageSent', () => {
	it('emits `linkedin_message_sent` with workspace as distinct id, via_customer_account=true, and the contracted props', async () => {
		await trackLinkedinMessageSent({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			unipileAccountId: 'unipile-acc-1',
			chatId: 'chat-1',
			messageId: 'msg-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('linkedin_message_sent', 'ws-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			unipile_account_id: 'unipile-acc-1',
			chat_id: 'chat-1',
			message_id: 'msg-1',
			via_customer_account: true,
		})
	})
})
