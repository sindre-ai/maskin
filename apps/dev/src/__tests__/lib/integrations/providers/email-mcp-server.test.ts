import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmailMcpServer } from '../../../../lib/integrations/providers/email/mcp-server'

const ctx = {
	workspaceId: 'ws-1',
	actorId: 'actor-1',
	agentLabel: 'Synthesizer · in mesh-firm',
}

type RegisteredTool = {
	description?: string
	inputSchema?: unknown
	handler: (
		args: unknown,
		extra: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>
	}>
}

function getSendEmailTool(): RegisteredTool {
	const server = createEmailMcpServer(ctx)
	const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
		._registeredTools
	const tool = tools.send_email
	expect(tool).toBeDefined()
	return tool
}

describe('createEmailMcpServer — send_email', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('publishes a description that names all documented error codes and the rate limit', () => {
		const tool = getSendEmailTool()
		const description = tool.description ?? ''
		expect(description).toContain('recipient_not_in_workspace')
		expect(description).toContain('rate_limited')
		expect(description).toContain('send_failed')
		expect(description).toContain('email_not_configured')
		expect(description).toMatch(/10 sends per rolling hour/i)
	})

	it('exposes an input schema that lists to, subject, bodyText, and optional bodyHtml', () => {
		const tool = getSendEmailTool()
		const inputSchema = tool.inputSchema as { shape: Record<string, unknown> }
		expect(Object.keys(inputSchema.shape)).toEqual(
			expect.arrayContaining(['to', 'subject', 'bodyText', 'bodyHtml']),
		)
	})

	it('returns a structured not_available_yet envelope until the T6 send handler lands', async () => {
		const tool = getSendEmailTool()
		const result = await tool.handler(
			{
				to: 'member@example.com',
				subject: 'Test',
				bodyText: 'Hello there',
			},
			{},
		)

		expect(result.content).toHaveLength(1)
		expect(result.content[0]?.type).toBe('text')
		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload).toEqual({
			ok: false,
			error: 'not_available_yet',
			message: expect.stringMatching(/send_email is registered/i),
		})
	})

	it('accepts an optional bodyHtml argument in the stub path', async () => {
		const tool = getSendEmailTool()
		const result = await tool.handler(
			{
				to: 'member@example.com',
				subject: 'Test',
				bodyText: 'Hello',
				bodyHtml: '<p>Hello</p>',
			},
			{},
		)
		const payload = JSON.parse(result.content[0]?.text ?? '{}')
		expect(payload.ok).toBe(false)
		expect(payload.error).toBe('not_available_yet')
	})
})
