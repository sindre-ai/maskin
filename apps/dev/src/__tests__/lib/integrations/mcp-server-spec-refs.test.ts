import { describe, expect, it } from 'vitest'
import { serverSpecReferencesEnvKey } from '../../../lib/integrations/mcp-server-spec-refs'

describe('serverSpecReferencesEnvKey', () => {
	it('returns true when an http url contains ${ENV_KEY}', () => {
		expect(
			serverSpecReferencesEnvKey(
				{ type: 'http', url: 'https://api.example.com/${POSTHOG_TOKEN}/mcp' },
				'POSTHOG_TOKEN',
			),
		).toBe(true)
	})

	it('returns true when an http header value contains ${ENV_KEY}', () => {
		expect(
			serverSpecReferencesEnvKey(
				{
					type: 'http',
					url: 'https://mcp.posthog.com/mcp',
					headers: { Authorization: 'Bearer ${POSTHOG_TOKEN}' },
				},
				'POSTHOG_TOKEN',
			),
		).toBe(true)
	})

	it('returns false for the linkedin-unipile shape — server references Maskin API key, not the provider envKey', () => {
		expect(
			serverSpecReferencesEnvKey(
				{
					type: 'http',
					url: '${MASKIN_API_URL}/api/integrations/linkedin-unipile/mcp',
					headers: {
						Authorization: 'Bearer ${MASKIN_API_KEY}',
						'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
					},
				},
				'LINKEDIN_UNIPILE_TOKEN',
			),
		).toBe(false)
	})

	it('returns false for the slack shape — server auth uses ${MASKIN_API_KEY} even though envKey is SLACK_BOT_TOKEN', () => {
		expect(
			serverSpecReferencesEnvKey(
				{
					type: 'http',
					url: '${MASKIN_API_URL}/api/integrations/slack/mcp',
					headers: {
						Authorization: 'Bearer ${MASKIN_API_KEY}',
						'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
					},
				},
				'SLACK_BOT_TOKEN',
			),
		).toBe(false)
	})

	it('returns true when a stdio env value contains ${ENV_KEY}', () => {
		expect(
			serverSpecReferencesEnvKey(
				{
					type: 'stdio',
					command: 'npx',
					args: ['-y', 'some-mcp-server'],
					env: { PROVIDER_ACCESS_TOKEN: '${PROVIDER_TOKEN}' },
				},
				'PROVIDER_TOKEN',
			),
		).toBe(true)
	})

	it('returns true when a stdio arg contains ${ENV_KEY}', () => {
		expect(
			serverSpecReferencesEnvKey(
				{
					type: 'stdio',
					command: 'npx',
					args: ['-y', 'mcp-remote', 'https://api.example.com/${GMAIL_TOKEN}'],
				},
				'GMAIL_TOKEN',
			),
		).toBe(true)
	})

	it('is not fooled by a partial name match (SLACK_BOT_TOKEN vs SLACK_TOKEN)', () => {
		expect(
			serverSpecReferencesEnvKey(
				{
					type: 'http',
					url: 'https://mcp.example.com',
					headers: { Authorization: 'Bearer ${SLACK_BOT_TOKEN}' },
				},
				'SLACK_TOKEN',
			),
		).toBe(false)
	})
})
