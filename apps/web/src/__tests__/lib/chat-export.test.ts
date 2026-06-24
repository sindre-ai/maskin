import { buildChatExportFilename, formatChatMarkdown } from '@/lib/chat-export'
import type { ChatEvent } from '@/lib/chat-stream'
import { describe, expect, it } from 'vitest'

const CTX = {
	workspaceId: 'ws-1',
	frontendUrl: 'https://maskin.io',
	userName: 'Magnus',
	agentName: 'Sindre',
}

describe('formatChatMarkdown', () => {
	it('renders a user turn with attached objects as linked titles', () => {
		const events: ChatEvent[] = [
			{
				kind: 'user',
				text: 'What does this object contain?',
				attachments: [{ kind: 'object', id: 'obj-1', title: 'Webhook retry backlog', type: 'bet' }],
			},
			{ kind: 'text', text: 'The object is a bet and contains text about the backlog.' },
		]

		expect(formatChatMarkdown(events, CTX)).toBe(
			[
				'# Conversation with Sindre in Maskin',
				'',
				'## Magnus',
				'',
				'[Webhook retry backlog](https://maskin.io/ws-1/objects/obj-1)',
				'',
				'What does this object contain?',
				'',
				'## Sindre',
				'',
				'The object is a bet and contains text about the backlog.',
				'',
			].join('\n'),
		)
	})

	it('concatenates consecutive assistant text blocks into one section', () => {
		const events: ChatEvent[] = [
			{ kind: 'user', text: 'hi' },
			{ kind: 'text', text: 'First chunk.' },
			{ kind: 'tool_use', id: 't1', name: 'search', input: {} },
			{ kind: 'text', text: 'Second chunk.' },
		]

		expect(formatChatMarkdown(events, CTX)).toBe(
			[
				'# Conversation with Sindre in Maskin',
				'',
				'## Magnus',
				'',
				'hi',
				'',
				'## Sindre',
				'',
				'First chunk.',
				'',
				'Second chunk.',
				'',
			].join('\n'),
		)
	})

	it('falls back to "Untitled" when an attached object has no title', () => {
		const events: ChatEvent[] = [
			{
				kind: 'user',
				text: 'summarize',
				attachments: [{ kind: 'object', id: 'obj-x', title: null, type: null }],
			},
		]

		expect(formatChatMarkdown(events, CTX)).toContain(
			'[Untitled](https://maskin.io/ws-1/objects/obj-x)',
		)
	})
})

describe('buildChatExportFilename', () => {
	it('slugifies the agent name and stamps the date', () => {
		expect(buildChatExportFilename('Sindre', new Date('2026-04-20T10:00:00Z'))).toBe(
			'sindre-2026-04-20.md',
		)
		expect(buildChatExportFilename('My Custom Agent!', new Date('2026-04-20T10:00:00Z'))).toBe(
			'my-custom-agent-2026-04-20.md',
		)
	})
})
