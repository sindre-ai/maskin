import { describe, expect, it } from 'vitest'
import { isGrantRefreshable } from '../../lib/oauth-server/grants'

const NOW = new Date('2026-10-14T12:00:00Z')
const DAY_MS = 86_400_000

function refreshToken(
	overrides: Partial<{ revokedAt: Date | null; usedAt: Date | null; expiresAt: Date }> = {},
) {
	return {
		revokedAt: null,
		usedAt: null,
		expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
		...overrides,
	}
}

function refreshable(
	overrides: Partial<{
		grantRevokedAt: Date | null
		refreshToken: ReturnType<typeof refreshToken> | null | undefined
		isMember: boolean
	}> = {},
) {
	return isGrantRefreshable(
		{ grantRevokedAt: null, refreshToken: refreshToken(), isMember: true, ...overrides },
		NOW,
	)
}

describe('isGrantRefreshable', () => {
	it('is true for a live grant with an unused refresh token and a member', () => {
		expect(refreshable()).toBe(true)
	})

	it('is false once the grant is revoked', () => {
		expect(refreshable({ grantRevokedAt: new Date(NOW.getTime() - 1000) })).toBe(false)
	})

	it('is false when the person is no longer a member', () => {
		expect(refreshable({ isMember: false })).toBe(false)
	})

	it('is false when there is no refresh token', () => {
		expect(refreshable({ refreshToken: null })).toBe(false)
		expect(refreshable({ refreshToken: undefined })).toBe(false)
	})

	it('is false when the refresh token is revoked, used or expired', () => {
		expect(refreshable({ refreshToken: refreshToken({ revokedAt: NOW }) })).toBe(false)
		expect(refreshable({ refreshToken: refreshToken({ usedAt: NOW }) })).toBe(false)
		expect(
			refreshable({ refreshToken: refreshToken({ expiresAt: new Date(NOW.getTime() - 1) }) }),
		).toBe(false)
	})

	it('treats a connection idle past 30 days as ended (its refresh token has expired)', () => {
		const issued = new Date(NOW.getTime() - 31 * DAY_MS)
		const idle = refreshToken({ expiresAt: new Date(issued.getTime() + 30 * DAY_MS) })

		expect(refreshable({ refreshToken: idle })).toBe(false)
	})
})
