import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileViewerUrl, frontendBaseUrl } from '../../lib/file-urls'

describe('frontendBaseUrl', () => {
	beforeEach(() => {
		vi.stubEnv('NODE_ENV', 'development')
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('returns the dev fallback when FRONTEND_URL is unset outside production', () => {
		vi.stubEnv('FRONTEND_URL', '')
		expect(frontendBaseUrl()).toBe('http://localhost:5173')
	})

	it('returns FRONTEND_URL verbatim when set', () => {
		vi.stubEnv('FRONTEND_URL', 'https://maskin.sindre.ai')
		expect(frontendBaseUrl()).toBe('https://maskin.sindre.ai')
	})

	it('strips a trailing slash from FRONTEND_URL', () => {
		// Without normalisation, downstream `${frontendUrl}/<ws>/...` joins
		// produce double slashes. fileViewerUrl relies on this.
		vi.stubEnv('FRONTEND_URL', 'https://maskin.sindre.ai/')
		expect(frontendBaseUrl()).toBe('https://maskin.sindre.ai')
	})

	it('throws in production when FRONTEND_URL is unset', () => {
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('FRONTEND_URL', '')
		expect(() => frontendBaseUrl()).toThrow(/FRONTEND_URL must be set in production/)
	})
})

describe('fileViewerUrl', () => {
	it('builds a workspace-scoped file viewer URL', () => {
		expect(fileViewerUrl('https://maskin.sindre.ai', 'ws-1', 'file-9')).toBe(
			'https://maskin.sindre.ai/ws-1/files/file-9',
		)
	})

	it('tolerates a trailing slash on the frontend URL', () => {
		expect(fileViewerUrl('https://maskin.sindre.ai/', 'ws-1', 'file-9')).toBe(
			'https://maskin.sindre.ai/ws-1/files/file-9',
		)
	})
})
