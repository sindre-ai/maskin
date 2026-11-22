import { describe, expect, it } from 'vitest'
import { FLAGS, isFlagEnabled, parseFeatureFlagConfig } from '../../../../lib/feature-flags'
import {
	GATEWAY_PROVIDERS,
	buildUpstreamHeaders,
	gatewayServerSpec,
	rewriteMcpServersForGateway,
	withReadOnlyHeaders,
} from '../../../../lib/integrations/mcp-gateway'
import {
	config,
	parseTokenResponse,
} from '../../../../lib/integrations/providers/azure-devops/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'
import { integrationScopeGaps } from '../../../../lib/integrations/scope-drift'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Azure DevOps provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('azure-devops')
		expect(config.displayName).toBe('Azure DevOps')
	})

	it('signs in at Entra for work or school accounts, for the MCP server scope, with PKCE', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe(
				'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
			)
			expect(config.auth.config.tokenUrl).toBe(
				'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
			)
			expect(config.auth.config.scopes).toEqual([
				'offline_access',
				'https://mcp.dev.azure.com/.default',
			])
			expect(config.auth.config.pkce).toBe(true)
			// Same Entra app registration as the Microsoft provider: no new secret.
			expect(config.auth.config.clientIdEnv).toBe('MICROSOFT_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('MICROSOFT_CLIENT_SECRET')
		}
	})

	it('declares the hosted server without an organisation, limited to repos, work items and pipelines', () => {
		expect(config.mcp?.envKey).toBe('AZURE_DEVOPS_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.dev.azure.com/',
			headers: {
				Authorization: 'Bearer ${AZURE_DEVOPS_TOKEN}',
				'X-MCP-Toolsets': 'repos,wit,pipelines',
			},
		})
	})

	it('is registered with its token parser', () => {
		expect(getProvider('azure-devops').config).toBe(config)
		expect(getProvider('azure-devops').parseTokenResponse).toBe(parseTokenResponse)
		expect(listProviders().map((p) => p.config.name)).toContain('azure-devops')
	})

	it('is behind a flag that is off unless the actor is a tester', () => {
		const actor = '00000000-0000-4000-8000-000000000001'
		const off = parseFeatureFlagConfig({})
		const on = parseFeatureFlagConfig({
			FF_TESTER_ACTOR_IDS: actor,
			FF_TESTER_FEATURES: FLAGS.AZURE_DEVOPS,
		})
		expect(isFlagEnabled(actor, FLAGS.AZURE_DEVOPS, off)).toBe(false)
		expect(isFlagEnabled(actor, FLAGS.AZURE_DEVOPS, on)).toBe(true)
	})
})

describe('Azure DevOps through the gateway', () => {
	it('is served by the gateway, so an agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('azure-devops')).toBe(true)
	})

	it('rewrites an entry for its server to the gateway, so the trailing slash does not matter', () => {
		const upstreams = new Map([['azure-devops', 'https://mcp.dev.azure.com/']])
		const { servers, rewritten } = rewriteMcpServersForGateway(
			{ ado: { type: 'http', url: 'https://mcp.dev.azure.com' } },
			upstreams,
		)
		expect(rewritten).toEqual(['ado'])
		expect(servers?.ado).toEqual(gatewayServerSpec('azure-devops'))
	})

	it('sends the toolsets and the token to every agent, and the read-only switch only to a reader', () => {
		const base = buildUpstreamHeaders(config.mcp?.server?.headers, 'AZURE_DEVOPS_TOKEN', 'tok-1')
		expect(base).toEqual({ Authorization: 'Bearer tok-1', 'X-MCP-Toolsets': 'repos,wit,pipelines' })
		const readOnly = config.mcp?.readOnlyHeaders

		expect(withReadOnlyHeaders(base, readOnly, 'read')).toEqual({
			...base,
			'X-MCP-Readonly': 'true',
		})
		expect(withReadOnlyHeaders(base, readOnly, 'none')).toEqual({
			...base,
			'X-MCP-Readonly': 'true',
		})
		expect(withReadOnlyHeaders(base, readOnly, 'read_write')).toEqual(base)
	})

	it('lets a Read agent use the read dispatchers and refuses every write tool', () => {
		for (const tool of [
			'core_list_projects',
			'wit_work_item',
			'search_workitem',
			'repo_pull_request',
			'repo_file',
			'search_code',
			'pipelines_build',
			'wit_work_item_attachment',
		]) {
			expect(classifyTool('azure-devops', tool), tool).toBe('read')
		}
		for (const tool of [
			'wit_work_item_write',
			'wit_work_item_comment_write',
			'wit_work_item_link_write',
			'wit_work_item_attachment_upload',
			'wit_work_item_attachment_link',
			'repo_pull_request_write',
			'repo_pull_request_thread_write',
			'repo_create_branch',
			'pipelines_write',
			'wiki_upsert_page',
			'a_tool_added_later',
		]) {
			expect(classifyTool('azure-devops', tool), tool).toBe('write')
		}
		// A server annotation cannot talk a tool outside the list into being a read.
		expect(classifyTool('azure-devops', 'pipelines_write', { readOnlyHint: true })).toBe('write')
	})
})

describe('Azure DevOps parseTokenResponse', () => {
	it('adds .default and offline_access, which Entra does not list, so a healthy install is not asked to reconnect', () => {
		const parsed = parseTokenResponse({
			access_token: 'a',
			refresh_token: 'r',
			scope: '499b84ac-1321-427f-aa17-267ca6975798/user_impersonation',
		})
		expect(parsed.scope).toContain('https://mcp.dev.azure.com/.default')
		expect(parsed.scope).toContain('offline_access')
		expect(integrationScopeGaps(config, { scope: parsed.scope })).toEqual({
			missing: [],
			needsReconnect: false,
		})
	})

	it('does not add offline_access when no refresh token came back', () => {
		const parsed = parseTokenResponse({ access_token: 'a', scope: 'x/user_impersonation' })
		expect(parsed.scope).not.toContain('offline_access')
	})

	it('leaves a scope string that already lists both alone, and a missing one unknown', () => {
		expect(
			parseTokenResponse({
				refresh_token: 'r',
				scope: 'offline_access https://mcp.dev.azure.com/.default',
			}),
		).toEqual({})
		expect(parseTokenResponse({ access_token: 'a', refresh_token: 'r' })).toEqual({})
	})
})
