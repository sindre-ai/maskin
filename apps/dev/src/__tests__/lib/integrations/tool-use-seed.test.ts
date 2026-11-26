import { describe, expect, it } from 'vitest'
import {
	integrationsForServerKey,
	namesMergeTool,
	serverKeysInText,
	serverOfToolName,
} from '../../../lib/integrations/tool-use-seed'

const row = (
	provider: string,
	config: Record<string, unknown> = {},
	displayName: string | null = null,
) =>
	({
		id: `${provider}-${JSON.stringify(config)}-${displayName}`,
		provider,
		displayName,
		providerMode: 'registered',
		status: 'active',
		config,
		defaultAgentAccess: 'read',
	}) as const

describe('serverOfToolName', () => {
	it('reads the server out of a tool name', () => {
		expect(serverOfToolName('mcp__github-sindre-ai__list_pull_requests')).toBe('github-sindre-ai')
		expect(serverOfToolName('mcp__integration-gmail__create_draft')).toBe('integration-gmail')
		expect(serverOfToolName('mcp__github_approver__get_me')).toBe('github_approver')
	})
	it('returns null for a tool that is not from a tool server', () => {
		expect(serverOfToolName('Bash')).toBeNull()
	})
})

describe('serverKeysInText', () => {
	it('finds tool names and launch-spec server keys', () => {
		const keys = serverKeysInText(
			'use mcp__integration-slack__slack_send_message, then github-vaerksted-ai and integration-google-drive',
		)
		expect([...keys].sort()).toEqual([
			'github-vaerksted-ai',
			'integration-google-drive',
			'integration-slack',
		])
	})
})

describe('namesMergeTool', () => {
	it('spots the merge tools', () => {
		expect(namesMergeTool('call merge_pull_request when green')).toBe(true)
		expect(namesMergeTool('read the pull request')).toBe(false)
	})
})

describe('integrationsForServerKey', () => {
	const rows = [
		row('gmail'),
		row('github', { owner_login: 'sindre-ai' }),
		row('github', { owner_login: 'vaerksted-ai' }),
		row('linkedin-unipile'),
		row('slack'),
		row('posthog'),
		row('google-calendar'),
		row('custom-mcp', {}, 'Exa'),
	]
	it('maps each kind of server key to its integration', () => {
		expect(integrationsForServerKey('integration-gmail', rows).map((r) => r.provider)).toEqual([
			'gmail',
		])
		expect(integrationsForServerKey('github-vaerksted-ai', rows)).toHaveLength(1)
		expect(integrationsForServerKey('github', rows)).toHaveLength(2)
		expect(integrationsForServerKey('linkedin-magnus-personal', rows)[0]?.provider).toBe(
			'linkedin-unipile',
		)
	})
	it('maps a server named by its provider alone, as older sessions log it', () => {
		const providerOf = (key: string) => integrationsForServerKey(key, rows).map((r) => r.provider)
		expect(providerOf('slack')).toEqual(['slack'])
		expect(providerOf('posthog')).toEqual(['posthog'])
		expect(providerOf('google-calendar')).toEqual(['google-calendar'])
		expect(providerOf('gmail')).toEqual(['gmail'])
	})
	it('maps a custom tool server key to its one row', () => {
		const exa = rows.find((r) => r.displayName === 'Exa')
		expect(exa).toBeDefined()
		const key = `custom-exa-${exa?.id.slice(0, 8)}`
		expect(integrationsForServerKey(key, rows)).toEqual([exa])
		expect(integrationsForServerKey('custom-exa-00000000', rows)).toEqual([])
	})
	it('leaves Maskin’s own server and unknown keys alone', () => {
		expect(integrationsForServerKey('maskin', rows)).toEqual([])
		expect(integrationsForServerKey('integration-nothing', rows)).toEqual([])
		expect(integrationsForServerKey('github-merge', rows)).toEqual([])
		expect(integrationsForServerKey('github-mcp-server', rows)).toEqual([])
		expect(integrationsForServerKey('claude_ai_maskin', rows)).toEqual([])
	})
})
