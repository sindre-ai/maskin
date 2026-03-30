import { afterEach, describe, expect, it, vi } from 'vitest'
import { config, resolveExternalId } from '../../../../lib/integrations/providers/linear/config'
import { linearEventNormalizer } from '../../../../lib/integrations/providers/linear/webhooks'

describe('Linear provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('linear')
		expect(config.displayName).toBe('Linear')
	})

	it('uses standard oauth2 auth type', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://linear.app/oauth/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://api.linear.app/oauth/token')
			expect(config.auth.config.revokeUrl).toBe('https://api.linear.app/oauth/revoke')
			expect(config.auth.config.clientIdEnv).toBe('LINEAR_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('LINEAR_CLIENT_SECRET')
			expect(config.auth.config.scopes).toContain('read')
			expect(config.auth.config.scopes).toContain('write')
			expect(config.auth.config.scopes).toContain('issues:create')
			expect(config.auth.config.scopes).toContain('comments:create')
			expect(config.auth.config.pkce).toBe(true)
		}
	})

	it('has webhook config with hmac-sha256 scheme', () => {
		const wh = config.webhook
		expect(wh).toBeDefined()
		expect(wh).not.toHaveProperty('type')
		if (wh && 'signatureScheme' in wh) {
			expect(wh.signatureScheme).toBe('hmac-sha256')
			expect(wh.signatureHeader).toBe('linear-signature')
			expect(wh.secretEnv).toBe('LINEAR_WEBHOOK_SECRET')
		}
	})

	it('has MCP server config', () => {
		expect(config.mcp).toBeDefined()
		expect(config.mcp?.command).toBe('npx')
		expect(config.mcp?.args).toEqual(['-y', 'mcp-remote', 'https://mcp.linear.app/mcp'])
		expect(config.mcp?.envKey).toBe('LINEAR_API_KEY')
	})

	it('defines event types', () => {
		expect(config.events?.definitions).toBeDefined()
		const types = config.events?.definitions.map((d) => d.entityType)
		expect(types).toContain('linear.issue')
		expect(types).toContain('linear.comment')
		expect(types).toContain('linear.project')
		expect(types).toContain('linear.cycle')
		expect(types).toContain('linear.label')
		expect(types).toContain('linear.project_update')
	})
})

describe('resolveExternalId', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('returns organization ID from Linear GraphQL API', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			json: () =>
				Promise.resolve({
					data: { organization: { id: 'org-uuid-123' } },
				}),
		} as Response)

		const id = await resolveExternalId({ accessToken: 'lin_test_token' })
		expect(id).toBe('org-uuid-123')
		expect(globalThis.fetch).toHaveBeenCalledWith(
			'https://api.linear.app/graphql',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer lin_test_token',
				}),
			}),
		)
	})

	it('throws when organization ID is missing', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			json: () => Promise.resolve({ data: { organization: null } }),
		} as Response)

		await expect(resolveExternalId({ accessToken: 'bad' })).rejects.toThrow(
			'Failed to resolve Linear organization ID',
		)
	})

	it('throws when API returns errors', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			json: () =>
				Promise.resolve({
					errors: [{ message: 'Authentication required' }],
				}),
		} as Response)

		await expect(resolveExternalId({ accessToken: 'invalid' })).rejects.toThrow(
			'Failed to resolve Linear organization ID',
		)
	})
})

describe('linearEventNormalizer', () => {
	it('normalizes Issue create event', () => {
		const payload = {
			action: 'create',
			type: 'Issue',
			organizationId: 'org-123',
			data: { id: 'issue-1', title: 'Test issue' },
		}
		const result = linearEventNormalizer(payload, {})

		expect(result).toEqual({
			entityType: 'linear.issue',
			action: 'create',
			installationId: 'org-123',
			data: {
				id: 'issue-1',
				title: 'Test issue',
				organizationId: 'org-123',
				webhookType: 'Issue',
			},
		})
	})

	it('normalizes Issue update event', () => {
		const payload = {
			action: 'update',
			type: 'Issue',
			organizationId: 'org-123',
			data: { id: 'issue-1', title: 'Updated issue' },
		}
		const result = linearEventNormalizer(payload, {})

		expect(result?.entityType).toBe('linear.issue')
		expect(result?.action).toBe('update')
	})

	it('normalizes Issue remove event', () => {
		const payload = {
			action: 'remove',
			type: 'Issue',
			organizationId: 'org-123',
			data: { id: 'issue-1' },
		}
		const result = linearEventNormalizer(payload, {})

		expect(result?.entityType).toBe('linear.issue')
		expect(result?.action).toBe('remove')
	})

	it('normalizes Comment event', () => {
		const payload = {
			action: 'create',
			type: 'Comment',
			organizationId: 'org-123',
			data: { id: 'comment-1', body: 'A comment' },
		}
		const result = linearEventNormalizer(payload, {})

		expect(result?.entityType).toBe('linear.comment')
		expect(result?.action).toBe('create')
	})

	it('normalizes Project event', () => {
		const payload = {
			action: 'update',
			type: 'Project',
			organizationId: 'org-123',
			data: { id: 'project-1', name: 'My project' },
		}
		const result = linearEventNormalizer(payload, {})

		expect(result?.entityType).toBe('linear.project')
		expect(result?.action).toBe('update')
	})

	it('normalizes Cycle event', () => {
		const payload = {
			action: 'create',
			type: 'Cycle',
			organizationId: 'org-123',
			data: { id: 'cycle-1' },
		}
		const result = linearEventNormalizer(payload, {})

		expect(result?.entityType).toBe('linear.cycle')
		expect(result?.action).toBe('create')
	})

	it('normalizes Label event', () => {
		const payload = {
			action: 'create',
			type: 'Label',
			organizationId: 'org-123',
			data: { id: 'label-1', name: 'Bug' },
		}
		const result = linearEventNormalizer(payload, {})

		expect(result?.entityType).toBe('linear.label')
	})

	it('normalizes IssueLabel as linear.label', () => {
		const payload = {
			action: 'create',
			type: 'IssueLabel',
			organizationId: 'org-123',
			data: { id: 'issuelabel-1' },
		}
		const result = linearEventNormalizer(payload, {})

		expect(result?.entityType).toBe('linear.label')
	})

	it('normalizes ProjectUpdate event', () => {
		const payload = {
			action: 'create',
			type: 'ProjectUpdate',
			organizationId: 'org-123',
			data: { id: 'update-1', body: 'Status update' },
		}
		const result = linearEventNormalizer(payload, {})

		expect(result?.entityType).toBe('linear.project_update')
	})

	it('returns null for unknown entity type', () => {
		const payload = {
			action: 'create',
			type: 'UnknownType',
			organizationId: 'org-123',
			data: {},
		}
		expect(linearEventNormalizer(payload, {})).toBeNull()
	})

	it('returns null when organizationId is missing', () => {
		const payload = { action: 'create', type: 'Issue', data: {} }
		expect(linearEventNormalizer(payload, {})).toBeNull()
	})

	it('returns null when type is missing', () => {
		const payload = { action: 'create', organizationId: 'org-123', data: {} }
		expect(linearEventNormalizer(payload, {})).toBeNull()
	})

	it('returns null when action is missing', () => {
		const payload = { type: 'Issue', organizationId: 'org-123', data: {} }
		expect(linearEventNormalizer(payload, {})).toBeNull()
	})

	it('handles missing data field gracefully', () => {
		const payload = {
			action: 'create',
			type: 'Issue',
			organizationId: 'org-123',
		}
		const result = linearEventNormalizer(payload, {})

		expect(result).not.toBeNull()
		expect(result?.data).toEqual({
			organizationId: 'org-123',
			webhookType: 'Issue',
		})
	})
})
