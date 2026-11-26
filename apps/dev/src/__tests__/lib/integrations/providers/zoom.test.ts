import { describe, expect, it } from 'vitest'
import { FLAGS, isFlagEnabled, parseFeatureFlagConfig } from '../../../../lib/feature-flags'
import {
	GATEWAY_PROVIDERS,
	buildUpstreamHeaders,
	gatewayServerSpec,
	rewriteMcpServersForGateway,
} from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/zoom/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'
import { integrationScopeGaps } from '../../../../lib/integrations/scope-drift'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Zoom provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('zoom')
		expect(config.displayName).toBe('Zoom')
	})

	it('says in the tile text that a paid plan and a recorded or AI Companion transcript are needed', () => {
		expect(config.description).toContain('paid Zoom plan')
		expect(config.description).toContain('AI Companion')
	})

	it('signs in at Zoom with PKCE and basic client auth, for the four transcript scopes only', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://zoom.us/oauth/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://zoom.us/oauth/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.tokenAuthMethod).toBe('client_secret_basic')
			expect(config.auth.config.clientIdEnv).toBe('ZOOM_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('ZOOM_CLIENT_SECRET')
			expect(config.auth.config.scopes).toEqual([
				'meeting:read:search',
				'meeting:read:assets',
				'cloud_recording:read:content',
				'cloud_recording:read:list_user_recordings',
			])
		}
	})

	it('declares Zoom hosted server with a bearer token', () => {
		expect(config.mcp?.envKey).toBe('ZOOM_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.zoom.us/mcp/zoom/streamable',
			headers: { Authorization: 'Bearer ${ZOOM_TOKEN}' },
		})
	})

	it('is registered, and a token that carries the scopes needs no reconnect', () => {
		expect(getProvider('zoom').config).toBe(config)
		expect(listProviders().map((p) => p.config.name)).toContain('zoom')
		expect(
			integrationScopeGaps(config, {
				scope:
					'meeting:read:search meeting:read:assets cloud_recording:read:content cloud_recording:read:list_user_recordings',
			}),
		).toEqual({ missing: [], needsReconnect: false })
	})

	it('is behind a flag that is off unless the actor is a tester', () => {
		const actor = '00000000-0000-4000-8000-000000000001'
		const off = parseFeatureFlagConfig({})
		const on = parseFeatureFlagConfig({
			FF_TESTER_ACTOR_IDS: actor,
			FF_TESTER_FEATURES: FLAGS.ZOOM,
		})
		expect(isFlagEnabled(actor, FLAGS.ZOOM, off)).toBe(false)
		expect(isFlagEnabled(actor, FLAGS.ZOOM, on)).toBe(true)
	})
})

describe('Zoom through the gateway', () => {
	it('is served by the gateway, so an agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('zoom')).toBe(true)
	})

	it('rewrites an entry for its server to the gateway', () => {
		const upstreams = new Map([['zoom', 'https://mcp.zoom.us/mcp/zoom/streamable']])
		const { servers, rewritten } = rewriteMcpServersForGateway(
			{ zoom: { type: 'http', url: 'https://mcp.zoom.us/mcp/zoom/streamable' } },
			upstreams,
		)
		expect(rewritten).toEqual(['zoom'])
		expect(servers?.zoom).toEqual(gatewayServerSpec('zoom'))
	})

	it('sends the token as a bearer header', () => {
		expect(buildUpstreamHeaders(config.mcp?.server?.headers, 'ZOOM_TOKEN', 'tok-1')).toEqual({
			Authorization: 'Bearer tok-1',
		})
	})

	it('lets a Read agent search meetings and read transcripts, and refuses everything else', () => {
		for (const tool of [
			'search_meetings',
			'get_meeting_assets',
			'get_recording_resource',
			'recordings_list',
		]) {
			expect(classifyTool('zoom', tool), tool).toBe('read')
		}
		for (const tool of [
			'create_new_file_with_markdown',
			'hub_create_file_from_content',
			'search_zoom',
			'a_tool_added_later',
		]) {
			expect(classifyTool('zoom', tool), tool).toBe('write')
		}
		// A server annotation cannot talk a tool outside the list into being a read.
		expect(classifyTool('zoom', 'create_new_file_with_markdown', { readOnlyHint: true })).toBe(
			'write',
		)
	})
})
