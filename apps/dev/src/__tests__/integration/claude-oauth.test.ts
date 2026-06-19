import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { getValidOAuthToken } = await import('../../lib/claude-oauth')
const { default: claudeOAuthRoutes } = await import('../../routes/claude-oauth')

function createApp() {
	return createIntegrationApp({ path: '/api/claude-oauth', module: claudeOAuthRoutes })
}

function expiredOAuth() {
	return {
		encryptedAccessToken: encrypt('old-access'),
		encryptedRefreshToken: encrypt('old-refresh'),
		expiresAt: Date.now() - 1000,
		scopes: ['read'],
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('Claude OAuth — concurrent settings safety', () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
	})

	it('refresh persists new token without clobbering sibling settings (max_concurrent_sessions)', async () => {
		// Token refresh used to read-modify-write the entire settings JSONB across
		// a network call, clobbering any concurrent update like a
		// `max_concurrent_sessions` bump. Verify the targeted JSONB update only
		// touches `claude_oauth`.
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: { max_concurrent_sessions: 5, claude_oauth: expiredOAuth() },
		})

		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ access_token: 'new-access', expires_in: 3600 }),
			}),
		)

		const result = await getValidOAuthToken(db, ws.id)
		expect(result?.accessToken).toBe('new-access')

		const [reloaded] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = reloaded.settings as Record<string, unknown>
		expect(settings.max_concurrent_sessions).toBe(5)
		expect(settings.claude_oauth).toBeDefined()
	})

	it('POST /api/claude-oauth/import sets claude_oauth without clobbering siblings', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: { max_concurrent_sessions: 7 },
		})
		const app = createApp()

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/claude-oauth/import',
				{
					accessToken: 'imp-access',
					refreshToken: 'imp-refresh',
					expiresAt: Date.now() + 60_000,
					subscriptionType: 'max',
					scopes: ['user:inference'],
				},
				{ 'X-Workspace-Id': ws.id },
			),
		)
		expect(res.status).toBe(200)

		const [reloaded] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = reloaded.settings as Record<string, unknown>
		expect(settings.max_concurrent_sessions).toBe(7)
		expect((settings.claude_oauth as { subscriptionType: string }).subscriptionType).toBe('max')
	})

	it('DELETE /api/claude-oauth removes only claude_oauth and preserves siblings', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				max_concurrent_sessions: 9,
				claude_oauth: expiredOAuth(),
				llm_keys: { anthropic: 'sk-ant-keep' },
			},
		})
		const app = createApp()

		const res = await app.request(
			jsonRequest('DELETE', '/api/claude-oauth', undefined, { 'X-Workspace-Id': ws.id }),
		)
		expect(res.status).toBe(200)

		const [reloaded] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = reloaded.settings as Record<string, unknown>
		expect(settings.claude_oauth).toBeUndefined()
		expect(settings.max_concurrent_sessions).toBe(9)
		expect(settings.llm_keys).toEqual({ anthropic: 'sk-ant-keep' })
	})
})
