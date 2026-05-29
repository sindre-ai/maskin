import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentObjectUrl, fileViewerUrl, frontendBaseUrl } from '../../lib/file-urls'

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
		// produce double slashes. fileViewerUrl and agentObjectUrl rely on this.
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

describe('agentObjectUrl', () => {
	// This is the helper that fixes the reporter's bug — agents must emit
	// `https://maskin.sindre.ai/<workspace_id>/objects/<id>`, not
	// `https://app.maskin.ai/objects/<id>`. Pinning the host + workspace
	// segment here is the DoD acceptance test for the bet.

	it('emits the correct host plus workspace-scoped object path', () => {
		expect(
			agentObjectUrl(
				'https://maskin.sindre.ai',
				'fe944fe6-7b45-478c-afc7-b889cea63c08',
				'91000a03-ca49-4b8c-87f2-1faaf7909266',
			),
		).toBe(
			'https://maskin.sindre.ai/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/91000a03-ca49-4b8c-87f2-1faaf7909266',
		)
	})

	it('never produces the legacy `app.maskin.ai/objects/<id>` shape', () => {
		const url = agentObjectUrl('https://maskin.sindre.ai', 'ws-1', 'obj-1')
		expect(url).not.toContain('app.maskin.ai')
		expect(url).toMatch(/\/ws-1\/objects\/obj-1$/)
	})

	it('tolerates a trailing slash on the frontend URL', () => {
		expect(agentObjectUrl('https://maskin.sindre.ai/', 'ws-1', 'obj-1')).toBe(
			'https://maskin.sindre.ai/ws-1/objects/obj-1',
		)
	})

	it('preserves the dev-loop localhost host for non-prod sessions', () => {
		expect(agentObjectUrl('http://localhost:5173', 'ws-dev', 'obj-dev')).toBe(
			'http://localhost:5173/ws-dev/objects/obj-dev',
		)
	})
})
