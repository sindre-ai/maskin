import { describe, expect, it } from 'vitest'
import {
	integrationsForServerKey,
	namesMergeTool,
	serverKeysInText,
	serverOfToolName,
} from '../../../lib/integrations/tool-use-seed'

const row = (provider: string, config: Record<string, unknown> = {}) =>
	({
		id: `${provider}-${JSON.stringify(config)}`,
		provider,
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
	it('leaves Maskin’s own server and unknown keys alone', () => {
		expect(integrationsForServerKey('maskin', rows)).toEqual([])
		expect(integrationsForServerKey('integration-nothing', rows)).toEqual([])
	})
})
