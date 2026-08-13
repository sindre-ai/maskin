import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSendEmail, mockReadResendEnv, mockStripExternalImages, MockEmailSendError } =
	vi.hoisted(() => {
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
			MockEmailSendError,
		}
	})

vi.mock('@maskin/email', () => ({
	sendEmail: mockSendEmail,
	readResendEnv: mockReadResendEnv,
	stripExternalImages: mockStripExternalImages,
	EmailSendError: MockEmailSendError,
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

function makeDb(rows: Array<{ actorId: string }>): Database {
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
		db: overrides.db ?? makeDb([]),
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
	})

	it('publishes a description that names all documented error codes and the rate limit', () => {
		const tool = getSendEmailTool(buildCtx())
		const description = tool.description ?? ''
		expect(description).toContain('recipient_not_in_workspace')
		expect(description).toContain('rate_limited')
		expect(description).toContain('send_failed')
		expect(description).toContain('email_not_configured')
		expect(description).not.toContain('not_available_yet')
		expect(description).toMatch(/10 sends per rolling hour/i)
	})

	it('exposes an input schema that lists to, subject, bodyText, and optional bodyHtml', () => {
		const tool = getSendEmailTool(buildCtx())
		const inputSchema = tool.inputSchema as { shape: Record<string, unknown> }
		expect(Object.keys(inputSchema.shape)).toEqual(
			expect.arrayContaining(['to', 'subject', 'bodyText', 'bodyHtml']),
		)
	})

	it('sends to a workspace member and returns the provider message id', async () => {
		mockSendEmail.mockResolvedValue({ id: 'msg_123' })
		const ctx = buildCtx({ db: makeDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler(VALID_ARGS, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload).toEqual({ ok: true, messageId: 'msg_123' })
		expect(mockSendEmail).toHaveBeenCalledWith({
			to: VALID_ARGS.to,
			subject: VALID_ARGS.subject,
			text: VALID_ARGS.bodyText,
			html: expect.stringContaining(VALID_ARGS.bodyText),
			analytics: {
				workspaceId: 'ws-1',
				emailType: 'agent',
				agentId: 'actor-1',
			},
		})
	})

	it('rejects a recipient that is not a workspace member without calling sendEmail', async () => {
		const ctx = buildCtx({ db: makeDb([]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler({ ...VALID_ARGS, to: 'stranger@external.com' }, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.ok).toBe(false)
		expect(payload.error).toBe('recipient_not_in_workspace')
		expect(mockSendEmail).not.toHaveBeenCalled()
	})

	it('returns recipient_not_in_workspace for a workspace with no members (non-existent)', async () => {
		// An empty member set is the correct answer for a non-existent
		// workspace too — keeps the tool from leaking existence.
		const ctx = buildCtx({ db: makeDb([]) })
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
		const ctx = buildCtx({ db: makeDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler(VALID_ARGS, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.ok).toBe(false)
		expect(payload.error).toBe('email_not_configured')
		expect(mockSendEmail).not.toHaveBeenCalled()
	})

	it('forwards a Resend transport failure as send_failed with the provider code', async () => {
		mockSendEmail.mockRejectedValue(new MockEmailSendError('bounced', 'Recipient bounced'))
		const ctx = buildCtx({ db: makeDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler(VALID_ARGS, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.ok).toBe(false)
		expect(payload.error).toBe('send_failed')
		expect(payload.message).toContain('bounced')
	})

	it('applies stripExternalImages to bodyText and bodyHtml before send', async () => {
		mockStripExternalImages.mockImplementation((body: string) => ({
			bodyText: body.replace(/<img[^>]*>/gi, '[external image removed]'),
			removed: 1,
		}))
		mockSendEmail.mockResolvedValue({ id: 'msg_456' })
		const ctx = buildCtx({ db: makeDb([{ actorId: 'member-1' }]) })
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
		const ctx = buildCtx({ db: makeDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		await tool.handler({ ...VALID_ARGS, bodyText: '<script>alert(1)</script>\nnext line' }, {})

		const call = mockSendEmail.mock.calls[0]?.[0] as { html: string }
		expect(call.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
		expect(call.html).toContain('white-space: pre-wrap')
	})

	it('matches the workspace-member email case-insensitively', async () => {
		mockSendEmail.mockResolvedValue({ id: 'msg_abc' })
		const ctx = buildCtx({ db: makeDb([{ actorId: 'member-1' }]) })
		const tool = getSendEmailTool(ctx)

		const result = await tool.handler({ ...VALID_ARGS, to: 'Member@Example.COM' }, {})

		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.ok).toBe(true)
	})
})
