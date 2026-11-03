import { beforeEach, describe, expect, it, vi } from 'vitest'

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn(async () => {}) }))
vi.mock('../../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

import {
	LINKEDIN_TOOL_CALLED,
	trackLinkedInToolCalled,
} from '../../../lib/analytics/linkedin-events'

describe('linkedin_tool_called', () => {
	beforeEach(() => captureMock.mockClear())

	it('carries exactly the generic properties and nothing about the target or the text', async () => {
		await trackLinkedInToolCalled({
			tool: 'send_message',
			kind: 'send',
			outcome: 'error',
			errorCode: 'RATE_LIMITED_LINKEDIN',
			actorId: 'actor-1',
			sessionId: null,
			identityType: 'company_page',
		})

		expect(captureMock).toHaveBeenCalledWith(LINKEDIN_TOOL_CALLED, 'actor-1', {
			tool: 'send_message',
			kind: 'send',
			outcome: 'error',
			error_code: 'RATE_LIMITED_LINKEDIN',
			actor_id: 'actor-1',
			session_id: null,
			identity_type: 'company_page',
		})
		expect(LINKEDIN_TOOL_CALLED).toBe('linkedin_tool_called')
	})
})
