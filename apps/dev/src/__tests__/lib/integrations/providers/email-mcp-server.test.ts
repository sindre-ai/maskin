import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
	mockSendEmail,
	mockReadResendEnv,
	mockStripExternalImages,
	mockSanitizeSendError,
	MockEmailSendError,
} = vi.hoisted(() => {
	class MockEmailSendError extends Error {
		readonly name = 'EmailSendError'
		readonly providerCode: string
		constructor(providerCode: string, message: string) {
			super(message)
			this.providerCode = providerCode
		}
	}
	return {
		mockSendEmail: vi.fn(),
		mockReadResendEnv: vi.fn(),
		mockStripExternalImages: vi.fn((body: string) => ({ bodyText: body, removed: 0 })),
		mockSanitizeSendError: vi.fn(),
		MockEmailSendError,
	}
})

vi.mock('@maskin/email', () => ({
	sendEmail: mockSendEmail,
	readResendEnv: mockReadResendEnv,
	stripExternalImages: mockStripExternalImages,
	sanitizeSendError: mockSanitizeSendError,
	EmailSendError: MockEmailSendError,
}))

const {
	mockCheckAgentEmailRateLimit,
	mockFindExistingAgentEmailSend,
	mockRecordAgentEmailSend,
	mockIsUniqueViolation,
	mockReadAgentEmailRateLimitPerHour,
} = vi.hoisted(() => ({
	mockCheckAgentEmailRateLimit: vi.fn(),
	mockFindExistingAgentEmailSend: vi.fn(),
	mockRecordAgentEmailSend: vi.fn(),
	mockIsUniqueViolation: vi.fn(),
	mockReadAgentEmailRateLimitPerHour: vi.fn(),
}))

vi.mock('../../../../lib/integrations/providers/email/hardening', () => ({
	checkAgentEmailRateLimit: mockCheckAgentEmailRateLimit,
	findExistingAgentEmailSend: mockFindExistingAgentEmailSend,
	recordAgentEmailSend: mockRecordAgentEmailSend,
	isUniqueViolation: mockIsUniqueViolation,
	readAgentEmailRateLimitPerHour: mockReadAgentEmailRateLimitPerHour,
}))

import { createEmailMcpServer } from '../../../../lib/integrations/providers/email/mcp-server'

type RegisteredTool = {
	description?: string
	inputSchema?: unknown
	handler: (
		args: unknown,
		extra: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }> }>
}

function makeAllowlistDb(rows: Array<{ actorId: string }>): Database {
	const limit = vi.fn().mockResolvedValue(rows)
	const where = vi.fn().mockReturnValue({ limit })
	const innerJoin = vi.fn().mockReturnValue({ where })
	const from = vi.fn().mockReturnValue({ innerJoin })
	const select = vi.fn().mockReturnValue({ from })
	return { select } as unknown as Database
}

function buildCtx(overrides: { db?: Database } = {}) {
	return {
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		agentLabel: 'Synthesizer · in mesh-firm',
		db: overrides.db ?? makeAllowlistDb([]),
	}
}

function getSendEmailTool(ctx: ReturnType<typeof buildCtx>): RegisteredTool {
	const server = createEmailMcpServer(ctx)
	const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
		._registeredTools
	const tool = tools.send_email
	expect(tool).toBeDefined()
	return tool
}

const VALID_ARGS = {
	to: 'member@example.com',
	subject: 'Weekly nudge',
	bodyText: 'Hi — quick check-in.',
}

describe('createEmailMcpServer — send_email', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockStripExternalImages.mockImplementation((body: string) => ({ bodyText: body, removed: 0 }))
		mockReadResendEnv.mockReturnValue({ apiKey: 'test-key', from: 'noreply@mail.maskin.ai' })
		mockCheckAgentEmailRateLimit.mockResolvedValue({ ok: true, limit: 10, used: 0 })
		mockFindExistingAgentEmailSend.mockResolvedValue(null)
		mockRecordAgentEmailSend.mockResolvedValue(undefined)
		mockIsUniqueViolation.mockReturnValue(false)
		mockReadAgentEmailRateLimitPerHour.mockReturnValue(10)
		mockSanitizeSendError.mockReturnValue({
			code: 'unexpected_error',
			message:
				'Email send failed for an unexpected reason. See server logs for the specific reason.',
		})
	})

	it('publishes a description that names all documented error codes, the rate limit, and idempotency', () => {
		const tool = getSendEmailTool(buildCtx())
		const description = tool.description ?? ''
		expect(description).toContain('recipient_not_in_workspace')
		expect(description).toContain('rate_limit_exceeded')
		expect(description).toContain('already_sent')
		expect(description).toContain('send_failed')
		expect(description).toContain('email_not_configured')
		expect(description).not.toContain('not_available_yet')
		expect(description).toMatch(/10 sends per rolling hour/i)
		expect(description).toMatch(/AGENT_EMAIL_RATE_LIMIT_PER_HOUR/)
		expect(description).toMatch(/idempotencyKey/)
	})

	it('exposes an input schema that lists to, subject, bodyText, bodyHtml, and idempotencyKey', () => {
		const tool = getSendEmailTool(buildCtx())
		const inputSchema = tool.inputSchema as { shape: Record<string, unknown> }
		expect(Object.keys(inputSchema.shape)).toEqual(
			expect.arrayContaining(['to', 'subject', 'bodyText', 'bodyHtml', 'idempotencyKey']),
		)
	})

	it('sends to a workspace member and returns the provider message id, forwarding the idempotency key to Resend', async () => {
		mockSendEmail.mockResolvedValue({ id: 'msg_123' })
		const ctx = buildCtx({ db: makeAllowlistDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler({ ...VALID_ARGS, idempotencyKey: 'key-a' }, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload).toEqual({ ok: true, messageId: 'msg_123' })
		expect(mockSendEmail).toHaveBeenCalledWith({
			to: VALID_ARGS.to,
			subject: VALID_ARGS.subject,
			text: VALID_ARGS.bodyText,
			html: expect.stringContaining(VALID_ARGS.bodyText),
			idempotencyKey: 'key-a',
			analytics: {
				workspaceId: 'ws-1',
				emailType: 'agent',
				agentId: 'actor-1',
			},
		})
		expect(mockRecordAgentEmailSend).toHaveBeenCalledWith(ctx.db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			idempotencyKey: 'key-a',
			providerMessageId: 'msg_123',
		})
	})

	it('records a keyless send with idempotencyKey null', async () => {
		mockSendEmail.mockResolvedValue({ id: 'msg_keyless' })
		const ctx = buildCtx({ db: makeAllowlistDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		await tool.handler(VALID_ARGS, {})

		expect(mockRecordAgentEmailSend).toHaveBeenCalledWith(ctx.db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			idempotencyKey: null,
			providerMessageId: 'msg_keyless',
		})
	})

	it('rejects a recipient that is not a workspace member without calling sendEmail', async () => {
		const ctx = buildCtx({ db: makeAllowlistDb([]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler({ ...VALID_ARGS, to: 'stranger@external.com' }, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.ok).toBe(false)
		expect(payload.error).toBe('recipient_not_in_workspace')
		expect(mockSendEmail).not.toHaveBeenCalled()
	})

	it('returns recipient_not_in_workspace for a workspace with no members (non-existent)', async () => {
		const ctx = buildCtx({ db: makeAllowlistDb([]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler(VALID_ARGS, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.ok).toBe(false)
		expect(payload.error).toBe('recipient_not_in_workspace')
		expect(mockSendEmail).not.toHaveBeenCalled()
	})

	it('returns email_not_configured when RESEND_API_KEY / EMAIL_FROM are missing', async () => {
		mockReadResendEnv.mockImplementation(() => {
			throw new Error('RESEND_API_KEY environment variable is required')
		})
		const ctx = buildCtx({ db: makeAllowlistDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler(VALID_ARGS, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.ok).toBe(false)
		expect(payload.error).toBe('email_not_configured')
		expect(mockSendEmail).not.toHaveBeenCalled()
	})

	it('returns rate_limit_exceeded with retryAfterSeconds before touching allowlist or Resend', async () => {
		mockCheckAgentEmailRateLimit.mockResolvedValue({
			ok: false,
			error: 'rate_limit_exceeded',
			limit: 10,
			used: 10,
			retryAfterSeconds: 900,
		})
		const ctx = buildCtx({ db: makeAllowlistDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler(VALID_ARGS, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.ok).toBe(false)
		expect(payload.error).toBe('rate_limit_exceeded')
		expect(payload.retryAfterSeconds).toBe(900)
		expect(mockFindExistingAgentEmailSend).not.toHaveBeenCalled()
		expect(mockSendEmail).not.toHaveBeenCalled()
	})

	it('rate-limit fires even for an out-of-workspace recipient (probing must count)', async () => {
		mockCheckAgentEmailRateLimit.mockResolvedValue({
			ok: false,
			error: 'rate_limit_exceeded',
			limit: 10,
			used: 10,
			retryAfterSeconds: 30,
		})
		const ctx = buildCtx({ db: makeAllowlistDb([]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler({ ...VALID_ARGS, to: 'stranger@external.com' }, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.error).toBe('rate_limit_exceeded')
		expect(mockSendEmail).not.toHaveBeenCalled()
	})

	it('returns already_sent when the idempotency key was used before, without dispatching', async () => {
		mockFindExistingAgentEmailSend.mockResolvedValue({ providerMessageId: 'msg_prior' })
		const ctx = buildCtx({ db: makeAllowlistDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler({ ...VALID_ARGS, idempotencyKey: 'key-a' }, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload).toEqual({
			ok: false,
			error: 'already_sent',
			message: expect.any(String),
			idempotencyKey: 'key-a',
		})
		expect(mockSendEmail).not.toHaveBeenCalled()
		expect(mockRecordAgentEmailSend).not.toHaveBeenCalled()
	})

	it('skips the idempotency lookup when no key is supplied', async () => {
		mockSendEmail.mockResolvedValue({ id: 'msg_x' })
		const ctx = buildCtx({ db: makeAllowlistDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		await tool.handler(VALID_ARGS, {})

		expect(mockFindExistingAgentEmailSend).not.toHaveBeenCalled()
	})

	it('sanitizes a Resend failure: response carries generic message and no raw provider text', async () => {
		mockSendEmail.mockRejectedValue(
			new MockEmailSendError('bounced', 'Recipient member@example.com bounced'),
		)
		mockSanitizeSendError.mockReturnValue({
			code: 'provider_error',
			message: 'Email provider rejected the send. See server logs for the specific reason.',
		})
		const ctx = buildCtx({ db: makeAllowlistDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler(VALID_ARGS, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.ok).toBe(false)
		expect(payload.error).toBe('send_failed')
		expect(payload.message).toBe(
			'Email provider rejected the send. See server logs for the specific reason.',
		)
		expect(payload.message).not.toContain('bounced')
		expect(payload.message).not.toContain('member@example.com')
	})

	it('translates a ledger race (unique violation on record) into already_sent', async () => {
		mockSendEmail.mockResolvedValue({ id: 'msg_race' })
		mockRecordAgentEmailSend.mockRejectedValue({ code: '23505' })
		mockIsUniqueViolation.mockReturnValue(true)
		const ctx = buildCtx({ db: makeAllowlistDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler({ ...VALID_ARGS, idempotencyKey: 'key-a' }, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.ok).toBe(false)
		expect(payload.error).toBe('already_sent')
		expect(payload.idempotencyKey).toBe('key-a')
	})

	it('applies stripExternalImages to bodyText and bodyHtml before send', async () => {
		mockStripExternalImages.mockImplementation((body: string) => ({
			bodyText: body.replace(/<img[^>]*>/gi, '[external image removed]'),
			removed: 1,
		}))
		mockSendEmail.mockResolvedValue({ id: 'msg_456' })
		const ctx = buildCtx({ db: makeAllowlistDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		await tool.handler(
			{
				...VALID_ARGS,
				bodyText: 'Hi <img src="http://attacker/pixel.png">',
				bodyHtml: '<p>Hi <img src="http://attacker/pixel.png"></p>',
			},
			{},
		)

		expect(mockStripExternalImages).toHaveBeenCalledTimes(2)
		expect(mockSendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining('[external image removed]'),
				html: expect.stringContaining('[external image removed]'),
			}),
		)
	})

	it('derives a wrapped HTML body when bodyHtml is omitted, escaping the raw text', async () => {
		mockSendEmail.mockResolvedValue({ id: 'msg_789' })
		const ctx = buildCtx({ db: makeAllowlistDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		await tool.handler({ ...VALID_ARGS, bodyText: '<script>alert(1)</script>\nnext line' }, {})

		const call = mockSendEmail.mock.calls[0]?.[0] as { html: string }
		expect(call.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
		expect(call.html).toContain('white-space: pre-wrap')
	})

	it('matches the workspace-member email case-insensitively', async () => {
		mockSendEmail.mockResolvedValue({ id: 'msg_abc' })
		const ctx = buildCtx({ db: makeAllowlistDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler({ ...VALID_ARGS, to: 'Member@Example.COM' }, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.ok).toBe(true)
	})
})
