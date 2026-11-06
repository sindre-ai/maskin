import { describe, expect, it } from 'vitest'
import { annotateToolsList, decideToolCall } from '../../../lib/integrations/mcp-gateway'
import { allows } from '../../../lib/integrations/tool-gate'
import { classifyResendTool, classifyTool } from '../../../lib/integrations/tool-kinds'

/**
 * Resend through the gateway: a curated read set, a short safe-write set, and everything
 * else held as `outbound`, which no access level unlocks. The three lists below are every
 * tool Resend's MCP lists today (30 Oct 2026). A tool added later is not in any list, so it
 * is held until someone reads its schema and decides, which is the point.
 */

const READ = [
	'get_more_tools',
	'get-automation',
	'get-automation-runs',
	'get-broadcast',
	'get-contact',
	'get-contact-import',
	'get-contact-property',
	'get-domain',
	'get-domain-claim',
	'get-email',
	'get-email-metrics',
	'get-file-upload',
	'get-inbox',
	'get-inbox-agent',
	'get-inbox-draft',
	'get-inbox-thread',
	'get-inbox-thread-email',
	'get-log',
	'get-received-email',
	'get-received-email-attachment',
	'get-segment',
	'get-sent-email-attachment',
	'get-suppression',
	'get-template',
	'get-tiptap-json-content',
	'get-topic',
	'get-usage',
	'get-webhook',
	'get-webhook-event',
	'list-api-keys',
	'list-broadcast-clicked-links',
	'list-broadcast-recipients',
	'list-broadcasts',
	'list-contact-imports',
	'list-contact-properties',
	'list-contact-segments',
	'list-contact-topics',
	'list-contacts',
	'list-domains',
	'list-emails',
	'list-inbox-drafts',
	'list-inbox-labels',
	'list-inbox-thread-emails',
	'list-inbox-threads',
	'list-inboxes',
	'list-logs',
	'list-oauth-grants',
	'list-received-email-attachments',
	'list-received-emails',
	'list-segments',
	'list-sent-email-attachments',
	'list-suppressions',
	'list-templates',
	'list-topics',
	'list-webhook-event-attempts',
	'list-webhook-events',
	'list-webhooks',
	'search-inbox-threads',
]

const SAFE_WRITE = [
	'create-template',
	'update-template',
	'duplicate-template',
	'publish-template',
	'remove-template',
	'create-contact',
	'update-contact',
	'remove-contact',
	'update-contact-topics',
	'create-contact-property',
	'update-contact-property',
	'remove-contact-property',
	'create-domain',
	'update-domain',
	'verify-domain',
	'remove-domain',
	'create-domain-claim',
	'verify-domain-claim',
]

/** Sends, or can set a send off, or opens a way around the gateway or around a person's approval. */
const HELD = [
	// The seven that send
	'send-email',
	'send-batch-emails',
	'send-broadcast',
	'send-inbox-draft',
	'send-new-inbox-email',
	'reply-to-inbox-thread-email',
	'forward-inbox-thread-email',
	// Set a send off, change or cancel one
	'send-event',
	'manage-events',
	'update-email',
	'cancel-email',
	'share-email',
	'create-broadcast',
	'update-broadcast',
	'duplicate-broadcast',
	'remove-broadcast',
	'cancel-broadcast',
	'compose-broadcast',
	'create-automation',
	'update-automation',
	'duplicate-automation',
	'remove-automation',
	// A key or a webhook is a way around the gateway or a way to read mail out
	'create-api-key',
	'update-api-key',
	'remove-api-key',
	'create-webhook',
	'update-webhook',
	'remove-webhook',
	'rotate-webhook-signing-secret',
	'replay-webhook-event',
	'revoke-oauth-grant',
	// Inboxes, drafts and threads
	'create-inbox',
	'update-inbox',
	'remove-inbox',
	'update-inbox-agent',
	'create-inbox-draft',
	'update-inbox-draft',
	'remove-inbox-draft',
	'create-inbox-label',
	'update-inbox-label',
	'remove-inbox-label',
	'add-inbox-thread-labels',
	'set-inbox-thread-labels',
	'remove-inbox-thread-label',
	'update-inbox-thread',
	'remove-inbox-thread',
	// Who may be emailed, and bulk audience changes
	'add-suppression',
	'batch-add-suppressions',
	'batch-remove-suppressions',
	'remove-suppression',
	'create-contact-import',
	'create-segment',
	'update-segment',
	'remove-segment',
	'add-contact-to-segment',
	'remove-contact-from-segment',
	'create-topic',
	'update-topic',
	'remove-topic',
	// Editor and uploads
	'compose-template',
	'connect-to-editor',
	'disconnect-from-editor',
	'create-file-upload',
]

describe('Resend tool classification', () => {
	it.each(READ)('%s is a read', (name) => {
		expect(classifyTool('resend', name)).toBe('read')
	})

	it.each(SAFE_WRITE)('%s is a safe write', (name) => {
		expect(classifyTool('resend', name)).toBe('write')
	})

	it.each(HELD)('%s is held', (name) => {
		expect(classifyTool('resend', name)).toBe('outbound')
	})

	it('has no tool in two lists', () => {
		const all = [...READ, ...SAFE_WRITE, ...HELD]
		expect(new Set(all).size).toBe(all.length)
	})

	it.each([
		'send-sms',
		'schedule-email',
		'get-and-send',
		'new-tool',
		'SEND-EMAIL',
		'send_email',
		'',
	])('holds a tool nobody classified: %j', (name) => {
		expect(classifyResendTool(name)).toBe('outbound')
	})

	it('is not moved by the server hints, which only the curated lists decide', () => {
		for (const annotations of [
			{ readOnlyHint: true },
			{ destructiveHint: false },
			{ readOnlyHint: true, destructiveHint: false },
		]) {
			expect(classifyTool('resend', 'send-email', annotations)).toBe('outbound')
			expect(classifyTool('resend', 'update-email', annotations)).toBe('outbound')
		}
		expect(classifyTool('resend', 'create-template', { readOnlyHint: true })).toBe('write')
		expect(classifyTool('resend', 'list-emails', { destructiveHint: true })).toBe('read')
	})

	it('leaves every other provider as it was', () => {
		expect(classifyTool('linear', 'create_issue')).toBe('write')
		expect(classifyTool('linear', 'list_issues')).toBe('read')
		expect(classifyTool('gmail', 'send-email')).toBe('write')
	})
})

describe('Resend in the gateway', () => {
	const base = { provider: 'resend', providerLabel: 'Resend' }

	it.each(HELD)('refuses %s for every access level, Read & write included', (toolName) => {
		for (const access of ['read_write', 'read', 'none'] as const) {
			const decision = decideToolCall({ ...base, toolName, access })
			expect(decision.allowed).toBe(false)
			expect(decision.kind).toBe('outbound')
		}
	})

	it('tells the agent what to do instead, in plain words', () => {
		const decision = decideToolCall({ ...base, toolName: 'send-email', access: 'read_write' })
		expect(decision.message).toContain('Held: send-email')
		expect(decision.message).toContain('resend_send_email')
		expect(decision.message).toContain('object_id')
		expect(decision.message).toContain('do not retry')
		// Not the "ask for more access" text: more access would not help.
		expect(decision.message).not.toContain('request_integration_access')
	})

	it('holds a broadcast whatever its arguments say, so no argument can make it a draft-only call', () => {
		const decision = decideToolCall({
			...base,
			toolName: 'create-broadcast',
			args: { scheduled_at: 'in 1 min', send: true },
			access: 'read_write',
		})
		expect(decision.allowed).toBe(false)
	})

	it('still lets Read read, and Read & write change templates, contacts and domains', () => {
		for (const toolName of READ) {
			expect(decideToolCall({ ...base, toolName, access: 'read' }).allowed).toBe(true)
			expect(decideToolCall({ ...base, toolName, access: 'none' }).allowed).toBe(false)
		}
		for (const toolName of SAFE_WRITE) {
			expect(decideToolCall({ ...base, toolName, access: 'read_write' }).allowed).toBe(true)
			expect(decideToolCall({ ...base, toolName, access: 'read' }).allowed).toBe(false)
		}
	})

	it('allows() lets no access level through a held tool', () => {
		for (const access of ['read_write', 'read', 'none'] as const) {
			expect(allows(access, 'outbound')).toBe(false)
		}
	})

	it('marks held tools unavailable in tools/list and never as read-only', () => {
		const tools = [...HELD.slice(0, 3), 'list-emails', 'create-template'].map((name) => ({
			name,
			description: `Resend ${name}`,
			annotations: { readOnlyHint: name.startsWith('send') },
		}))
		const { result } = annotateToolsList(
			{ tools },
			{ provider: 'resend', providerLabel: 'Resend', access: 'read_write' },
		)
		const byName = new Map(
			(
				result.tools as Array<{
					name: string
					description: string
					annotations: { readOnlyHint: boolean }
				}>
			).map((t) => [t.name, t]),
		)
		for (const name of HELD.slice(0, 3)) {
			expect(byName.get(name)?.description).toContain('[Held:')
			expect(byName.get(name)?.annotations.readOnlyHint).toBe(false)
		}
		expect(byName.get('list-emails')?.description).not.toContain('[Held:')
		expect(byName.get('list-emails')?.annotations.readOnlyHint).toBe(true)
		expect(byName.get('create-template')?.description).not.toContain('[Held:')
	})
})
