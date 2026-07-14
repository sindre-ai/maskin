import { describe, expect, it } from 'vitest'
import {
	TOKEN_STALE_THRESHOLD_MS,
	getTokenAgeMs,
	getTokenAgeSeconds,
	isTokenPossiblyStale,
	stampTokenMetadata,
} from '../../../../lib/integrations/providers/github/token-metadata'

describe('token-metadata', () => {
	describe('stampTokenMetadata', () => {
		it('stamps the token, installation id, and current time', () => {
			const before = Date.now()
			const meta = stampTokenMetadata('ghs_abc', '12345')
			const after = Date.now()
			expect(meta.token).toBe('ghs_abc')
			expect(meta.installationId).toBe('12345')
			expect(meta.mintedAt.getTime()).toBeGreaterThanOrEqual(before)
			expect(meta.mintedAt.getTime()).toBeLessThanOrEqual(after)
		})
	})

	describe('getTokenAgeMs / getTokenAgeSeconds', () => {
		it('reports elapsed ms and seconds since mint', () => {
			const meta = {
				token: 't',
				installationId: 'i',
				mintedAt: new Date('2026-07-13T00:00:00.000Z'),
			}
			const now = new Date('2026-07-13T00:10:00.000Z')
			expect(getTokenAgeMs(meta, now)).toBe(10 * 60 * 1000)
			expect(getTokenAgeSeconds(meta, now)).toBe(600)
		})
	})

	describe('isTokenPossiblyStale', () => {
		it('returns false under the 50-minute threshold', () => {
			const meta = {
				token: 't',
				installationId: 'i',
				mintedAt: new Date('2026-07-13T00:00:00.000Z'),
			}
			const now = new Date(meta.mintedAt.getTime() + TOKEN_STALE_THRESHOLD_MS - 1000)
			expect(isTokenPossiblyStale(meta, now)).toBe(false)
		})

		it('returns true past the 50-minute threshold', () => {
			const meta = {
				token: 't',
				installationId: 'i',
				mintedAt: new Date('2026-07-13T00:00:00.000Z'),
			}
			const now = new Date(meta.mintedAt.getTime() + TOKEN_STALE_THRESHOLD_MS + 1000)
			expect(isTokenPossiblyStale(meta, now)).toBe(true)
		})
	})
})
