import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.fn()

vi.mock('resend', () => ({
	Resend: vi.fn().mockImplementation(() => ({ emails: { send } })),
}))

import {
	InviteEmailSendError,
	type Resend,
	VoiceFollowupEmailSendError,
	sendInviteEmail,
	sendVoiceFollowupEmail,
} from '../index'

const params = {
	to: 'invitee@example.com',
	workspaceName: 'Acme',
	inviterName: 'Sam',
	role: 'member',
	acceptUrl: 'https://maskin.io/accept-invite?token=abc',
}

describe('sendInviteEmail', () => {
	beforeEach(() => {
		vi.stubEnv('RESEND_API_KEY', 're_test_key')
		send.mockReset()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('resolves when Resend accepts the message', async () => {
		send.mockResolvedValue({ data: { id: 'email-1' }, error: null })
		await expect(sendInviteEmail(params)).resolves.toBeUndefined()
		expect(send).toHaveBeenCalledOnce()
	})

	it('rejects when Resend resolves with an error instead of throwing', async () => {
		send.mockResolvedValue({
			data: null,
			error: { name: 'validation_error', message: 'domain not verified' },
		})
		await expect(sendInviteEmail(params)).rejects.toBeInstanceOf(InviteEmailSendError)
	})

	it('carries the provider error on the thrown error, not in its message', async () => {
		send.mockResolvedValue({
			data: null,
			error: { name: 'validation_error', message: 'domain not verified' },
		})
		const err = await sendInviteEmail(params).catch((e) => e)
		expect(err.providerErrorName).toBe('validation_error')
		expect(err.providerMessage).toBe('domain not verified')
		expect(err.message).not.toContain('domain not verified')
	})

	it('does not dispatch when RESEND_API_KEY is empty', async () => {
		vi.stubEnv('RESEND_API_KEY', '')
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		await expect(sendInviteEmail(params)).resolves.toBeUndefined()
		expect(send).not.toHaveBeenCalled()
		log.mockRestore()
	})
})

describe('sendVoiceFollowupEmail', () => {
	const voiceSend = vi.fn()
	const resend = { emails: { send: voiceSend } } as unknown as Resend
	const base = {
		resend,
		from: 'noreply@agent.a.example',
		to: 'prospect@example.com',
		prospectName: 'Pia <b>',
		callSummary: 'We covered pricing & rollout.',
		contact: { metadata: {} },
	}

	beforeEach(() => {
		voiceSend.mockReset()
	})

	it('sends with the handed-in client and sender, and escapes html', async () => {
		voiceSend.mockResolvedValue({ data: { id: 'email-2' }, error: null })
		await expect(sendVoiceFollowupEmail(base)).resolves.toEqual({ sent: true })
		expect(voiceSend).toHaveBeenCalledOnce()
		const arg = voiceSend.mock.calls[0][0]
		expect(arg.from).toBe('noreply@agent.a.example')
		expect(arg.to).toBe('prospect@example.com')
		expect(arg.html).toContain('Pia &lt;b&gt;')
		expect(arg.html).toContain('pricing &amp; rollout')
		expect(arg.text).toContain('We covered pricing & rollout.')
	})

	it('includes the calendar link only when it is https', async () => {
		voiceSend.mockResolvedValue({ data: { id: 'email-3' }, error: null })
		await sendVoiceFollowupEmail({ ...base, calendarLink: 'https://cal.example/pia' })
		expect(voiceSend.mock.calls[0][0].text).toContain('https://cal.example/pia')
		await sendVoiceFollowupEmail({ ...base, calendarLink: 'javascript:alert(1)' })
		expect(voiceSend.mock.calls[1][0].text).not.toContain('javascript:')
		expect(voiceSend.mock.calls[1][0].html).not.toContain('javascript:')
	})

	it('skips the send when compliance_flag is disclosure_missing', async () => {
		const result = await sendVoiceFollowupEmail({
			...base,
			contact: { metadata: { compliance_flag: 'disclosure_missing' } },
		})
		expect(result).toEqual({ sent: false, reason: 'disclosure_missing' })
		expect(voiceSend).not.toHaveBeenCalled()
	})

	it('rejects with VoiceFollowupEmailSendError when Resend resolves with an error', async () => {
		voiceSend.mockResolvedValue({
			data: null,
			error: { name: 'validation_error', message: 'domain not verified' },
		})
		const err = await sendVoiceFollowupEmail(base).catch((e) => e)
		expect(err).toBeInstanceOf(VoiceFollowupEmailSendError)
		expect(err.providerErrorName).toBe('validation_error')
		expect(err.message).not.toContain('domain not verified')
	})
})
