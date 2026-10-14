import type { Database } from '@maskin/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMcpOAuthEnabled, isOAuthTokenPrefix, resolveMcpCredential } from '../mcp-credential'

const db = {} as Database

const oauthContext = (overrides: Record<string, unknown> = {}) => ({
	actorId: 'actor-1',
	type: 'human',
	workspaceId: 'ws-1',
	grantId: 'grant-1',
	clientId: 'https://claude.ai/client',
	scope: 'mcp',
	resource: 'https://maskin.io/mcp',
	expiresAt: new Date(Date.now() + 60_000),
	...overrides,
})

afterEach(() => vi.unstubAllEnvs())

describe('isMcpOAuthEnabled', () => {
	it('is off when the switch is unset or anything but true/1', () => {
		expect(isMcpOAuthEnabled(undefined)).toBe(false)
		expect(isMcpOAuthEnabled('')).toBe(false)
		expect(isMcpOAuthEnabled('false')).toBe(false)
		expect(isMcpOAuthEnabled('yes')).toBe(false)
	})

	it('is on for true or 1', () => {
		expect(isMcpOAuthEnabled('true')).toBe(true)
		expect(isMcpOAuthEnabled(' TRUE ')).toBe(true)
		expect(isMcpOAuthEnabled('1')).toBe(true)
	})
})

describe('isOAuthTokenPrefix', () => {
	it('matches mat_ and mrt_ only', () => {
		expect(isOAuthTokenPrefix('mat_abc')).toBe(true)
		expect(isOAuthTokenPrefix('mrt_abc')).toBe(true)
		expect(isOAuthTokenPrefix('ank_abc')).toBe(false)
	})
})

describe('resolveMcpCredential', () => {
	it('resolves an ank_ key to the actor behind it', async () => {
		const apiKey = vi.fn().mockResolvedValue({ actorId: 'actor-1', type: 'agent' })
		expect(await resolveMcpCredential(db, 'ank_x', { apiKey })).toEqual({
			kind: 'api_key',
			actorId: 'actor-1',
			actorType: 'agent',
		})
	})

	it('returns null for an unknown ank_ key', async () => {
		expect(await resolveMcpCredential(db, 'ank_x', { apiKey: async () => null })).toBeNull()
	})

	it('resolves a mat_ token to the person and the grant workspace when the switch is on', async () => {
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
		const oauth = vi.fn().mockResolvedValue(oauthContext())
		expect(await resolveMcpCredential(db, 'mat_x', { oauth })).toMatchObject({
			kind: 'oauth',
			actorId: 'actor-1',
			workspaceId: 'ws-1',
			grantId: 'grant-1',
			clientId: 'https://claude.ai/client',
		})
	})

	it('does not look a mat_ token up when the switch is off', async () => {
		const oauth = vi.fn()
		expect(await resolveMcpCredential(db, 'mat_x', { oauth })).toBeNull()
		expect(oauth).not.toHaveBeenCalled()
	})

	it('re-checks expiry so a cached entry past its time does not resolve', async () => {
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
		const oauth = async () => oauthContext({ expiresAt: new Date(Date.now() - 1) })
		expect(await resolveMcpCredential(db, 'mat_x', { oauth })).toBeNull()
	})

	it('never resolves a refresh token, or anything else', async () => {
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
		const oauth = vi.fn()
		const apiKey = vi.fn()
		expect(await resolveMcpCredential(db, 'mrt_x', { oauth, apiKey })).toBeNull()
		expect(await resolveMcpCredential(db, 'something-else', { oauth, apiKey })).toBeNull()
		expect(oauth).not.toHaveBeenCalled()
		expect(apiKey).not.toHaveBeenCalled()
	})
})
