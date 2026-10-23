import type { Database } from '@maskin/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const recordEvent = vi.fn(async () => {})
vi.mock('../../../lib/events/record-event', () => ({
	recordEvent: (...a: unknown[]) => recordEvent(...(a as [])),
}))

import { MISSING_TOOL_BLOCK, buildAccessPreamble } from '../../../lib/integrations/access-preamble'
import {
	type AgentAccess,
	canRead,
	canWrite,
	effectiveAccess,
} from '../../../lib/integrations/agent-access'
import {
	accessDeniedMessage,
	gateMcpServer,
	unavailableNote,
} from '../../../lib/integrations/tool-gate'
import { classifyTool } from '../../../lib/integrations/tool-kinds'

describe('classifyTool', () => {
	it('uses the curated lists for our own providers and treats the rest as writes', () => {
		expect(classifyTool('slack', 'slack_get_channel_history')).toBe('read')
		expect(classifyTool('slack', 'slack_send_message')).toBe('write')
		// Joining a channel and opening a DM change state: writes.
		expect(classifyTool('slack', 'slack_join_channel')).toBe('write')
		expect(classifyTool('slack', 'slack_open_conversation')).toBe('write')
		expect(classifyTool('google-meet', 'google_meet__list_participants')).toBe('read')
		expect(classifyTool('google-meet', 'google_meet__create_space')).toBe('write')
	})

	it('matches a LinkedIn verb behind its per-identity prefix', () => {
		expect(classifyTool('linkedin-unipile', 'linkedin-acc-me__get_profile')).toBe('read')
		expect(classifyTool('linkedin-unipile', 'linkedin-acc-me__publish_post')).toBe('write')
		expect(classifyTool('linkedin-unipile', 'linkedin-acc-me__send_connection_request')).toBe(
			'write',
		)
	})

	it('fails closed on a tool nobody classified, even if its name or annotation looks like a read', () => {
		expect(classifyTool('slack', 'slack_brand_new_tool')).toBe('write')
		expect(classifyTool('slack', 'slack_list_everything', { readOnlyHint: true })).toBe('write')
	})

	it('trusts a hosted server read-only hint, but never a missing or destructive one', () => {
		expect(classifyTool('linear', 'anything', { readOnlyHint: true })).toBe('read')
		expect(classifyTool('linear', 'get_issue', { destructiveHint: true })).toBe('write')
		expect(classifyTool('linear', 'frobnicate')).toBe('write')
	})

	it('falls back to read-looking names for hosted servers, but not when a write word is in them', () => {
		expect(classifyTool('linear', 'list_issues')).toBe('read')
		expect(classifyTool('gmail', 'search_threads')).toBe('read')
		expect(classifyTool('linear', 'get_or_create_label')).toBe('write')
		expect(classifyTool('github', 'list_and_delete_branches')).toBe('write')
		expect(classifyTool('github', 'create_pull_request')).toBe('write')
		expect(classifyTool('github', 'merge_pull_request')).toBe('write')
	})
})

describe('access levels', () => {
	it.each<[AgentAccess, boolean, boolean]>([
		['none', false, false],
		['read', true, false],
		['read_write', true, true],
	])('%s: can read %s, can write %s', (access, read, write) => {
		expect(canRead(access)).toBe(read)
		expect(canWrite(access)).toBe(write)
	})

	it('resolves from a grant, the default, and the Keychain rule', () => {
		const reg = { providerMode: 'registered' as const, defaultAgentAccess: 'read' as const }
		expect(effectiveAccess(reg, null)).toBe('read')
		expect(effectiveAccess({ ...reg, defaultAgentAccess: 'none' }, null)).toBe('none')
		expect(effectiveAccess(reg, 'read_write')).toBe('read_write')
		// A saved key or login is on or off: its own entry, else its default (none unless set to read).
		const login = { ...reg, providerMode: 'byo_login' as const }
		expect(effectiveAccess({ ...login, defaultAgentAccess: 'none' }, null)).toBe('none')
		expect(effectiveAccess({ ...login, defaultAgentAccess: 'read' }, null)).toBe('read_write')
		expect(effectiveAccess({ ...login, defaultAgentAccess: 'read' }, 'none')).toBe('none')
	})
})

describe('refusal messages', () => {
	it('say what was needed, what the agent has, and who can change it', () => {
		const msg = accessDeniedMessage({
			providerLabel: 'Slack',
			toolName: 'slack_send_message',
			kind: 'write',
			access: 'read',
		})
		expect(msg).toContain('slack_send_message needs write access to Slack')
		expect(msg).toContain('"Read"')
		expect(msg).toContain('do not retry')
		expect(msg).toContain('Settings → Integrations')
		// In a chat the agent asks with a card, naming the level the call needed.
		expect(msg).toContain('request_integration_access for Slack with level "read_write"')
	})

	it('names a missing grant plainly', () => {
		expect(unavailableNote('Slack', 'read', 'none')).toBe(
			'[Unavailable: you have no access to Slack.]',
		)
		expect(unavailableNote('Slack', 'write', 'read')).toContain('needs write access')
	})
})

describe('gateMcpServer (through a real MCP client)', () => {
	const gateCfg = (access: AgentAccess) => ({
		db: {} as Database,
		workspaceId: 'ws-1',
		actorId: 'agent-1',
		integrationId: 'int-1',
		provider: 'slack',
		providerLabel: 'Slack',
		access,
	})

	async function connect(access: AgentAccess) {
		const server = new McpServer({ name: 'test', version: '0.0.0' })
		gateMcpServer(server, gateCfg(access))
		const reads = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'channels' }] }))
		const writes = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'sent' }] }))
		server.registerTool(
			'slack_list_channels',
			{ description: 'List channels.', inputSchema: { q: z.string().optional() } },
			reads,
		)
		server.registerTool(
			'slack_send_message',
			{ description: 'Send a message.', inputSchema: { text: z.string() } },
			writes,
		)
		const client = new Client({ name: 'c', version: '0.0.0' })
		const [a, b] = InMemoryTransport.createLinkedPair()
		await Promise.all([server.connect(a), client.connect(b)])
		return { client, reads, writes }
	}

	beforeEach(() => recordEvent.mockClear())

	it('lets a read & write agent call everything', async () => {
		const { client, reads, writes } = await connect('read_write')
		expect(
			(await client.callTool({ name: 'slack_list_channels', arguments: {} })).isError,
		).toBeFalsy()
		expect(
			(await client.callTool({ name: 'slack_send_message', arguments: { text: 'hi' } })).isError,
		).toBeFalsy()
		expect(reads).toHaveBeenCalledOnce()
		expect(writes).toHaveBeenCalledOnce()
		expect(recordEvent).not.toHaveBeenCalled()
	})

	it('refuses a write for a read-only agent with a clear message, never running the handler', async () => {
		const { client, reads, writes } = await connect('read')
		expect(
			(await client.callTool({ name: 'slack_list_channels', arguments: {} })).isError,
		).toBeFalsy()
		const denied = await client.callTool({ name: 'slack_send_message', arguments: { text: 'hi' } })
		expect(denied.isError).toBe(true)
		expect(JSON.stringify(denied.content)).toContain('needs write access to Slack')
		expect(reads).toHaveBeenCalledOnce()
		expect(writes).not.toHaveBeenCalled()
		expect(recordEvent).toHaveBeenCalledOnce()
		expect(recordEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: 'agent_access_denied',
				entityId: 'int-1',
				actorId: 'agent-1',
				data: expect.objectContaining({
					tool: 'slack_send_message',
					kind: 'write',
					access: 'read',
				}),
			}),
		)
	})

	it('refuses everything for an agent with no access', async () => {
		const { client, reads, writes } = await connect('none')
		for (const name of ['slack_list_channels', 'slack_send_message']) {
			const res = await client.callTool({ name, arguments: { text: 'x' } })
			expect(res.isError).toBe(true)
			expect(JSON.stringify(res.content)).toContain('no access to Slack')
		}
		expect(reads).not.toHaveBeenCalled()
		expect(writes).not.toHaveBeenCalled()
	})

	it('says so in the tool list before the agent tries, and marks reads read-only', async () => {
		const { client } = await connect('read')
		const { tools } = await client.listTools()
		const send = tools.find((t) => t.name === 'slack_send_message')
		const list = tools.find((t) => t.name === 'slack_list_channels')
		expect(send?.description).toContain('[Unavailable: needs write access to Slack')
		expect(list?.description).toBe('List channels.')
		expect(list?.annotations?.readOnlyHint).toBe(true)
		expect(send?.annotations?.readOnlyHint).toBe(false)
	})

	it('still returns the refusal when the audit event cannot be written', async () => {
		recordEvent.mockRejectedValueOnce(new Error('db down'))
		const { client } = await connect('read')
		const denied = await client.callTool({ name: 'slack_send_message', arguments: { text: 'hi' } })
		expect(denied.isError).toBe(true)
	})
})

describe('buildAccessPreamble', () => {
	const row = (provider: string, access: AgentAccess, providerMode = 'registered') =>
		({
			integrationId: `${provider}-${access}`,
			provider,
			providerMode,
			displayName: null,
			access,
		}) as Parameters<typeof buildAccessPreamble>[0][number]

	it('is empty when nothing is connected, so a bare workspace adds no text', () => {
		expect(buildAccessPreamble([])).toBe('')
	})

	it('leaves saved keys and logins out', () => {
		expect(buildAccessPreamble([row('custom', 'read_write', 'byo_apikey')])).toBe('')
	})

	it('lists each integration with the level, and tells the agent what to do on a refusal', () => {
		const text = buildAccessPreamble([
			row('slack', 'read'),
			row('linear', 'read_write'),
			row('gmail', 'none'),
		])
		expect(text).toContain('## Integration access')
		expect(text).toContain('- Slack: Read (read tools only')
		expect(text).toMatch(/- linear: Read & write/i)
		expect(text).toMatch(/- gmail: No access/i)
		expect(text).toContain('do not retry')
		expect(text.endsWith('\n\n')).toBe(true)
	})

	it('points an agent with a person to ask at the missing-tool steps, others at Settings', () => {
		const rows = [row('slack', 'read')]
		const withPerson = buildAccessPreamble(rows, { personReachable: true })
		expect(withPerson).toContain('Follow "When a tool or login is missing" below.')
		expect(withPerson).not.toContain('Settings')
		const alone = buildAccessPreamble(rows)
		expect(alone).toContain('a workspace admin can change it under Settings')
		expect(alone).not.toContain('Tell the person')
	})

	it('names the card tools in the missing-tool steps', () => {
		for (const tool of [
			'list_integrations',
			'list_keychain_credentials',
			'list_integration_providers',
			'request_keychain_access',
			'request_keychain_credential',
			'connect_integration',
			'request_integration_access',
		]) {
			expect(MISSING_TOOL_BLOCK).toContain(tool)
		}
		expect(MISSING_TOOL_BLOCK.endsWith('\n\n')).toBe(true)
	})

	it('tells the agent that Gmail still needs a person to approve each email', () => {
		const text = buildAccessPreamble([row('gmail', 'read_write')])
		expect(text).toMatch(
			/- gmail: Read & write \(all tools, but a person has to approve each email before you send it\)/i,
		)
	})

	it('folds several accounts of one provider into one line when they differ', () => {
		const text = buildAccessPreamble([row('github', 'read_write'), row('github', 'read')])
		expect(text.match(/- github:/gi)).toHaveLength(1)
		expect(text).toContain('on some accounts')
	})
})
