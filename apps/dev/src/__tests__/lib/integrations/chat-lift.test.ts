import { describe, expect, it } from 'vitest'
import { CHAT_LIFT_TEXT, isChatLiftable } from '../../../lib/integrations/chat-lift'
import { classifyTool } from '../../../lib/integrations/tool-kinds'

/**
 * The tool names Google's hosted Gmail server lists, as the workspace's Gmail connection showed
 * them in a live session on 13 Nov 2026. A lift on Gmail opens every one that classifies as a
 * write, so a new or renamed tool that slips in as a read, or a write left out, shows up here.
 */
const GMAIL_READ_TOOLS = [
	'get_draft',
	'get_message',
	'get_thread',
	'list_drafts',
	'list_labels',
	'search_threads',
]
const GMAIL_WRITE_TOOLS = [
	'apply_sensitive_message_label',
	'apply_sensitive_thread_label',
	'create_draft',
	'create_label',
	'label_message',
	'label_thread',
	'mark_message_spam',
	'mark_thread_spam',
	'trash_message',
	'trash_thread',
	'unlabel_message',
	'unlabel_thread',
	'unmark_message_spam',
	'unmark_thread_spam',
	'untrash_message',
	'untrash_thread',
	'update_message_labels',
]

describe('Gmail tool classification, for the chat lift', () => {
	it('classifies every read tool as a read and every other listed tool as a write', () => {
		for (const name of GMAIL_READ_TOOLS) expect(classifyTool('gmail', name), name).toBe('read')
		for (const name of GMAIL_WRITE_TOOLS) expect(classifyTool('gmail', name), name).toBe('write')
	})

	it('treats a send-shaped tool as a write, so a Read agent never reaches it', () => {
		for (const name of ['send_email', 'send_draft', 'gmail_send_email']) {
			expect(classifyTool('gmail', name), name).toBe('write')
		}
	})
})

describe('the chat lift allowlist', () => {
	it('lists Calendar, Meet, Gmail and Linear, each with its own fixed text', () => {
		for (const provider of ['google-calendar', 'google-meet', 'gmail', 'linear']) {
			expect(isChatLiftable(provider), provider).toBe(true)
		}
		expect(CHAT_LIFT_TEXT.gmail).toBe(
			'Lets this agent create drafts and change labels, and move mail to trash or spam, for 8 hours in this chat. Sending an email still needs its own approval.',
		)
		expect(CHAT_LIFT_TEXT.linear).toBe(
			'Lets this agent create, edit and delete Linear issues and comments for 8 hours in this chat.',
		)
	})

	it('leaves out every provider whose lift has not been decided', () => {
		for (const provider of [
			'posthog',
			'resend',
			'slack',
			'linkedin-unipile',
			'ubersuggest',
			'github',
		]) {
			expect(isChatLiftable(provider), provider).toBe(false)
		}
		// Inherited object keys must not count as providers.
		expect(isChatLiftable('toString')).toBe(false)
	})
})
