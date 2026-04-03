import { getCredentialsCommand, parseClaudeCredentials } from '@/lib/claude-oauth'
import { describe, expect, it, vi } from 'vitest'

describe('parseClaudeCredentials', () => {
	it('returns null for invalid JSON', () => {
		expect(parseClaudeCredentials('not-json')).toBeNull()
	})

	it('returns null when claudeAiOauth key is missing', () => {
		expect(parseClaudeCredentials(JSON.stringify({ other: 'data' }))).toBeNull()
	})

	it('returns null when accessToken is missing', () => {
		const data = { claudeAiOauth: { refreshToken: 'rt_123' } }
		expect(parseClaudeCredentials(JSON.stringify(data))).toBeNull()
	})

	it('returns null when refreshToken is missing', () => {
		const data = { claudeAiOauth: { accessToken: 'at_123' } }
		expect(parseClaudeCredentials(JSON.stringify(data))).toBeNull()
	})

	it('returns correct ParsedClaudeCredentials for valid input', () => {
		const data = {
			claudeAiOauth: {
				accessToken: 'at_abc',
				refreshToken: 'rt_xyz',
				expiresAt: 1234567890,
			},
		}
		expect(parseClaudeCredentials(JSON.stringify(data))).toEqual({
			accessToken: 'at_abc',
			refreshToken: 'rt_xyz',
			expiresAt: 1234567890,
			subscriptionType: undefined,
			scopes: undefined,
		})
	})

	it('defaults expiresAt to 0 when missing', () => {
		const data = {
			claudeAiOauth: {
				accessToken: 'at_abc',
				refreshToken: 'rt_xyz',
			},
		}
		const result = parseClaudeCredentials(JSON.stringify(data))
		expect(result?.expiresAt).toBe(0)
	})

	it('includes optional subscriptionType and scopes when present', () => {
		const data = {
			claudeAiOauth: {
				accessToken: 'at_abc',
				refreshToken: 'rt_xyz',
				expiresAt: 999,
				subscriptionType: 'pro',
				scopes: ['read', 'write'],
			},
		}
		const result = parseClaudeCredentials(JSON.stringify(data))
		expect(result?.subscriptionType).toBe('pro')
		expect(result?.scopes).toEqual(['read', 'write'])
	})
})

describe('getCredentialsCommand', () => {
	it('returns Windows command when navigator.userAgent contains Win', () => {
		vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
		expect(getCredentialsCommand()).toBe('type %USERPROFILE%\\.claude\\.credentials.json')
		vi.unstubAllGlobals()
	})

	it('returns Unix command for non-Windows user agent', () => {
		vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' })
		expect(getCredentialsCommand()).toBe('cat $HOME/.claude/.credentials.json')
		vi.unstubAllGlobals()
	})
})
