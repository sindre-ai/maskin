import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
const resendCtorMock = vi.fn()

vi.mock('resend', () => ({
	Resend: class {
		emails = { send: sendMock }
		constructor(apiKey: string) {
			resendCtorMock(apiKey)
		}
	},
}))

const captureMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@maskin/shared', () => ({
	capturePosthogEvent: (...args: unknown[]) => captureMock(...args),
}))

import { EmailSendError, resetResendClientForTesting, sendEmail } from '..'
import type { SendEmailAnalytics } from '../send'

const ORIGINAL_ENV = { ...process.env }

const systemAnalytics: SendEmailAnalytics = {
	workspaceId: 'ws-1',
	emailType: 'account_verification',
	agentId: null,
}

const agentAnalytics: SendEmailAnalytics = {
	workspaceId: 'ws-1',
	emailType: 'agent',
	agentId: 'actor-agent-1',
}

beforeEach(() => {
	sendMock.mockReset()
	resendCtorMock.mockReset()
	captureMock.mockReset().mockResolvedValue(undefined)
	resetResendClientForTesting()
	process.env.RESEND_API_KEY = 're_test_key'
	process.env.EMAIL_FROM = 'Maskin <hello@mail.maskin.ai>'
})

afterEach(() => {
	process.env = { ...ORIGINAL_ENV }
})

describe('sendEmail', () => {
	it('constructs the Resend client with the configured API key', async () => {
		sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null })
		await sendEmail({
			to: 'a@b.co',
			subject: 's',
			html: '<p>h</p>',
			text: 't',
			analytics: systemAnalytics,
		})
		expect(resendCtorMock).toHaveBeenCalledWith('re_test_key')
	})

	it('sends with from/to/subject/html/text from options and env', async () => {
		sendMock.mockResolvedValue({ data: { id: 'email_2' }, error: null })
		await sendEmail({
			to: 'user@example.com',
			subject: 'Welcome',
			html: '<p>Hi</p>',
			text: 'Hi',
			analytics: systemAnalytics,
		})
		expect(sendMock).toHaveBeenCalledWith(
			{
				from: 'Maskin <hello@mail.maskin.ai>',
				to: 'user@example.com',
				subject: 'Welcome',
				html: '<p>Hi</p>',
				text: 'Hi',
			},
			undefined,
		)
	})

	it('forwards idempotencyKey to the SDK options when provided', async () => {
		sendMock.mockResolvedValue({ data: { id: 'email_3' }, error: null })
		await sendEmail({
			to: 'user@example.com',
			subject: 's',
			html: '<p>h</p>',
			text: 't',
			idempotencyKey: 'key-42',
			analytics: systemAnalytics,
		})
		expect(sendMock).toHaveBeenCalledWith(expect.any(Object), { idempotencyKey: 'key-42' })
	})

	it('omits the idempotency option when no key is passed', async () => {
		sendMock.mockResolvedValue({ data: { id: 'email_4' }, error: null })
		await sendEmail({
			to: 'u@example.com',
			subject: 's',
			html: '<p>h</p>',
			text: 't',
			analytics: systemAnalytics,
		})
		expect(sendMock).toHaveBeenCalledWith(expect.any(Object), undefined)
	})

	it('accepts an array of recipients', async () => {
		sendMock.mockResolvedValue({ data: { id: 'email_5' }, error: null })
		await sendEmail({
			to: ['a@example.com', 'b@example.com'],
			subject: 's',
			html: '<p>h</p>',
			text: 't',
			analytics: systemAnalytics,
		})
		expect(sendMock).toHaveBeenCalledWith(
			expect.objectContaining({ to: ['a@example.com', 'b@example.com'] }),
			undefined,
		)
	})

	it('returns the provider message id on success', async () => {
		sendMock.mockResolvedValue({ data: { id: 'email_ok' }, error: null })
		const result = await sendEmail({
			to: 'u@e.co',
			subject: 's',
			html: '<p>h</p>',
			text: 't',
			analytics: systemAnalytics,
		})
		expect(result).toEqual({ id: 'email_ok' })
	})

	it('throws EmailSendError with providerCode when Resend returns an error', async () => {
		sendMock.mockResolvedValue({
			data: null,
			error: { name: 'validation_error', message: 'Invalid `to` field' },
		})
		await expect(
			sendEmail({
				to: 'bad',
				subject: 's',
				html: '<p>h</p>',
				text: 't',
				analytics: systemAnalytics,
			}),
		).rejects.toMatchObject({
			name: 'EmailSendError',
			providerCode: 'validation_error',
			message: 'Invalid `to` field',
		})
	})

	it('wraps thrown transport errors as EmailSendError(transport_error)', async () => {
		sendMock.mockRejectedValue(new Error('ECONNRESET'))
		await expect(
			sendEmail({
				to: 'u@e.co',
				subject: 's',
				html: '<p>h</p>',
				text: 't',
				analytics: systemAnalytics,
			}),
		).rejects.toMatchObject({
			name: 'EmailSendError',
			providerCode: 'transport_error',
			message: 'ECONNRESET',
		})
	})

	it('throws EmailSendError when the SDK returns no id and no error', async () => {
		sendMock.mockResolvedValue({ data: null, error: null })
		await expect(
			sendEmail({
				to: 'u@e.co',
				subject: 's',
				html: '<p>h</p>',
				text: 't',
				analytics: systemAnalytics,
			}),
		).rejects.toBeInstanceOf(EmailSendError)
	})

	it('throws when RESEND_API_KEY is missing', async () => {
		Reflect.deleteProperty(process.env, 'RESEND_API_KEY')
		await expect(
			sendEmail({
				to: 'u@e.co',
				subject: 's',
				html: '<p>h</p>',
				text: 't',
				analytics: systemAnalytics,
			}),
		).rejects.toThrow('RESEND_API_KEY environment variable is required')
		expect(sendMock).not.toHaveBeenCalled()
	})

	it('throws when EMAIL_FROM is missing', async () => {
		Reflect.deleteProperty(process.env, 'EMAIL_FROM')
		await expect(
			sendEmail({
				to: 'u@e.co',
				subject: 's',
				html: '<p>h</p>',
				text: 't',
				analytics: systemAnalytics,
			}),
		).rejects.toThrow('EMAIL_FROM environment variable is required')
		expect(sendMock).not.toHaveBeenCalled()
	})

	it('rebuilds the Resend client if the API key changes between calls', async () => {
		sendMock.mockResolvedValue({ data: { id: 'x' }, error: null })
		await sendEmail({
			to: 'u@e.co',
			subject: 's',
			html: '<p>h</p>',
			text: 't',
			analytics: systemAnalytics,
		})
		process.env.RESEND_API_KEY = 're_test_key_rotated'
		await sendEmail({
			to: 'u@e.co',
			subject: 's',
			html: '<p>h</p>',
			text: 't',
			analytics: systemAnalytics,
		})
		expect(resendCtorMock).toHaveBeenCalledTimes(2)
		expect(resendCtorMock).toHaveBeenNthCalledWith(2, 're_test_key_rotated')
	})
})

describe('sendEmail — email_sent PostHog event', () => {
	it('emits email_sent for a Layer 1 system send with template name and null agent_id', async () => {
		sendMock.mockResolvedValue({ data: { id: 'msg_sys' }, error: null })
		await sendEmail({
			to: 'user@example.com',
			subject: 'Verify your email',
			html: '<p>h</p>',
			text: 't',
			idempotencyKey: 'verify-42',
			analytics: {
				workspaceId: 'ws-42',
				emailType: 'account_verification',
				agentId: null,
			},
		})
		expect(captureMock).toHaveBeenCalledOnce()
		expect(captureMock).toHaveBeenCalledWith('email_sent', 'ws-42', {
			workspace_id: 'ws-42',
			email_type: 'account_verification',
			agent_id: null,
			idempotency_key: 'verify-42',
			provider_message_id: 'msg_sys',
		})
	})

	it('emits email_sent for a Layer 2 agent send with email_type=agent and the agent id', async () => {
		sendMock.mockResolvedValue({ data: { id: 'msg_agent' }, error: null })
		await sendEmail({
			to: 'teammate@example.com',
			subject: 'Ping',
			html: '<p>h</p>',
			text: 't',
			analytics: agentAnalytics,
		})
		expect(captureMock).toHaveBeenCalledWith('email_sent', 'ws-1', {
			workspace_id: 'ws-1',
			email_type: 'agent',
			agent_id: 'actor-agent-1',
			idempotency_key: null,
			provider_message_id: 'msg_agent',
		})
	})

	it('defaults agent_id to null when the caller omits it', async () => {
		sendMock.mockResolvedValue({ data: { id: 'msg_default' }, error: null })
		await sendEmail({
			to: 'u@e.co',
			subject: 's',
			html: '<p>h</p>',
			text: 't',
			analytics: { workspaceId: 'ws-9', emailType: 'password_reset' },
		})
		expect(captureMock).toHaveBeenCalledWith(
			'email_sent',
			'ws-9',
			expect.objectContaining({ agent_id: null }),
		)
	})

	it('does not emit email_sent when the send fails', async () => {
		sendMock.mockResolvedValue({
			data: null,
			error: { name: 'validation_error', message: 'bad recipient' },
		})
		await expect(
			sendEmail({
				to: 'bad',
				subject: 's',
				html: '<p>h</p>',
				text: 't',
				analytics: systemAnalytics,
			}),
		).rejects.toBeInstanceOf(EmailSendError)
		expect(captureMock).not.toHaveBeenCalled()
	})

	it('does not emit email_sent when the transport throws', async () => {
		sendMock.mockRejectedValue(new Error('ECONNRESET'))
		await expect(
			sendEmail({
				to: 'u@e.co',
				subject: 's',
				html: '<p>h</p>',
				text: 't',
				analytics: systemAnalytics,
			}),
		).rejects.toBeInstanceOf(EmailSendError)
		expect(captureMock).not.toHaveBeenCalled()
	})

	it('still returns the provider message id when analytics capture rejects', async () => {
		sendMock.mockResolvedValue({ data: { id: 'msg_ok' }, error: null })
		captureMock.mockRejectedValueOnce(new Error('posthog offline'))
		const result = await sendEmail({
			to: 'u@e.co',
			subject: 's',
			html: '<p>h</p>',
			text: 't',
			analytics: systemAnalytics,
		})
		expect(result).toEqual({ id: 'msg_ok' })
	})
})
